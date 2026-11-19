'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialGroupRegistry, normalizeGroupId, DEFAULT_SERIAL_GROUP_ID } = require('../src/serial/serial-group-registry');

test('normalizes group ids and falls back to the default group', () => {
  assert.equal(normalizeGroupId(undefined), DEFAULT_SERIAL_GROUP_ID);
  assert.equal(normalizeGroupId('   '), DEFAULT_SERIAL_GROUP_ID);
  assert.equal(normalizeGroupId('  group-a  '), 'group-a');
});

test('registry starts with exactly one default group', () => {
  const registry = new SerialGroupRegistry();
  assert.deepEqual(registry.listGroupIds(), [DEFAULT_SERIAL_GROUP_ID]);
  assert.equal(registry.activeGroupId, DEFAULT_SERIAL_GROUP_ID);
  assert.equal(registry.getGroup(DEFAULT_SERIAL_GROUP_ID).connected, false);
});

test('beginSession records ownership of a session id', () => {
  const registry = new SerialGroupRegistry();
  const sessionId = registry.beginSession(DEFAULT_SERIAL_GROUP_ID, 7);

  assert.equal(sessionId, 7);
  assert.equal(registry.groupIdForSession(7), DEFAULT_SERIAL_GROUP_ID);
  assert.equal(registry.getGroup(DEFAULT_SERIAL_GROUP_ID).connected, true);
});

test('beginSession increments when no session id is supplied', () => {
  const registry = new SerialGroupRegistry();
  assert.equal(registry.beginSession(DEFAULT_SERIAL_GROUP_ID), 1);
  assert.equal(registry.beginSession(DEFAULT_SERIAL_GROUP_ID), 2);
});

test('invalidateSession closes the group and drops ownership cheaply', () => {
  const registry = new SerialGroupRegistry();
  registry.beginSession(DEFAULT_SERIAL_GROUP_ID, 3);

  const next = registry.invalidateSession(DEFAULT_SERIAL_GROUP_ID);

  assert.equal(next, 4);
  assert.equal(registry.getGroup(DEFAULT_SERIAL_GROUP_ID).connected, false);
  // 旧会话号不再被接受：这正是「断开后不得再接收旧数据」的语义。
  assert.equal(registry.accepts({ groupId: DEFAULT_SERIAL_GROUP_ID, sessionId: 3 }).accepted, false);
});

test('accepts only the current session of the matching group', () => {
  const registry = new SerialGroupRegistry();
  registry.beginSession(DEFAULT_SERIAL_GROUP_ID, 10);

  assert.deepEqual(
    registry.accepts({ groupId: DEFAULT_SERIAL_GROUP_ID, sessionId: 10 }),
    { accepted: true, reason: 'ok', groupId: DEFAULT_SERIAL_GROUP_ID }
  );
  assert.equal(registry.accepts({ groupId: DEFAULT_SERIAL_GROUP_ID, sessionId: 9 }).reason, 'stale-session');
  assert.equal(registry.accepts({ groupId: 'nope', sessionId: 10 }).reason, 'unknown-group');
});

test('bytes from another group are rejected rather than merged', () => {
  const registry = new SerialGroupRegistry();
  registry.ensureGroup('group-b');
  registry.beginSession(DEFAULT_SERIAL_GROUP_ID, 1);
  registry.beginSession('group-b', 2);

  const verdict = registry.accepts({ groupId: DEFAULT_SERIAL_GROUP_ID, sessionId: 2 });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'stale-session');
});

test('payloads without a session id fall back to a group-level check', () => {
  const registry = new SerialGroupRegistry();
  registry.beginSession(DEFAULT_SERIAL_GROUP_ID, 5);

  assert.equal(registry.accepts({ groupId: DEFAULT_SERIAL_GROUP_ID }).accepted, true);
  assert.equal(registry.accepts({}).accepted, true);
  assert.equal(registry.accepts({ groupId: 'missing' }).accepted, false);
});

test('only the active group is visible', () => {
  const registry = new SerialGroupRegistry();
  registry.ensureGroup('group-b');

  assert.equal(registry.isVisible(DEFAULT_SERIAL_GROUP_ID), true);
  assert.equal(registry.isVisible('group-b'), false);

  registry.setActiveGroup('group-b');

  assert.equal(registry.isVisible('group-b'), true);
  assert.equal(registry.isVisible(DEFAULT_SERIAL_GROUP_ID), false);
});

test('removing a group falls back to the default and keeps the default intact', () => {
  const registry = new SerialGroupRegistry();
  registry.ensureGroup('group-b');
  registry.setActiveGroup('group-b');

  assert.equal(registry.removeGroup('group-b'), true);
  assert.equal(registry.activeGroupId, DEFAULT_SERIAL_GROUP_ID);
  assert.equal(registry.removeGroup(DEFAULT_SERIAL_GROUP_ID), false);
  assert.deepEqual(registry.listGroupIds(), [DEFAULT_SERIAL_GROUP_ID]);
});


test('equal session ids are scoped by group and invalidation stays local', () => {
  const registry = new SerialGroupRegistry();
  registry.beginSession('default', 1);
  registry.beginSession('g-1', 1);
  assert.equal(registry.accepts({ groupId: 'default', sessionId: 1 }).accepted, true);
  assert.equal(registry.accepts({ groupId: 'g-1', sessionId: 1 }).accepted, true);
  assert.equal(registry.groupIdForSession(1), null);
  registry.invalidateSession('g-1');
  assert.equal(registry.accepts({ groupId: 'g-1', sessionId: 2 }).accepted, false);
  assert.equal(registry.accepts({ groupId: 'default', sessionId: 1 }).accepted, true);
  registry.removeGroup('g-1');
  assert.equal(registry.groupIdForSession(1), 'default');
});
