'use strict';
/**
 * renderer.js 模块加载门禁。
 *
 * 背景与 `test/main-module-load.test.js` 相同，但对象换成渲染层：
 * `node --check` 只做语法解析、**不执行代码**，因此看不见
 * 「const/let 在被模块顶层立即求值引用之前就使用」这类 TDZ 错误。
 *
 * 为什么本次改造后这个门禁变得必要：主串口终端的创建从「模块顶层的字面量
 * `new Terminal({...})`」变成了「`serialRuntimes.getOrCreate()` → 注入的
 * `createSerialRuntime()`」。也就是说模块顶层现在会**立即执行**一个函数，
 * 而这个函数内部又调用 `enableTerminalUnicode11()`、`getPrefix()`、
 * `document.getElementById()` 等一批同样在顶层的绑定。只要其中任意一个的
 * 声明被移到构造点下方，应用就会在启动瞬间白屏，而所有源码文本断言仍然全绿。
 *
 * **实际加载由 `scripts/check-renderer-module-load.js` 在独立子进程里完成**，
 * 本文件只负责调用它并断言退出码。这个拆分有两个理由：
 *   1. renderer 顶层会排入异步回调（首帧 fit、图表初始化），它们依赖真实布局，
 *      stub 不可能完整支撑；在 node:test 进程内执行会让这些拒绝把整个文件判红，
 *      而那种红是测试夹具的缺陷，不是产品的缺陷。
 *   2. 子进程可以在完成同步求值后立即 `process.exit()`，把判定严格限定在
 *      「顶层同步求值是否抛错」这一件事上。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const checkScript = path.join(root, 'scripts', 'check-renderer-module-load.js');
const rendererPath = path.join(root, 'renderer.js');
const source = fs.readFileSync(rendererPath, 'utf8');

test('renderer.js module body initializes without throwing', () => {
  const result = spawnSync(process.execPath, [checkScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000
  });

  assert.equal(
    result.status,
    0,
    `renderer.js 模块顶层求值失败（退出码 ${result.status}）：\n` +
    `${result.stderr || ''}${result.stdout || ''}`
  );
  assert.match(result.stdout, /module body initialized without throwing/);
});

test('the renderer load gate actually fails on a TDZ error', () => {
  // 反向对照：证明门禁不是恒真。
  //
  // 做法是在子进程里执行一段**故意写错顺序**的模块体，断言退出码为 1。
  // 若这里不失败，说明门禁的判定逻辑本身有问题，那第一个用例的「通过」也就没有意义。
  const badScript = path.join(require('node:os').tmpdir(), `renderer-tdz-probe-${process.pid}.js`);
  fs.writeFileSync(badScript, [
    "'use strict';",
    'const serialRuntimes = { getOrCreate: () => createSerialRuntime() };',
    'const runtime = serialRuntimes.getOrCreate();',
    'const createSerialRuntime = () => null;',
    'void runtime;',
    ''
  ].join('\n'));

  try {
    const result = spawnSync(process.execPath, [badScript], { encoding: 'utf8', timeout: 30000 });
    assert.notEqual(result.status, 0, 'TDZ 错误必须导致非零退出码');
    assert.match(result.stderr, /Cannot access 'createSerialRuntime' before initialization/);
  } finally {
    try { fs.unlinkSync(badScript); } catch { /* 清理失败不影响断言结论 */ }
  }
});

test('createSerialRuntime is defined before the default runtime is created', () => {
  // 意图明确的静态检查：工厂必须先于「模块顶层立即调用它」的那一行。
  // 上一轮新增终端工厂时，这正是最容易写错、且只有真的执行才会暴露的顺序。
  const lines = source.split('\n');
  const factoryLine = lines.findIndex(line => /^function createSerialRuntime\s*\(/.test(line));
  const createLine = lines.findIndex(line => /serialRuntimes\.getOrCreate\(/.test(line));
  assert.ok(factoryLine >= 0, 'createSerialRuntime 必须以顶层函数声明定义');
  assert.ok(createLine >= 0, '默认分组必须在模块顶层创建');
  assert.ok(
    factoryLine < createLine,
    `工厂定义（行 ${factoryLine + 1}）必须早于默认实例创建（行 ${createLine + 1}）`
  );
});

test('the default runtime is created through the registry, not by a bare new Terminal', () => {
  // 这一条守护的是「死代码」问题：上一轮曾经写过一个永不执行的 createSerialRuntime。
  // 现在默认分组必须真的经由注册表构造，且 serialTerm 必须取自该运行时，
  // 否则工厂又会退化成只有测试引用的死代码。
  const lines = source.split('\n');
  const getOrCreateLine = lines.findIndex(line => /serialRuntimes\.getOrCreate\(/.test(line));
  const serialTermLine = lines.findIndex(line => /^const serialTerm = /.test(line));
  assert.ok(getOrCreateLine >= 0, '必须经由 serialRuntimes.getOrCreate 创建默认运行时');
  assert.ok(serialTermLine >= 0, 'serialTerm 必须以顶层 const 绑定');
  assert.ok(
    getOrCreateLine < serialTermLine,
    `默认运行时构造（行 ${getOrCreateLine + 1}）必须早于 serialTerm 绑定（行 ${serialTermLine + 1}）`
  );
  // serialTerm 必须取自运行时，而不是自己再 new 一个：
  // 若是后者，注册表里那个实例就永远不会被真正使用，工厂退化成死代码。
  assert.match(lines[serialTermLine], /const serialTerm = \w+\.term;/);
});
