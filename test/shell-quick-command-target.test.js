'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture: workspace, model, act } = require('./workspace-tree-fixture');
const { createWorkspaceModelManager } = require('../src/workspace/workspace-model-manager');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
function fn(name) {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, `Missing renderer function ${name}`);
    return source.slice(start, end);
}
function fixture(multiple = false) {
    const sent = [], focused = [], statuses = [];
    const context = vm.createContext({ workspaceModel: workspace(multiple), activeGroupId: 'default',
        focusedWorkspaceTabId: 'tab-main',
        shellTabs: ['tab-shell-1', 'tab-shell-2'].map(id => ({ id, sessionReady: true, term: { focus: () => focused.push(id) } })),
        ipcRenderer: { send: (channel, payload) => sent.push({ channel, ...payload }) },
        setActionStatus: message => statuses.push(message), trFallback: (_, text) => text });
    context.getGroupWorkspaceManager = groupId => createWorkspaceModelManager({ groupId,
        getWorkspace: () => context.workspaceModel, dispatch: () => { throw new Error('Sending must not change layout'); } });
    for (const name of ['getActiveTabInfo', 'getActiveShellTab', 'sendShellQuickCommand']) vm.runInContext(fn(name), context);
    return { context, sent, focused, statuses,
        act: action => { context.workspaceModel = act(context.workspaceModel, action); },
        send: (appendEnter = true) => context.sendShellQuickCommand({ command: 'echo target', appendEnter }),
        expectTarget: (id, data = 'echo target\r') => {
            assert.deepEqual(sent, [{ channel: 'shell-tab-input', tabId: id, data }]);
            assert.deepEqual(focused, [id]);
        } };
}
for (const multiple of [false, true]) {
    test(`Shell quick command targets globally focused Shell in ${multiple ? 'multi' : 'single'}-group mode`, () => {
        const f = fixture(multiple);
        f.act({ type: 'activate', tabId: 'tab-shell-2' }); f.send();
        f.expectTarget('tab-shell-2');
    });
}
test('two visible Shell regions send only to the last focused Shell, not the control group region', () => {
    const f = fixture();
    f.act({ type: 'split-tab', tabId: 'tab-shell-2', direction: 'right' });
    f.act({ type: 'activate', tabId: 'tab-main' });
    f.act({ type: 'activate', tabId: 'tab-shell-1' });
    f.act({ type: 'activate', tabId: 'tab-shell-2' });
    assert.deepEqual(new Set(model.buildRenderPlan(f.context.workspaceModel).panelIds), new Set(['tab-shell-1', 'tab-shell-2']));
    f.send(false); f.expectTarget('tab-shell-2', 'echo target');
});
test('switching the serial control group does not redirect the focused Shell command', () => {
    const f = fixture(true);
    f.act({ type: 'split-tab', tabId: 'tab-shell-2', direction: 'bottom' });
    f.act({ type: 'activate', tabId: 'tab-shell-2' }); f.context.activeGroupId = 'b';
    f.send(); f.expectTarget('tab-shell-2');
});
test('a visible but unfocused Shell is not a fallback when serial content has focus', () => {
    const f = fixture();
    f.act({ type: 'split-tab', tabId: 'tab-shell-2' });
    f.act({ type: 'activate', tabId: 'tab-main' });
    f.context.focusedWorkspaceTabId = 'tab-shell-2';
    f.send(); assert.deepEqual(f.sent, []); assert.deepEqual(f.focused, []);
    assert.equal(f.statuses.at(-1), 'Activate a Shell tab first');
});
test('an unready focused Shell never redirects to another ready Shell', () => {
    const f = fixture(); f.act({ type: 'activate', tabId: 'tab-shell-2' });
    f.context.shellTabs[1].sessionReady = false; f.send();
    assert.deepEqual(f.sent, []); assert.deepEqual(f.focused, []);
    assert.equal(f.statuses.at(-1), 'The active Shell is not ready');
});
test('a removed Shell is not reused and an existing selected Shell remains the target after movement', () => {
    const f = fixture();
    f.act({ type: 'split-tab', tabId: 'tab-shell-2' });
    f.act({ type: 'activate', tabId: 'tab-shell-2' });
    const target = model.locateTab(f.context.workspaceModel, 'tab-main').stack.id;
    f.act({ type: 'move', tabId: 'tab-shell-2', target: { nodeId: target } });
    f.send(); f.expectTarget('tab-shell-2');
    f.sent.length = 0; f.focused.length = 0;
    f.act({ type: 'close', tabId: 'tab-shell-2' });
    f.act({ type: 'activate', tabId: 'tab-main' }); f.send();
    assert.deepEqual(f.sent, []); assert.deepEqual(f.focused, []);
});
for (const eventType of ['click', 'focusin']) {
    test(`visible Shell content ${eventType} updates the quick-command target without changing serial control`, () => {
        const f = fixture(true), listeners = new Map();
        f.act({ type: 'split-tab', tabId: 'tab-shell-2' });
        f.act({ type: 'activate', tabId: 'tab-main' });
        f.context.document = { addEventListener: (type, handler) => listeners.set(type, handler) };
        f.context.setFocusedTab = tabId => { f.act({ type: 'activate', tabId }); return true; };
        f.context.applyActiveSerialGroup = () => { throw new Error('Shell must not change serial control'); };
        vm.runInContext(fn('bindWorkspaceContentActivation'), f.context); f.context.bindWorkspaceContentActivation();
        const panel = { id: 'tab-shell-2', classList: { contains: name => name === 'active' } };
        listeners.get(eventType)({ target: { closest: () => panel } });
        assert.equal(f.context.activeGroupId, 'default'); f.send(); f.expectTarget('tab-shell-2');
    });
}
test('main-process Shell input writes only to the exact requested PTY', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = main.indexOf("ipcMain.on('shell-tab-input',"), end = main.indexOf('\n});', start) + 4;
    assert.ok(start >= 0 && end > start);
    const written = [], handlers = new Map();
    const shellSessions = new Map(['tab-shell-1', 'tab-shell-2'].map(id => [id, { ptyProcess: { write: data => written.push({ id, data }) } }]));
    vm.runInNewContext(main.slice(start, end), { shellSessions, ipcMain: { on: (channel, handler) => handlers.set(channel, handler) } });
    const input = handlers.get('shell-tab-input');
    input({}, { tabId: 'tab-shell-2', data: 'echo target\r' });
    input({}, { tabId: 'removed-shell', data: 'never send' });
    assert.deepEqual(written, [{ id: 'tab-shell-2', data: 'echo target\r' }]);
});
test('startup selection uses only the startup focus hint before model initialization', () => {
    const f = fixture(); f.context.workspaceModel = null; f.context.focusedWorkspaceTabId = 'tab-shell-2';
    f.send(); f.expectTarget('tab-shell-2');
});
