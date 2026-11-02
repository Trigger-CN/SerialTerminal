'use strict';
/**
 * main.js 模块加载门禁。
 *
 * 背景：`node --check` 只做语法解析、不执行代码，因此发现不了
 * 「const 在声明之前被模块顶层立即求值引用」这类 TDZ 错误。
 * 真实事故：`let activeMainLogGroupId = DEFAULT_SERIAL_GROUP_ID;` 出现在
 * `const DEFAULT_SERIAL_GROUP_ID = 'default';` 之前，导致 Electron 启动即崩溃：
 *   ReferenceError: Cannot access 'DEFAULT_SERIAL_GROUP_ID' before initialization
 *
 * 本测试在受控环境中执行 main.js 的完整模块体，只 stub 外部依赖，
 * 使这类模块级初始化错误在测试阶段就被捕获，而不是等到用户启动应用。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const mainPath = path.join(__dirname, '..', 'main.js');
const projectRoot = path.dirname(mainPath);
const source = fs.readFileSync(mainPath, 'utf8');

// 宽松 Proxy：缺失的任意属性/方法都返回可调用的 stub，避免 stub 不完整造成假失败。
function makeStub(name) {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      return makeStub(`${name}.${String(prop)}`);
    },
    apply() {
      return makeStub(`${name}()`);
    },
    construct() {
      return makeStub(`new ${name}`);
    }
  });
}

function loadMainModule() {
  const originalLoad = Module._load;

  Module._load = function (request) {
    if (request === 'electron') {
      const appBase = {
        getPath: () => path.join(require('node:os').tmpdir(), 'serialterminal-load-test'),
        getVersion: () => '0.0.0',
        // 永不 resolve：阻止真的进入初始化流程，只验证模块顶层求值。
        whenReady: () => new Promise(() => {}),
        requestSingleInstanceLock: () => true,
        getName: () => 'SerialTerminal',
        isPackaged: false
      };
      const app = new Proxy(appBase, {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (typeof prop === 'symbol') return undefined;
          return () => undefined;
        }
      });
      return {
        app,
        BrowserWindow: makeStub('BrowserWindow'),
        ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
        dialog: makeStub('dialog'),
        shell: makeStub('shell'),
        Menu: makeStub('Menu'),
        Tray: makeStub('Tray'),
        nativeImage: makeStub('nativeImage'),
        nativeTheme: makeStub('nativeTheme'),
        screen: makeStub('screen'),
        powerMonitor: makeStub('powerMonitor'),
        crashReporter: { start: () => {}, getLastCrashReport: () => null },
        clipboard: makeStub('clipboard'),
        autoUpdater: makeStub('autoUpdater'),
        Notification: makeStub('Notification')
      };
    }
    if (request === 'electron-log') {
      const logger = makeStub('log');
      logger.transports = { file: { getFile: () => ({ path: '' }) } };
      return logger;
    }
    if (request === 'serialport') {
      class SerialPort {
        constructor() { this.isOpen = false; }
        open(cb) { if (cb) cb(new Error('stub')); }
        close(cb) { if (cb) cb(); }
        write(_data, cb) { if (cb) cb(); }
        on() { return this; }
        static list() { return Promise.resolve([]); }
      }
      return { SerialPort };
    }
    if (request.startsWith('@serialport/')) return makeStub(request);
    return originalLoad.apply(this, arguments);
  };

  try {
    const module = { exports: {} };
    const wrapper = vm.runInThisContext(
      `(function (exports, require, module, __filename, __dirname) {${source}\n})`,
      { filename: mainPath }
    );
    wrapper(module.exports, Module.createRequire(mainPath), module, mainPath, projectRoot);
    return { error: null };
  } catch (error) {
    return { error };
  } finally {
    Module._load = originalLoad;
  }
}

test('main.js module body initializes without throwing', () => {
  const { error } = loadMainModule();
  assert.equal(
    error,
    null,
    error
      ? `main.js failed at module init: ${error.constructor.name}: ${error.message}\n` +
        String(error.stack || '').split('\n').slice(0, 4).join('\n')
      : ''
  );
});

test('serial log routing constants resolve before first top-level use', () => {
  // 上一个测试真正执行了模块体，已能捕获 TDZ。这里再做一层意图明确的检查：
  // 顶层立即求值的日志路由变量必须声明在常量之后。
  // 注意：不能用 indexOf 找首次出现，因为注释里也会出现同名文本；
  // 按行匹配真实语句，避免被注释干扰。
  const lines = source.split('\n');
  const declarationLine = lines.findIndex(line => line.startsWith("const DEFAULT_SERIAL_GROUP_ID = '"));
  const firstUseLine = lines.findIndex(line =>
    /^(let|var|const)\s+\w+\s*=\s*DEFAULT_SERIAL_GROUP_ID\b/.test(line)
  );

  assert.ok(declarationLine >= 0, 'DEFAULT_SERIAL_GROUP_ID 必须以顶层 const 声明');
  assert.ok(firstUseLine >= 0, '应存在引用该常量的顶层赋值');
  assert.ok(
    declarationLine < firstUseLine,
    `常量声明（行 ${declarationLine + 1}）必须早于首个顶层使用（行 ${firstUseLine + 1}）`
  );
});

test('TDZ usage-before-declaration is actually detected by the harness', () => {
  // 反向对照：证明本测试使用的加载方式确实能捕获这类错误，
  // 避免门禁形同虚设（例如 vm 配置不当导致永远不报错）。
  const badSource = `
let activeMainLogGroupId = DEFAULT_SERIAL_GROUP_ID;
const DEFAULT_SERIAL_GROUP_ID = 'default';
`;
  let caught = null;
  try {
    vm.runInThisContext(`(function () {${badSource}\n})`)();
  } catch (error) {
    caught = error;
  }

  assert.notEqual(caught, null, 'TDZ 错误必须被捕获到');
  assert.equal(caught.constructor.name, 'ReferenceError');
  assert.match(caught.message, /Cannot access 'DEFAULT_SERIAL_GROUP_ID' before initialization/);
});
