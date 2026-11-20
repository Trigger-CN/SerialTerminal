'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../src/workspace/tab-model');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

function fixture() {
    model.resetIdSeq();
    const workspace = model.createWorkspace();
    const group = model.roots(workspace).find(model.isContainer);
    const mainId = group.panes[0].tabIds[0];
    return { workspace, group, mainId };
}

function loadFunctions(context, names) {
    vm.createContext(context);
    for (const name of names) {
        const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
        const end = source.indexOf('\nfunction ', start + 1);
        assert.ok(start >= 0 && end > start, name);
        vm.runInContext(source.slice(start, end), context);
    }
    return context;
}

test('split admission counts only the source pane and preserves the root Shell path', () => {
    const { workspace, group, mainId } = fixture();
    assert.equal(model.canSplitTab(workspace, mainId, group.id), false);
    const shell = model.addShell(workspace);
    assert.equal(model.canSplitTab(workspace, mainId, group.id), false);
    assert.equal(model.canSplitTab(workspace, shell.id, group.id), true);
    const filter = model.addLeaf(workspace, 'filter', group.id);
    assert.equal(model.canSplitTab(workspace, mainId, group.id), true);
    const split = model.applyWorkspaceAction(workspace, {
        type: 'split-tab', tabId: filter.id, groupId: group.id, paneId: 'other-pane'
    });
    assert.equal(split.ok, true, split.reason);
    model.addContainerTab(split.workspace, { id: 'second', mainId: 'second-main' });
    assert.equal(model.canSplitTab(split.workspace, mainId, group.id), false);
    assert.equal(model.canSplitTab(split.workspace, filter.id, group.id), false);
    assert.equal(model.canSplitTab(split.workspace, shell.id, group.id), false);
    assert.equal(model.canSplitTab(split.workspace, 'missing', group.id), false);
});

test('move target is an existing pane and a sole source leaf may merge into it', () => {
    const { workspace, group, mainId } = fixture();
    const filter = model.addLeaf(workspace, 'filter', group.id);
    assert.equal(model.getOtherPaneTarget(workspace, filter.id, group.id), null);
    const split = model.applyWorkspaceAction(workspace, {
        type: 'split-tab', tabId: filter.id, groupId: group.id, paneId: 'other-pane'
    }).workspace;
    const before = JSON.stringify(split);
    const target = model.getOtherPaneTarget(split, filter.id, group.id);
    assert.equal(JSON.stringify(split), before, 'capability read must not mutate the model');
    assert.equal(target.paneId, group.panes[0].id);
    const moved = model.applyWorkspaceAction(split, { type: 'move', tabId: filter.id, target });
    assert.equal(moved.ok, true, moved.reason);
    assert.equal(moved.workspace.tabs[group.id].panes.length, 1);
    assert.deepEqual(moved.workspace.tabs[group.id].panes[0].tabIds, [mainId, filter.id]);
    assert.equal(moved.workspace.tabs[group.id].paneSplit.enabled, false);
});

test('both renderer menu requests use current model capabilities, not payload flags', () => {
    const { workspace, group, mainId } = fixture();
    const sent = [];
    const context = loadFunctions({
        workspaceModel: workspace, tabModel: model, activeGroupId: group.id,
        groupIdForWorkspaceTab: () => group.id, resolveSerialGroupId: id => id,
        getContextMenuLabels: () => ({}), getShellTabState: () => null,
        getShellTabOwner: () => null,
        ipcRenderer: { send: (channel, payload) => sent.push({ channel, payload }) }
    }, ['getWorkspaceTabMenuCapabilities', 'requestTerminalContextMenu', 'requestWorkspaceTabContextMenu']);
    context.requestTerminalContextMenu({ terminalType: 'main', tabId: mainId, groupId: group.id, canSplit: true });
    context.requestWorkspaceTabContextMenu({ tabId: mainId, groupId: group.id });
    for (const { payload } of sent) {
        assert.equal(payload.canSplit, false);
        assert.equal(payload.canMoveToOtherPane, false);
    }
    model.addLeaf(workspace, 'filter', group.id);
    context.requestTerminalContextMenu({ terminalType: 'main', tabId: mainId, groupId: group.id });
    context.requestWorkspaceTabContextMenu({ tabId: mainId, groupId: group.id });
    assert.equal(sent[2].payload.canSplit, true);
    assert.equal(sent[3].payload.canSplit, true);
});

test('renderer move dispatches move into an existing pane instead of split-tab', () => {
    const { workspace, group } = fixture();
    const filter = model.addLeaf(workspace, 'filter', group.id);
    const split = model.applyWorkspaceAction(workspace, {
        type: 'split-tab', tabId: filter.id, groupId: group.id, paneId: 'other-pane'
    }).workspace;
    const actions = [];
    const context = loadFunctions({
        workspaceModel: split, tabModel: model, activeGroupId: group.id,
        groupIdForWorkspaceTab: () => group.id,
        persistGroupWorkspaceLayout: () => {}, persistShellTabs: () => {}
    }, ['moveWorkspaceTabToOtherPane']);
    context.dispatchWorkspaceAction = action => {
        actions.push(action);
        const result = model.applyWorkspaceAction(context.workspaceModel, action);
        if (result.ok) context.workspaceModel = result.workspace;
        return result;
    };
    assert.equal(context.moveWorkspaceTabToOtherPane({ tabId: filter.id, groupId: group.id }), true);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'move');
    assert.equal(context.workspaceModel.tabs[group.id].panes.length, 1);
    assert.equal(context.moveWorkspaceTabToOtherPane({ tabId: filter.id, groupId: group.id }), false);
    assert.equal(actions.length, 1, 'no existing target must not create a pane');
});

test('native menu templates use split and move capabilities for every existing entry', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    let handler;
    let items;
    const context = vm.createContext({
        ipcMain: { on: (_channel, fn) => { handler = fn; } },
        BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
        terminalContextMenuState: null, menuIcon: () => ({}),
        Menu: { buildFromTemplate: template => { items = template; return { popup() {} }; } }
    });
    vm.runInContext(main.slice(main.indexOf("ipcMain.on('show-terminal-context-menu'"),
        main.indexOf("ipcMain.handle('get-system-fonts'")), context);
    for (const terminalType of ['tab', 'main', 'filter', 'shell', 'chart']) {
        for (const enabled of [false, true]) {
            handler({ sender: { send() {} } }, { terminalType, tabId: 'present', canSplit: enabled, canMoveToOtherPane: enabled });
            const splitItems = items.filter(item => /Move Tab to (Right|Bottom) Split/.test(item.label));
            const moveItems = items.filter(item => item.label === 'Move to Other Pane');
            assert.equal(splitItems.length, terminalType === 'chart' ? 0 : 2, terminalType);
            assert.equal(moveItems.length, ['chart', 'filter', 'shell'].includes(terminalType) ? 1 : 0, terminalType);
            for (const item of [...splitItems, ...moveItems]) assert.equal(item.enabled, enabled, terminalType);
        }
    }
});

test('layout changes after opening a menu produce status feedback without partial edits', async () => {
    const { workspace, group, mainId } = fixture();
    const statuses = [];
    const actions = [];
    const context = loadFunctions({
        workspaceModel: workspace, tabModel: model, activeGroupId: group.id,
        groupIdForWorkspaceTab: () => group.id, resolveSerialGroupId: id => id,
        serialRuntimes: new Map(), filterTabsStore: { getList: () => [] }, chartTabsStore: { getList: () => [] },
        getShellTabState: () => null, groupPaneId: (_id, ordinal) => `pane-${ordinal}`,
        persistGroupWorkspaceLayout: () => {}, persistShellTabs: () => {},
        setActionStatus: status => statuses.push(status)
    }, ['splitWorkspaceTabIntoPane', 'moveWorkspaceTabToOtherPane', 'handleTerminalContextMenuAction']);
    context.dispatchWorkspaceAction = action => {
        actions.push(action);
        const result = model.applyWorkspaceAction(context.workspaceModel, action);
        if (result.ok) context.workspaceModel = result.workspace;
        return result;
    };
    const before = JSON.stringify(workspace);
    for (const action of ['split-horizontal', 'split-vertical', 'move-to-other-pane']) {
        await context.handleTerminalContextMenuAction({ action, tabId: mainId, terminalType: 'main', groupId: group.id });
        assert.equal(JSON.stringify(context.workspaceModel), before);
        assert.match(statuses.at(-1), /无法/);
    }
    await context.handleTerminalContextMenuAction({ action: 'split-horizontal', tabId: 'closed', terminalType: 'chart', groupId: group.id });
    assert.match(statuses.at(-1), /无法/);
    assert.equal(statuses.length, 4, 'missing chart/terminal instances must not swallow layout feedback');
    const filter = model.addLeaf(workspace, 'filter', group.id);
    await context.handleTerminalContextMenuAction({ action: 'split-vertical', tabId: filter.id, terminalType: 'filter', groupId: group.id });
    assert.equal(context.workspaceModel.tabs[group.id].panes.length, 2);
    assert.equal(context.workspaceModel.tabs[group.id].paneSplit.orientation, 'vertical');
    assert.match(statuses.at(-1), /已将/);
    await context.handleTerminalContextMenuAction({ action: 'move-to-other-pane', tabId: filter.id, terminalType: 'filter', groupId: group.id });
    assert.equal(actions.at(-1).type, 'move');
    assert.equal(context.workspaceModel.tabs[group.id].panes.length, 1);
    assert.match(statuses.at(-1), /已移动/);
});

test('multi-group move candidates stay inside their owner and exclude root Shells', () => {
    const { workspace, group, mainId } = fixture();
    const filter = model.addLeaf(workspace, 'filter', group.id);
    const split = model.applyWorkspaceAction(workspace, {
        type: 'split-tab', tabId: filter.id, groupId: group.id, paneId: 'other-pane'
    }).workspace;
    const second = model.addContainerTab(split, { id: 'second', mainId: 'second-main' });
    const shell = model.addShell(split);
    assert.equal(model.getOtherPaneTarget(split, shell.id, group.id), null);
    assert.equal(model.getOtherPaneTarget(split, second.panes[0].tabIds[0], group.id), null);
    assert.equal(model.getOtherPaneTarget(split, mainId, group.id).groupId, group.id);
    assert.equal(model.canSplitTab(split, filter.id, second.id), false);
});

test('moving cycles through existing panes without allocating an extra pane', () => {
    const { workspace, group, mainId } = fixture();
    const first = model.addLeaf(workspace, 'filter', group.id);
    const second = model.addLeaf(workspace, 'chart', group.id);
    let current = model.applyWorkspaceAction(workspace, {
        type: 'split-tab', tabId: first.id, groupId: group.id, paneId: 'pane-a'
    }).workspace;
    current = model.applyWorkspaceAction(current, {
        type: 'split-tab', tabId: second.id, groupId: group.id, paneId: 'pane-b'
    }).workspace;
    model.activateTab(current, mainId);
    model.addLeaf(current, 'filter', group.id);
    const ids = current.tabs[group.id].panes.map(pane => pane.id);
    const target = model.getOtherPaneTarget(current, mainId, group.id);
    assert.equal(target.paneId, ids[1]);
    const moved = model.applyWorkspaceAction(current, { type: 'move', tabId: mainId, target });
    assert.equal(moved.ok, true, moved.reason);
    assert.deepEqual(moved.workspace.tabs[group.id].panes.map(pane => pane.id), ids);
    const shell = model.addShell(current);
    assert.equal(model.getOtherPaneTarget(current, shell.id, group.id).paneId, ids[0]);
});
