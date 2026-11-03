'use strict';

// 渲染层串口分组上下文（P2）。
//
// 这里只放**与 DOM / xterm 无关的可变状态**：行号计数、上一条是否以换行结束、
// 收发显示参数等。它们都是普通标量，因此可以在 Node 里直接构造和断言，
// 不必启动 Electron 或创建终端。
//
// 为什么不把 Terminal / parser / formatter 也放进来：那些对象在构造时就绑定 DOM
// 容器与回调，贸然下沉会让这个模块失去可测试性，也把分组边界和渲染实现耦死。
// 分阶段做法是：先在上下文里接管纯状态，让消费侧按 groupId 取用；等状态都收敛了，
// 再让持有 DOM 的对象按同一个 groupId 去申请自己的实例。

const { normalizeGroupId, DEFAULT_SERIAL_GROUP_ID } = require('./serial-group-registry');

function createDefaultState() {
  return {
    // 显示层行号：serialLineCounter 用于主终端行前缀，logLineCounter 用于写入文件的行号。
    // 两者必须是独立的计数器——日志文件与屏幕上的行号本来就可能不同步。
    serialLineCounter: 1,
    logLineCounter: 1,
    // 上一条输出是否已经以换行结束；决定下一次前缀要不要先补一个换行。
    serialNewLine: true,
    // 收发显示参数：目前所有分组共用同一份配置来源，但状态本身必须分组隔离，
    // 否则切换分组回显时会拿到另一组的值。
    receiveDisplayMode: 'text',
    receiveEncoding: 'utf8',
    sendEncoding: 'utf8',
    newlineMode: 'crlf'
  };
}

class SerialGroupContextStore {
  constructor({ defaultGroupId = DEFAULT_SERIAL_GROUP_ID } = {}) {
    this.defaultGroupId = normalizeGroupId(defaultGroupId);
    this.states = new Map();
    this.ensureContext(this.defaultGroupId);
  }

  ensureContext(groupId) {
    const id = normalizeGroupId(groupId);
    let state = this.states.get(id);
    if (!state) {
      state = createDefaultState();
      this.states.set(id, state);
    }
    return state;
  }

  // 读取时总是返回真实对象而非副本：消费侧是高频读写的行号计数器，
  // 每行都复制一次的开销没有必要。调用方不得缓存返回值跨越分组切换。
  get(groupId) {
    return this.ensureContext(groupId);
  }

  // 重置行号：连接/断开时调用。只影响指定分组。
  resetLineCounters(groupId) {
    const state = this.ensureContext(groupId);
    state.serialLineCounter = 1;
    state.logLineCounter = 1;
    state.serialNewLine = true;
    return state;
  }

  // 取下一组行号并自增。screen 与 log 分开推进，语义与改造前的两个独立计数器一致。
  nextLineNumbers(groupId, { advanceScreen = true, advanceLog = true } = {}) {
    const state = this.ensureContext(groupId);
    const result = {
      screen: state.serialLineCounter,
      log: state.logLineCounter
    };
    if (advanceScreen) state.serialLineCounter += 1;
    if (advanceLog) state.logLineCounter += 1;
    return result;
  }

  setDisplay(groupId, patch = {}) {
    const state = this.ensureContext(groupId);
    if (typeof patch.receiveDisplayMode === 'string') state.receiveDisplayMode = patch.receiveDisplayMode;
    if (typeof patch.receiveEncoding === 'string') state.receiveEncoding = patch.receiveEncoding;
    if (typeof patch.sendEncoding === 'string') state.sendEncoding = patch.sendEncoding;
    if (typeof patch.newlineMode === 'string') state.newlineMode = patch.newlineMode;
    return state;
  }

  removeContext(groupId) {
    const id = normalizeGroupId(groupId);
    if (id === this.defaultGroupId) return false;
    return this.states.delete(id);
  }

  listGroupIds() {
    return Array.from(this.states.keys());
  }
}

module.exports = { SerialGroupContextStore, createDefaultState };
