'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  groupDomSuffix,
  mainTabId,
  mainTabButtonId,
  serialContainerId
} = require('../src/serial/serial-group-dom');

const root = path.join(__dirname, '..');

test('the default group keeps the exact ids the existing markup already uses', () => {
  // 这是整份契约最重要的一条：默认分组必须**不携带后缀**。
  // 若这里变成 'tab-main-default'，index.html 里的静态标记与
  // pane-layout-dom 的描述会同时失效，而失败方式是「终端区空白」而不是报错。
  assert.equal(groupDomSuffix('default'), '');
  assert.equal(mainTabId('default'), 'tab-main');
  assert.equal(mainTabButtonId('default'), 'tab-main-button');
  assert.equal(serialContainerId('default'), 'serial-container');
});

test('default group ids match the real static markup in index.html', () => {
  // 防止契约与静态标记漂移。前面那条用例只证明函数返回了字符串，
  // 这条证明那些字符串真的存在于页面里——否则整套 id 计算就是自说自话。
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, new RegExp(`id="${mainTabId('default')}"`));
  assert.match(html, new RegExp(`id="${mainTabButtonId('default')}"`));
  assert.match(html, new RegExp(`id="${serialContainerId('default')}"`));
});

test('other groups get a suffixed container that cannot collide with the default one', () => {
  const ids = ['g-1', 'g-2', 'g-10'].map(serialContainerId);
  assert.deepEqual(new Set(ids).size, ids.length);
  assert.equal(serialContainerId('g-1'), 'serial-container-g-1');
  assert.equal(mainTabId('g-1'), 'tab-main-g-1');
  assert.equal(mainTabButtonId('g-1'), 'tab-main-g-1-button');
});

test('every group produces a distinct tab, button, and container id', () => {
  const groups = ['default', 'g-1', 'g-2'];
  assert.equal(new Set(groups.map(mainTabId)).size, groups.length);
  assert.equal(new Set(groups.map(mainTabButtonId)).size, groups.length);
  assert.equal(new Set(groups.map(serialContainerId)).size, groups.length);
});

test('non-default containers keep the serial-container prefix', () => {
  // 前缀必须保持：批量 fit 全部终端时按 [id^="serial-container"] 查找，
  // 若换了前缀，非默认分组的终端会永远不被 fit，表现为尺寸不随窗口变化。
  assert.ok(serialContainerId('g-1').startsWith('serial-container'));
  assert.ok(serialContainerId('default').startsWith('serial-container'));
});

test('empty and malformed group ids fall back to the default group', () => {
  // 空 id 若被拼成 'serial-container-'，它既不是默认容器、也不对应任何分组，
  // 结果是终端挂到一个永远不存在的节点上。
  ['', '   ', null, undefined, 42].forEach(value => {
    assert.equal(serialContainerId(value), 'serial-container');
    assert.equal(mainTabId(value), 'tab-main');
  });
});

test('ids are safe to use in a CSS selector', () => {
  // groupId 来自用户可编辑的配置文件，可能含空格、冒号、引号。
  // 直接拼进 querySelector 会抛 SyntaxError，而不是找不到元素。
  const dirty = 'a b:c"d#e';
  [serialContainerId(dirty), mainTabId(dirty), mainTabButtonId(dirty)].forEach(id => {
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    assert.doesNotThrow(() => new RegExp(`id="${id}"`));
  });
});

test('sanitizing a dirty id stays stable across repeated calls', () => {
  // 同一个 groupId 两次算出的 id 必须相同，否则同一分组会得到两个容器。
  const dirty = 'g 1';
  assert.equal(serialContainerId(dirty), serialContainerId(dirty));
  assert.equal(serialContainerId('g 1'), serialContainerId('g_1'));
});
