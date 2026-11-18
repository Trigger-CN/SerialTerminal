'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { migrateSerialGroupsConfig, needsSerialGroupsMigration } = require('../serial-groups-config');
const { migrateWorkspaceLayoutConfig, WORKSPACE_CONFIG_VERSION } = require('../workspace-layout-state');
const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const start = source.indexOf('function loadConfig()');
const end = source.indexOf('\nlet currentConfig =', start);
const code = source.slice(start, end);
function fixture(failBackup = false) {
    const original = JSON.stringify({ configVersion: 15, serialGroups: [{ id: 'default' }], shellTabs: [] });
    const files = new Map([['/profile/config.json', original]]);
    const c = vm.createContext({ path: path.posix, DEFAULT_SHORTCUTS: {}, CONFIG_VERSION: WORKSPACE_CONFIG_VERSION, DEFAULT_LANGUAGE: 'zh-CN', configPath: '/profile/config.json', configBackupPath: '/profile/config.v14.backup.json',
        app: { getPath: () => '/profile' }, log: { error() {}, info() {} }, needsSerialGroupsMigration,
        fs: { existsSync: name => files.has(name), readFileSync: name => files.get(name), writeFileSync: (name, text) => {
            if (failBackup && name.includes('v15.backup')) throw Error('disk unavailable'); files.set(name, text);
        } }, normalizeConfig: value => migrateWorkspaceLayoutConfig(migrateSerialGroupsConfig(value)) });
    vm.runInContext(code, c);
    return { c, files, original };
}
test('v16 startup backs up the legacy layout once before writing normalized state', () => {
    const f = fixture(); const config = f.c.loadConfig();
    assert.equal(config.configVersion, 16); assert.equal(config.workspaceLayoutState.version, 1);
    assert.equal(f.files.get('/profile/config.v15.backup.json'), JSON.stringify(JSON.parse(f.original), null, 2));
    const backup = f.files.get('/profile/config.v15.backup.json'); f.c.loadConfig();
    assert.equal(f.files.get('/profile/config.v15.backup.json'), backup);
});
test('backup failure leaves the original file unchanged while allowing in-memory startup', () => {
    const f = fixture(true); assert.equal(f.c.loadConfig().configVersion, 16);
    assert.equal(f.files.get('/profile/config.json'), f.original);
});
