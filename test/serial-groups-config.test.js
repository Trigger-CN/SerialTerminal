'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SERIAL_GROUPS_CONFIG_VERSION,
  MIGRATED_DEFAULT_GROUP_ID,
  normalizeGroupSerialOptions,
  buildMigratedDefaultGroup,
  normalizeSerialGroups,
  migrateSerialGroupsConfig,
  needsSerialGroupsMigration
} = require('../serial-groups-config');

test('a v14 config without serialGroups becomes one group carrying the old state', () => {
  const migrated = migrateSerialGroupsConfig({
    configVersion: 14,
    lastSerialOptions: {
      path: 'COM3',
      baudRate: '115200',
      dataBits: '8',
      stopBits: '1',
      parity: 'none',
      receiveDisplayMode: 'hex',
      receiveEncoding: 'ascii',
      sendEncoding: 'gbk',
      newlineMode: 'lf'
    },
    filterTabs: [{ id: 'tab-filter-1', dataMode: 'text' }],
    chartTabs: [{ id: 'tab-chart-1' }],
    workspaceLayout: { splitEnabled: true, panes: [{ id: 'pane-1' }, { id: 'pane-2' }] }
  });

  assert.equal(migrated.configVersion, SERIAL_GROUPS_CONFIG_VERSION);
  assert.equal(migrated.serialGroups.length, 1);

  const group = migrated.serialGroups[0];
  assert.equal(group.id, MIGRATED_DEFAULT_GROUP_ID);
  assert.equal(group.title, 'COM3');
  assert.equal(group.portPath, 'COM3');
  assert.equal(group.status, 'disconnected');
  assert.equal(group.sessionId, null);
  assert.deepEqual(group.serialOptions, {
    baudRate: '115200',
    dataBits: '8',
    stopBits: '1',
    parity: 'none',
    receiveDisplayMode: 'hex',
    receiveEncoding: 'ascii',
    sendEncoding: 'gbk',
    newlineMode: 'lf'
  });
  assert.deepEqual(group.filterTabs, [{ id: 'tab-filter-1', dataMode: 'text' }]);
  assert.deepEqual(group.chartTabs, [{ id: 'tab-chart-1' }]);
  assert.equal(group.workspaceLayout.splitEnabled, true);
});

test('old v14 fields are kept so a downgrade can still read them', () => {
  const migrated = migrateSerialGroupsConfig({
    configVersion: 14,
    lastSerialOptions: { path: 'COM7', baudRate: '9600' },
    filterTabs: [{ id: 'tab-filter-9' }],
    chartTabs: [],
    workspaceLayout: { splitEnabled: false }
  });

  assert.deepEqual(migrated.lastSerialOptions, { path: 'COM7', baudRate: '9600' });
  assert.deepEqual(migrated.filterTabs, [{ id: 'tab-filter-9' }]);
  assert.deepEqual(migrated.chartTabs, []);
  assert.deepEqual(migrated.workspaceLayout, { splitEnabled: false });
});

test('migrating twice produces the exact same object', () => {
  const once = migrateSerialGroupsConfig({
    configVersion: 14,
    lastSerialOptions: { path: 'COM3', baudRate: '115200' },
    filterTabs: [{ id: 'tab-filter-1' }]
  });
  const twice = migrateSerialGroupsConfig(JSON.parse(JSON.stringify(once)));

  assert.deepEqual(twice, once);
  assert.equal(twice.serialGroups.length, 1);
});

test('an empty serialGroups array is respected and never re-seeded', () => {
  const migrated = migrateSerialGroupsConfig({
    configVersion: 15,
    serialGroups: [],
    lastSerialOptions: { path: 'COM3', baudRate: '115200' }
  });

  assert.deepEqual(migrated.serialGroups, []);
});

test('a config with no port falls back to a readable placeholder title', () => {
  const group = buildMigratedDefaultGroup({});
  assert.equal(group.id, MIGRATED_DEFAULT_GROUP_ID);
  assert.equal(group.portPath, '');
  assert.equal(group.title, 'Serial 1');
  assert.equal(group.serialOptions.baudRate, '9600');
  assert.equal(group.serialOptions.dataBits, '8');
  assert.equal(group.serialOptions.parity, 'none');
  assert.equal(group.serialOptions.receiveDisplayMode, 'text');
  assert.equal(group.serialOptions.receiveEncoding, 'utf8');
  assert.equal(group.serialOptions.newlineMode, 'crlf');
});

test('invalid serial options fall back instead of leaking undefined into the UI', () => {
  const options = normalizeGroupSerialOptions({
    baudRate: '   ',
    dataBits: '9',
    stopBits: '3',
    parity: 'weird',
    receiveDisplayMode: 'binary',
    receiveEncoding: 'latin1',
    sendEncoding: 'utf-32',
    newlineMode: '\n'
  });

  assert.deepEqual(options, {
    baudRate: '9600',
    dataBits: '8',
    stopBits: '1',
    parity: 'none',
    receiveDisplayMode: 'text',
    receiveEncoding: 'utf8',
    sendEncoding: 'utf8',
    newlineMode: 'crlf'
  });
});

test('missing option keys inherit from the fallback supplied by the caller', () => {
  const options = normalizeGroupSerialOptions({ baudRate: '57600' }, { baudRate: '9600', receiveEncoding: 'gbk' });
  assert.equal(options.baudRate, '57600');
  assert.equal(options.receiveEncoding, 'gbk');
});

test('duplicate group ids are made unique with a deterministic suffix', () => {
  const groups = normalizeSerialGroups([
    { id: 'g-1', title: 'A' },
    { id: 'g-1', title: 'B' },
    { id: 'g-1', title: 'C' }
  ]);

  assert.deepEqual(groups.map(group => group.id), ['g-1', 'g-1-2', 'g-1-3']);
});

test('groups without an id get a stable positional id, not a random one', () => {
  const first = normalizeSerialGroups([{ title: 'A' }]);
  const second = normalizeSerialGroups([{ title: 'A' }]);
  assert.equal(first[0].id, 'g-00000001');
  assert.equal(second[0].id, first[0].id);
});

test('non-object entries in serialGroups are dropped without throwing', () => {
  const groups = normalizeSerialGroups([null, 'nope', 42, { id: 'g-ok', title: 'OK' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'g-ok');
});

test('normalizing a group resets the runtime session id', () => {
  const groups = normalizeSerialGroups([{ id: 'g-1', sessionId: 12345, status: 'connected' }]);
  assert.equal(groups[0].sessionId, null);
  assert.equal(groups[0].status, 'connected');
});

test('unknown statuses fall back to disconnected', () => {
  const groups = normalizeSerialGroups([{ id: 'g-1', status: 'zombie' }]);
  assert.equal(groups[0].status, 'disconnected');
});

test('only a config without the serialGroups key is considered to need migration', () => {
  assert.equal(needsSerialGroupsMigration({ configVersion: 14 }), true);
  assert.equal(needsSerialGroupsMigration({ configVersion: 15, serialGroups: [] }), false);
  assert.equal(needsSerialGroupsMigration({ configVersion: 15, serialGroups: [{ id: 'g-1' }] }), false);
  assert.equal(needsSerialGroupsMigration(null), true);
});

test('migration never mutates the input object', () => {
  const original = { configVersion: 14, lastSerialOptions: { path: 'COM3' } };
  const snapshot = JSON.parse(JSON.stringify(original));
  migrateSerialGroupsConfig(original);
  assert.deepEqual(original, snapshot);
});
