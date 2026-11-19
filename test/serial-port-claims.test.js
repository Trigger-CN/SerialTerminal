'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SerialPortClaimTable, normalizePortPath, normalizePortKey } = require('../src/serial/serial-port-claims');

test('normalizePortPath trims strings and rejects non-strings', () => {
  assert.equal(normalizePortPath('  COM6 '), 'COM6');
  assert.equal(normalizePortPath(''), '');
  assert.equal(normalizePortPath(undefined), '');
  assert.equal(normalizePortPath(null), '');
  assert.equal(normalizePortPath(6), '');
});

test('normalizePortKey upper-cases because Windows port names are case-insensitive', () => {
  assert.equal(normalizePortKey(' com6 '), 'COM6');
  assert.equal(normalizePortKey('COM6'), 'COM6');
  assert.equal(normalizePortKey(''), '');
});

test('a port claimed by one group cannot be claimed by another', () => {
  const table = new SerialPortClaimTable();
  const claim = table.claim('default', 'COM6');
  assert.equal(claim.ok, true);
  assert.equal(claim.ownerGroupId, 'default');
  assert.equal(claim.portKey, 'COM6');
  assert.equal(typeof claim.token, 'symbol');

  const denied = table.claim('g-1', 'COM6');
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'port-in-use');
  assert.equal(denied.portKey, 'COM6');
  assert.equal(denied.ownerGroupId, 'default');
  assert.equal(table.ownerOf('COM6'), 'default');
  assert.equal(table.size(), 1);
});

test('the same group may re-claim the port it already holds, as reconnect does', () => {
  const table = new SerialPortClaimTable();
  table.claim('g-1', 'COM6');
  const second = table.claim('g-1', 'COM6');
  assert.equal(second.ok, true);
  assert.equal(second.reason, 'claimed');
  assert.equal(table.size(), 1);
});

test('a group only ever holds one port: claiming another releases its previous claim', () => {
  const table = new SerialPortClaimTable();
  table.claim('g-1', 'COM6');
  table.claim('g-1', 'COM7');
  assert.equal(table.ownerOf('COM6'), null);
  assert.equal(table.ownerOf('COM7'), 'g-1');
  assert.equal(table.size(), 1);
});

test('a denied claim does not release the port the group already owns', () => {
  const table = new SerialPortClaimTable();
  table.claim('default', 'COM6');
  table.claim('g-1', 'COM7');

  const denied = table.claim('g-1', 'COM6');
  assert.equal(denied.ok, false);
  assert.equal(denied.ownerGroupId, 'default');
  // 被拒绝时不能先释放自己的 COM7，否则换端口失败会白白丢掉原有连接。
  assert.equal(table.ownerOf('COM7'), 'g-1');
  assert.equal(table.ownerOf('COM6'), 'default');
});

test('releaseGroup frees the claim and reports the freed port', () => {
  const table = new SerialPortClaimTable();
  table.claim('g-1', 'COM6');
  assert.equal(table.releaseGroup('g-1'), 'COM6');
  assert.equal(table.ownerOf('COM6'), null);
  assert.equal(table.size(), 0);
  // 没有占用时返回 null，且不抛错。
  assert.equal(table.releaseGroup('g-1'), null);
});

test('releasePort only frees when both the port and the owner match', () => {
  const table = new SerialPortClaimTable();
  table.claim('default', 'COM6');

  // 迟到的断开事件拿着别的分组 id，不能把当前占用者的端口释放掉。
  assert.equal(table.releasePort('g-1', 'COM6'), false);
  assert.equal(table.ownerOf('COM6'), 'default');

  assert.equal(table.releasePort('default', 'COM6'), true);
  assert.equal(table.ownerOf('COM6'), null);
  // 重复释放不再返回 true。
  assert.equal(table.releasePort('default', 'COM6'), false);
});

test('releasePort does not free a different port owned by the same group', () => {
  const table = new SerialPortClaimTable();
  table.claim('g-1', 'COM7');
  assert.equal(table.releasePort('g-1', 'COM6'), false);
  assert.equal(table.ownerOf('COM7'), 'g-1');
});

test('port keys are compared case-insensitively and trimmed', () => {
  const table = new SerialPortClaimTable();
  table.claim('default', 'com6');
  assert.equal(table.isClaimedByOther('g-1', 'COM6'), true);
  assert.equal(table.isClaimedByOther('g-1', ' com6 '), true);
  assert.equal(table.isClaimedByOther('default', 'COM6'), false);
  assert.equal(table.claim('g-1', ' Com6 ').ok, false);
});

test('an empty port is rejected instead of being treated as a shared key', () => {
  const table = new SerialPortClaimTable();
  assert.deepEqual(table.claim('g-1', ''), { ok: false, reason: 'empty-port', portKey: '' });
  assert.deepEqual(table.claim('g-1', '   '), { ok: false, reason: 'empty-port', portKey: '' });
  assert.equal(table.size(), 0);
  assert.equal(table.ownerOf(''), null);
});

test('different groups may hold different ports at the same time', () => {
  const table = new SerialPortClaimTable();
  assert.equal(table.claim('default', 'COM6').ok, true);
  assert.equal(table.claim('g-1', 'COM17').ok, true);
  assert.equal(table.size(), 2);
  assert.equal(table.ownerOf('COM6'), 'default');
  assert.equal(table.ownerOf('COM17'), 'g-1');
});

test('clear drops every claim', () => {
  const table = new SerialPortClaimTable();
  table.claim('default', 'COM6');
  table.claim('g-1', 'COM17');
  table.clear();
  assert.equal(table.size(), 0);
  assert.equal(table.ownerOf('COM6'), null);
});

test('old connection token cannot release a replacement claim on the same port', () => {
  const table = new SerialPortClaimTable();
  const old = table.claim('default', 'COM6');
  const next = table.claim('default', 'COM6');
  assert.equal(table.releasePort('default', 'COM6', old.token), false);
  assert.equal(table.ownerOf('COM6'), 'default');
  assert.equal(table.releasePort('default', 'COM6', next.token), true);
});
