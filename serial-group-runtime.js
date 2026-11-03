'use strict';

// 渲染层串口终端运行时注册表（P2 剩余部分的基础设施）。
//
// 为什么需要这一层：`renderer.js` 里 `serialTerm` / `dataParser` / `hexFormatter` 都是
// 模块顶层单例，且在模块加载期就 `open(document.getElementById('serial-container'))`。
// 这让「一个分组一个终端」无法成立——容器只有一个，实例也只有一个。要支持多分组，
// 必须先变成「按 groupId 申请实例」。
//
// 但 Terminal / parser / formatter 在构造时就绑定 DOM 容器与回调，没法在 Node 里
// 直接断言。所以这一层只做**实例的生命周期管理**：谁持有、什么时候建、什么时候释放，
// 真正的构造通过注入的 `createRuntime(groupId)` 完成。这样：
//   1. 生命周期规则（惰性创建、默认分组不可释放、释放要 dispose）可以在 Node 里测透；
//   2. 构造细节仍留在 renderer.js，不把 DOM 耦合搬进这个模块。
//
// 三条硬性约束：
//   1. **必须惰性创建**。xterm 的 `open()` 需要真实 DOM 节点，分组标签还没渲染出来时
//      就构造终端会失败。所以构造函数里绝不允许预先创建任何实例。
//   2. **默认分组不可释放**。它是应用启动就存在的分组，释放后没有任何路径能恢复它，
//      用户会看到一个空白终端区。
//   3. **释放必须调用 dispose**。xterm 实例持有 canvas/textarea 与滚动缓冲；只从 Map
//      里删掉引用而不断开，这些资源会一直挂在 DOM 上，切换几十次分组后内存与事件监听
//      都会累积（这类泄漏在任务管理器里看不出来，只在长时间使用后表现为越来越卡）。

const { normalizeGroupId, DEFAULT_SERIAL_GROUP_ID } = require('./serial-group-registry');

// 运行时对象的最小形状。只用于诊断提示，不做强制校验——
// 真正的强约束是「构造失败时不能留下半成品」。
function describeRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') return 'invalid';
  const parts = [];
  if (runtime.term) parts.push('term');
  if (runtime.dataParser) parts.push('dataParser');
  if (runtime.hexFormatter) parts.push('hexFormatter');
  return parts.length > 0 ? parts.join('+') : 'empty';
}

class SerialTerminalRuntimeRegistry {
  constructor({ defaultGroupId = DEFAULT_SERIAL_GROUP_ID, createRuntime } = {}) {
    if (typeof createRuntime !== 'function') {
      throw new TypeError('SerialTerminalRuntimeRegistry requires a createRuntime(groupId) function');
    }
    this.defaultGroupId = normalizeGroupId(defaultGroupId);
    this.createRuntime = createRuntime;
    // groupId -> runtime。构造阶段保持为空：见「必须惰性创建」。
    this.runtimes = new Map();
  }

  has(groupId) {
    return this.runtimes.has(normalizeGroupId(groupId));
  }

  // 只读查找，不存在返回 null。
  //
  // 特意不做「自动创建」：调用方若在渲染该分组之前就取终端，拿到 null 会立刻报错，
  // 比悄悄建一个还没 open 过的终端更容易定位问题。
  get(groupId) {
    return this.runtimes.get(normalizeGroupId(groupId)) || null;
  }

  // 登记一个**已经存在**的实例（不经过 createRuntime）。
  //
  // 用途：改造初期，默认分组的终端在渲染层模块加载时就已经建好并 open 过了。
  // 此时再让注册表去构造一个，会得到两个绑在同一容器的 xterm 实例（互相抢输入、
  // 画面覆盖），比不接入更糟。所以必须先能把已有实例挂进注册表。
  //
  // 已存在同名分组时拒绝覆盖并返回 false：静默替换会让先前持有旧引用的调用方
  // 继续操作一个已被遗弃的实例，这种错误极难发现。
  attach(groupId, runtime) {
    const id = normalizeGroupId(groupId);
    if (this.runtimes.has(id)) return false;
    if (!runtime || typeof runtime !== 'object') {
      throw new TypeError(`attach(${id}) got ${describeRuntime(runtime)}`);
    }
    this.runtimes.set(id, runtime);
    return true;
  }

  // 取或创建。构造失败时**不缓存任何东西**，否则下一次拿到的是半成品。
  getOrCreate(groupId) {
    const id = normalizeGroupId(groupId);
    const existing = this.runtimes.get(id);
    if (existing) return existing;

    const runtime = this.createRuntime(id);
    if (!runtime || typeof runtime !== 'object') {
      throw new TypeError(`createRuntime(${id}) returned ${describeRuntime(runtime)}`);
    }
    this.runtimes.set(id, runtime);
    return runtime;
  }

  // 释放一个分组。默认分组拒绝释放并返回 false。
  //
  // dispose 抛错时仍要把引用从 Map 里删掉：留着它只会让后续每次访问都拿到一个
  // 已损坏的对象，比丢失更难排查。
  release(groupId) {
    const id = normalizeGroupId(groupId);
    if (id === this.defaultGroupId) return false;
    const runtime = this.runtimes.get(id);
    if (!runtime) return false;

    this.runtimes.delete(id);
    if (typeof runtime.dispose === 'function') {
      try {
        runtime.dispose();
      } catch (error) {
        // 用 console 而不是抛出：释放是清理路径，不能因为清理失败就中断调用方
        // 正在做的关闭分组流程。
        console.error(`Failed to dispose serial runtime for group ${id}:`, error);
      }
    }
    return true;
  }

  // 释放除默认分组外的全部实例。用于「关掉所有额外分组」这类批量收尾。
  releaseAllExceptDefault() {
    const released = [];
    Array.from(this.runtimes.keys()).forEach(id => {
      if (id === this.defaultGroupId) return;
      if (this.release(id)) released.push(id);
    });
    return released;
  }

  listGroupIds() {
    return Array.from(this.runtimes.keys());
  }

  get size() {
    return this.runtimes.size;
  }

  // 报告一致性自检：默认分组必须已登记。
  //
  // 这是启动后第一件该校验的事——默认分组未登记意味着界面上的主终端不在注册表
  // 里，后续任何按 groupId 取终端的代码都会拿到 null。宁可在启动时明确报错，
  // 也不要等到用户接上串口看到空白画面才发现。
  assertDefaultAttached() {
    if (this.runtimes.has(this.defaultGroupId)) return true;
    throw new Error(`Serial runtime registry is missing the default group: ${this.defaultGroupId}`);
  }
}

module.exports = { SerialTerminalRuntimeRegistry, describeRuntime };
