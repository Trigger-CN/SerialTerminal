'use strict';
/**
 * renderer.js 模块加载门禁（独立脚本，由 `test/renderer-module-load.test.js` 调用）。
 *
 * 为什么不直接写成 node:test 用例：renderer.js 在模块顶层会排入一批异步回调
 * （首帧 fit、图表初始化等）。它们在加载返回之后才执行，而 stub 的 DOM
 * 不可能完整支撑真实绘制，于是会抛出与「模块初始化是否正确」无关的
 * TypeError。node:test 会把任何未处理拒绝判为整个文件失败，导致门禁永远
 * 报红——那种红是测试夹具的缺陷，不是产品的缺陷。
 *
 * 所以这里只做一件事，并且只对**同步顶层求值**负责：
 *   1. 执行 renderer.js 的完整模块体；
 *   2. 顶层同步求值抛错 → 退出码 1，并打印错误；
 *   3. 求值成功 → 退出码 0，随即主动退出（不等异步回调）。
 *
 * 这正是 `node --check` 看不见、而一旦发生就会让应用启动即白屏的那一类问题。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const rendererPath = path.join(__dirname, '..', 'renderer.js');
const source = fs.readFileSync(rendererPath, 'utf8');

// 宽松 Proxy：任何缺失的属性/方法都返回可调用 stub，避免 stub 不完整造成假失败。
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

function makeElement(id = '') {
  return {
    id,
    style: { setProperty() {}, removeProperty() {}, display: '' },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    hidden: false,
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    appendChild() {},
    removeChild() {},
    insertBefore() {},
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    blur() {},
    scrollTo() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800 }),
    getContext: () => makeStub('canvasContext'),
    animate: () => makeStub('animate')
  };
}

// rAF 只排队、不执行：门禁验证的是顶层求值，不是绘制。
const pendingFrames = [];

const windowObject = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
  requestAnimationFrame: cb => { pendingFrames.push(cb); return pendingFrames.length; },
  cancelAnimationFrame() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'file:///renderer.html', search: '' },
  navigator: { userAgent: 'node-test', platform: 'node' },
  MaterialIcons: {
    createIcon: () => makeElement('svg'),
    upgrade: () => {},
    replace: () => {}
  },
  CustomEvent: class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => 0 },
  devicePixelRatio: 1,
  innerWidth: 1200,
  innerHeight: 800,
  scrollX: 0,
  scrollY: 0,
  ResizeObserver: class ResizeObserver { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class MutationObserver { observe() {} disconnect() {} takeRecords() { return []; } },
  IntersectionObserver: class IntersectionObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  Blob: class Blob { constructor(parts) { this.parts = parts; } size = 0; type = ''; },
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
  TextDecoder: class TextDecoder { decode() { return ''; } },
  TextEncoder: class TextEncoder { encode() { return new Uint8Array(0); } }
};

const documentObject = {
  documentElement: makeElement('html'),
  body: makeElement('body'),
  head: makeElement('head'),
  getElementById: id => makeElement(id),
  querySelector: () => makeElement(),
  querySelectorAll: () => [],
  createElement: tag => makeElement(tag),
  createElementNS: (_ns, tag) => makeElement(tag),
  createDocumentFragment: () => makeElement('fragment'),
  addEventListener() {},
  removeEventListener() {},
  execCommand() {},
  activeElement: makeElement(),
  fonts: { ready: Promise.resolve(), add() {}, check: () => true }
};

windowObject.document = documentObject;
global.window = windowObject;
global.document = documentObject;

// 把 window 上的属性整体镜像到 global：renderer / xterm / uplot 会在模块顶层
// 直接读裸的浏览器全局（navigator、devicePixelRatio、matchMedia……）。
// 逐个补会反复发现下一个缺失项，整体镜像一次到位。
Object.keys(windowObject).forEach(key => {
  if (key === 'document') return;
  global[key] = windowObject[key];
});

class StubTerminal {
  constructor(options = {}) {
    this.options = options;
    this.cols = 80;
    this.rows = 24;
    this.element = makeElement('xterm');
    this.textarea = makeElement('textarea');
    this.buffer = { active: { length: 0, getLine: () => null, cursorY: 0 } };
    this._core = {
      _selectionService: { selection: undefined },
      _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } }
    };
  }
  loadAddon() {}
  open(element) { this.openedInto = element; }
  write(_data, cb) { if (typeof cb === 'function') cb(); }
  writeln() {}
  onData() { return { dispose() {} }; }
  onBinary() { return { dispose() {} }; }
  onResize() { return { dispose() {} }; }
  onScroll() { return { dispose() {} }; }
  onSelectionChange() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
  reset() {}
  clear() {}
  hasSelection() { return false; }
  getSelection() { return ''; }
  selectLines() {}
  selectAll() {}
  clearSelection() {}
  scrollToBottom() {}
  scrollToLine() {}
  scrollLines() {}
  scrollPages() {}
  focus() {}
  dispose() {}
}

class StubAddon {
  fit() {}
  proposeDimensions() { return { cols: 80, rows: 24 }; }
  activate() {}
  findNext() { return false; }
  findPrevious() { return false; }
  clearDecorations() {}
  dispose() {}
}

class StubPlot {
  constructor() { this.axes = []; this.series = []; }
  setData() {}
  setSize() {}
  setScale() {}
  batch() {}
  destroy() {}
  on() {}
}

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      ipcRenderer: {
        invoke: () => Promise.resolve({}),
        send() {},
        on() {},
        once() {},
        removeListener() {},
        removeAllListeners() {}
      }
    };
  }
  if (request === '@xterm/xterm') return { Terminal: StubTerminal };
  if (request === '@xterm/addon-fit') return { FitAddon: StubAddon };
  if (request === '@xterm/addon-search') return { SearchAddon: StubAddon };
  if (request === 'uplot') return { default: StubPlot };
  return originalLoad.apply(this, arguments);
};

let failure = null;
try {
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {${source}\n})`,
    { filename: rendererPath }
  );
  wrapper(module.exports, Module.createRequire(rendererPath), module, rendererPath, path.dirname(rendererPath));
} catch (error) {
  failure = error;
} finally {
  Module._load = originalLoad;
}

if (failure) {
  process.stderr.write(
    `renderer.js failed at module init: ${failure.constructor.name}: ${failure.message}\n` +
    `${String(failure.stack || '').split('\n').slice(0, 6).join('\n')}\n`
  );
  // 主动退出：不等待任何顶层排入的异步回调，它们的失败与本次判定无关。
  process.exit(1);
}

process.stdout.write('renderer.js module body initialized without throwing\n');
process.exit(0);
