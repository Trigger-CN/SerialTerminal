'use strict';

// OSC 52 剪贴板写入的回归测试。
//
// 背景：`atman` 这类 CLI 的 copy 通过 OSC 52 序列把内容交给终端（而不是自己调
// 系统剪贴板）。Windows Terminal / iTerm 实现了该协议所以能复制；xterm.js 默认
// 忽略未知 OSC，内容被静默丢弃——表现就是「复制了但剪贴板没变」。
//
// 这里从真实的 renderer.js 抽取 registerTerminalOsc52 源码执行，确保测的是
// 实际运行的代码，而不是一份手写副本。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const rendererPath = path.join(root, 'renderer.js');
const renderer = fs.readFileSync(rendererPath, 'utf8');

function loadOsc52Impl() {
  const startMarker = 'const OSC52_CLIPBOARD_IDENT = 52;';
  const endMarker = 'function enableTerminalUnicode11(term) {';
  const start = renderer.indexOf(startMarker);
  const end = renderer.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1 && end > start, '未能从 renderer.js 定位 OSC 52 实现');

  const writes = [];
  const logs = [];
  const sandbox = {
    Buffer,
    module: { exports: {} },
    ipcRenderer: { send: (_channel, message) => logs.push(message) },
    writeClipboardText: text => { writes.push(text); return Promise.resolve(true); }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    renderer.slice(start, end) + '\nmodule.exports = { registerTerminalOsc52, OSC52_MAX_BYTES };',
    sandbox
  );
  return { ...sandbox.module.exports, writes, logs };
}

function makeTerm() {
  const state = { ident: null, handler: null };
  state.term = {
    parser: {
      registerOscHandler(ident, handler) {
        state.ident = ident;
        state.handler = handler;
        return { dispose() {} };
      }
    }
  };
  return state;
}

const b64 = text => Buffer.from(text, 'utf8').toString('base64');

test('OSC 52 注册在编号 52 上并写入系统剪贴板', () => {
  const impl = loadOsc52Impl();
  const term = makeTerm();
  impl.registerTerminalOsc52(term.term);

  assert.equal(term.ident, 52, '必须注册 OSC 52');

  const text = 'atman copy 中文内容';
  term.handler(`c;${b64(text)}`);
  assert.deepEqual(impl.writes, [text]);
});

test('OSC 52 拒绝读取请求，避免剪贴板被远端读走', () => {
  const impl = loadOsc52Impl();
  const term = makeTerm();
  impl.registerTerminalOsc52(term.term);

  // '?' 是读取请求。允许它等于让串口另一端的设备读走用户剪贴板。
  term.handler('c;?');
  assert.deepEqual(impl.writes, []);
});

test('OSC 52 对畸形与空负载不崩溃且不写入', () => {
  const impl = loadOsc52Impl();
  const term = makeTerm();
  impl.registerTerminalOsc52(term.term);

  for (const payload of ['no-separator', 'c;', '', 'c;!!!not-base64!!!']) {
    assert.doesNotThrow(() => term.handler(payload));
  }
  assert.deepEqual(impl.writes, []);
});

test('OSC 52 拒绝超过上限的负载并记日志', () => {
  const impl = loadOsc52Impl();
  const term = makeTerm();
  impl.registerTerminalOsc52(term.term);

  const oversized = b64('x'.repeat(impl.OSC52_MAX_BYTES + 1));
  term.handler(`c;${oversized}`);
  assert.deepEqual(impl.writes, [], '超限负载不得写入剪贴板');
  assert.equal(impl.logs.length, 1, '应记录一条拒绝日志');
  assert.match(impl.logs[0], /OSC 52 payload rejected/);
});

test('终端缺少 registerOscHandler 时安全跳过', () => {
  const impl = loadOsc52Impl();
  assert.doesNotThrow(() => impl.registerTerminalOsc52({ parser: {} }));
  assert.doesNotThrow(() => impl.registerTerminalOsc52({}));
  assert.doesNotThrow(() => impl.registerTerminalOsc52(null));
});

test('所有终端创建路径都经过统一入口挂载 OSC 52', () => {
  // enableTerminalUnicode11 是三处 new Terminal() 之后的共同调用点，
  // OSC 52 挂在这里才能覆盖主终端、Shell、过滤页与图表页。
  assert.match(renderer, /function enableTerminalUnicode11\(term\) \{[\s\S]*?registerTerminalOsc52\(term\)/);
  const callSites = (renderer.match(/enableTerminalUnicode11\(term\);/g) || []).length;
  assert.ok(callSites >= 3, `应有至少 3 处终端初始化调用该入口，实际 ${callSites}`);
});
