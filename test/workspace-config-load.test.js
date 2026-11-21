'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { migrateSerialGroupsConfig, needsSerialGroupsMigration } = require('../src/serial/serial-groups-config');
const { migrateWorkspaceLayoutConfig, WORKSPACE_CONFIG_VERSION } = require('../src/workspace/workspace-layout-state');
const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const start = source.indexOf('function loadConfig()');
const end = source.indexOf('\nlet currentConfig =', start);
const code = source.slice(start, end);
function fixture(failBackup = false, saved = { configVersion: 16, serialGroups: [{ id: 'default' }], shellTabs: [] }) {
    const original = JSON.stringify(saved);
    const files = new Map([['/profile/config.json', original]]);
    const c = vm.createContext({ path: path.posix, DEFAULT_SHORTCUTS: {}, CONFIG_VERSION: WORKSPACE_CONFIG_VERSION, DEFAULT_LANGUAGE: 'zh-CN', configPath: '/profile/config.json', configBackupPath: '/profile/config.v14.backup.json',
        app: { getPath: () => '/profile' }, log: { error() {}, info() {} }, needsSerialGroupsMigration,
        fs: { existsSync: name => files.has(name), readFileSync: name => files.get(name), writeFileSync: (name, text) => {
            if (failBackup && name.includes('v16.backup')) throw Error('disk unavailable'); files.set(name, text);
        } }, normalizeConfig: value => migrateWorkspaceLayoutConfig(migrateSerialGroupsConfig(value)) });
    vm.runInContext(code, c);
    return { c, files, original };
}
test('v17 startup backs up v16 once before writing the tree snapshot', () => {
    const f = fixture(); const config = f.c.loadConfig();
    assert.equal(config.configVersion, 17); assert.equal(config.workspaceLayoutState.version, 2);
    assert.equal(f.files.get('/profile/config.v16.backup.json'), JSON.stringify(JSON.parse(f.original), null, 2));
    const backup = f.files.get('/profile/config.v16.backup.json'); f.c.loadConfig();
    assert.equal(f.files.get('/profile/config.v16.backup.json'), backup);
});
test('backup failure leaves the original file unchanged while allowing in-memory startup', () => {
    const f = fixture(true); assert.equal(f.c.loadConfig().configVersion, 17);
    assert.ok(f.c.loadConfig.writeBlockedReason);
    assert.equal(f.files.get('/profile/config.json'), f.original);
});
test('unknown layout version preserves business settings in memory and blocks every later config writer', () => {
    const f = fixture(false, { configVersion: 99, serialGroups: [{ id: 'default', title: 'kept' }],
        shellTabs: [], workspaceLayoutState: { version: 99 } });
    const config = f.c.loadConfig();
    assert.equal(config.serialGroups[0].title, 'kept');
    assert.equal(f.files.get('/profile/config.json'), f.original);
    assert.match(f.c.loadConfig.writeBlockedReason, /99/);
    const saveStart = source.indexOf('function saveConfig(');
    const saveEnd = source.indexOf('\ntelemetryReporter =', saveStart);
    vm.runInContext(source.slice(saveStart, saveEnd), f.c);
    assert.throws(() => f.c.saveConfig({ fontSize: 22 }), /99/);
    f.c.persistTelemetryState({ telemetryLastSent: 1 });
    assert.equal(f.files.get('/profile/config.json'), f.original);
});
