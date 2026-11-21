'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { model, codec, fixture: business, act, regions } = require('./workspace-tree-fixture');
const { createDom } = require('./workspace-dom-fixture');
const { createLayoutRenderer } = require('../src/workspace/layout-renderer');
const { getHorizontalInsertionIndex } = require('../src/workspace/tab-reorder');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
function section(start, end) {
    const offset = source.indexOf(start), limit = source.indexOf(end, offset);
    assert.ok(offset >= 0 && limit > offset, `Missing renderer section ${start}`); return source.slice(offset, limit);
}
function fn(name) { const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start) + 2; assert.ok(start >= 0 && end > start); return source.slice(start, end); }
function fixture(multiple = false) {
    const dom = createDom(), saved = [], synced = [];
    const context = vm.createContext({ ...dom, workspaceModel: business(multiple), tabModel: model, createLayoutRenderer,
        GROUP_WORKSPACE_CONTAINER_ID: 'group-workspace', REGISTRY_DEFAULT_GROUP_ID: 'default', activeGroupId: 'default',
        serialGroups: [{ id: 'default' }, ...(multiple ? [{ id: 'b' }, { id: 'c' }] : [])],
        isRenderingWorkspace: false, layoutRenderer: null, isDraggingWorkspaceSplitter: false,
        resolveSerialGroupId: id => id, getSerialGroupById: id => ({ id }), resolveGroupTitleForDisplay: group => group.id,
        isGroupConnected: () => false, describeGroupTab: group => group, updateGroupTabButtonState() {},
        buildGroupTabButton: info => { const button = new dom.Element('main-tab serial-group-tab', info.buttonId); button.dataset.groupId = info.id; return button; },
        bindPaneTabListEvents() {}, tr: value => value, createMaterialIcon: () => new dom.Element('icon'), getDefaultShellProfileId: () => '',
        getHorizontalInsertionIndex, performance: { now: () => 100 }, fitWorkspaceTerminals: () => saved.push('fit'),
        persistGroupWorkspaceLayout: id => saved.push(id), persistShellTabs: () => saved.push('shell'),
        requestWorkspaceTabContextMenu: payload => saved.push(payload), setActionStatus() {},
        serialGroupRegistry: { setActiveGroup: id => synced.push(id) }, setActiveGroupTabLists() {}, setActiveGroupWorkspace() {},
        mainTabId: id => id === 'default' ? 'tab-main' : `tab-main-${id}`,
        getGroupWorkspaceManager: id => ({ getActiveTabId: () => model.groupLayout(context.workspaceModel, id).panes[0].activeTabId }),
        renderSerialGroupTabBar() {}, applyGroupSerialOptionsToSidebar: id => synced.push(`options:${id}`), syncDisplayPrefCheckboxes() {},
        getGroupDisplayPrefs: () => ({}), updateSidebarActiveGroupLabel() {}, refreshConnectButtonState() {}, updateFilterModeStatuses() {}
    });
    function mount(id) {
        const button = new dom.Element('main-tab', `${id}-button`); button.dataset.target = id;
        const panel = new dom.Element('main-tab-pane', id); panel.terminal = {}; panel.pty = {}; dom.host.append(button, panel); return { button, panel };
    }
    Object.values(context.workspaceModel.tabs).filter(tab => !model.isContainer(tab)).forEach(tab => mount(tab.id));
    context.dispatchWorkspaceAction = action => {
        const result = model.applyWorkspaceAction(context.workspaceModel, action);
        if (result.ok) { context.workspaceModel = result.workspace; context.renderWorkspace(result.workspace); } return result;
    };
    context.setFocusedTab = tabId => context.dispatchWorkspaceAction({ type: 'activate', tabId }).ok;
    const create = (kind, paneId) => { const id = `new-${kind}`; mount(id);
        return context.dispatchWorkspaceAction({ type: 'add-leaf', groupId: context.groupIdFromPaneId(paneId) || context.activeGroupId, paneId, options: { id, kind } }); };
    context.createShellTab = (_, paneId) => create('shell', paneId); context.createFilterTab = (_, paneId) => create('filter', paneId);
    context.createChartTab = (_, paneId) => create('chart', paneId); context.addSerialGroupFromUi = () => saved.push('add-group');
    for (const name of ['groupIdFromPaneId', 'groupIdForWorkspaceTab', 'createGroupPaneElement', 'renderWorkspace', 'getWorkspaceTabDropTarget', 'updateWorkspaceTabDrag', 'finishWorkspaceTabDrag']) vm.runInContext(fn(name), context);
    vm.runInContext(section('const PANE_ACTION_BUTTON_SPECS', 'function fillPaneActionButtons('), context);
    return { ...dom, context, saved, synced, mount, render: () => context.renderWorkspace(context.workspaceModel),
        act: action => { const result = context.dispatchWorkspaceAction(action); assert.equal(result.ok, true, result.reason); return result; },
        read: () => context.workspaceModel, run: code => vm.runInContext(code, context) };
}
test('production recursive render preserves nested axes, resources, stable nodes and N-1 gutters', () => {
    const f = fixture(); f.render(); const main = f.document.getElementById('tab-main'), term = main.terminal;
    f.act({ type: 'split-tab', tabId: 'tab-shell-1' }); f.act({ type: 'split-tab', tabId: 'f1', direction: 'bottom' });
    const stacks = f.host.querySelectorAll('.layout-stack'); f.render();
    assert.deepEqual(f.host.querySelectorAll('.layout-stack'), stacks);
    assert.equal(f.host.querySelectorAll('.layout-gutter').length, 2);
    assert.deepEqual(new Set(f.host.querySelectorAll('.layout-split').map(node => node.dataset.orientation)), new Set(['horizontal', 'vertical']));
    assert.equal(f.document.getElementById('tab-main'), main); assert.equal(main.terminal, term);
    f.act({ type: 'collapse-all' }); assert.equal(f.host.querySelectorAll('.layout-stack').length, 1);
    assert.equal(f.host.querySelectorAll('.layout-gutter').length, 0);
});
test('production gutter dispatches a real adjacent resize and final fit after release', () => {
    const f = fixture(); f.act({ type: 'split-tab', tabId: 'tab-shell-1' }); f.act({ type: 'split-tab', tabId: 'f1', direction: 'bottom' });
    const outer = f.read().layout.root, inner = outer.children[0], before = structuredClone(outer.weights);
    const bar = f.host.querySelectorAll('.layout-gutter').find(node => node.dataset.splitNodeId === inner.id);
    bar.emit('pointerdown', { button: 0, clientY: 200 }); f.emit('pointermove', { clientY: 240 }); f.flush();
    assert.deepEqual(f.read().layout.root.weights, before); assert.notDeepEqual(model.tree.find(f.read().layout.root, inner.id).node.weights, inner.weights);
    f.emit('pointerup', {}); assert.equal(f.context.isDraggingWorkspaceSplitter, false); assert.equal(f.saved.at(-1), 'fit');
});
test('production group moves reuse content and restore all business nodes after anchor disposal', () => {
    const f = fixture(true); f.render(); const panel = f.document.getElementById('tab-main-b'), term = panel.terminal;
    f.act({ type: 'split-group', groupId: 'b' }); f.act({ type: 'merge', groupId: 'b' });
    assert.equal(f.document.getElementById('tab-main-b'), panel); assert.equal(panel.terminal, term);
    f.act({ type: 'remove-group', groupId: 'b' }); f.act({ type: 'remove-group', groupId: 'c' });
    assert.equal(f.host.querySelectorAll('.serial-group-tab').length, 0);
    assert.equal(f.host.querySelectorAll('.main-tab-pane').filter(node => node.id === 'tab-main').length, 1);
});
test('production fit skips hidden panels and sends final Shell size after dragging stops', () => {
    const frames = [], sent = [], fitted = [];
    const panel = (active = true, visible = true, width = 300) => ({ classList: { contains: () => active }, offsetParent: visible ? {} : null, getBoundingClientRect: () => ({ width, height: 200 }) });
    const panels = new Map([['tab-main', panel()], ['tab-main-b', panel(true, false)], ['filter', panel(false)], ['chart', panel()], ['shell', panel()], ['zero', panel(true, true, 0)]]);
    const shell = { id: 'shell', term: { cols: 80, rows: 24 }, lastFitCols: 80, lastFitRows: 24, fitAddon: { fit() { fitted.push('shell'); shell.term.cols = 42; shell.term.rows = 12; } } };
    const context = vm.createContext({ workspaceFitFrame: null, requestAnimationFrame: callback => (frames.push(callback), frames.length), document: { getElementById: id => panels.get(id) },
        serialGroups: [{ id: 'default' }, { id: 'b' }], mainTabId: id => id === 'default' ? 'tab-main' : 'tab-main-b',
        serialRuntimes: new Map(['default', 'b'].map(id => [id, { fitAddon: { fit: () => fitted.push(id) } }])),
        filterTabsStore: { getList: () => [{ id: 'filter', fitAddon: { fit: () => fitted.push('filter') } }] },
        chartTabsStore: { getList: id => id === 'default' ? [{ id: 'chart', view: { resize: () => fitted.push('chart') } }] : [] },
        shellTabs: [shell, { id: 'zero', fitAddon: { fit: () => fitted.push('zero') } }], isDraggingWorkspaceSplitter: true,
        ipcRenderer: { send: (channel, payload) => sent.push({ channel, ...payload }) } });
    vm.runInContext(fn('fitWorkspaceTerminals'), context);
    const fit = () => { vm.runInContext('fitWorkspaceTerminals(); fitWorkspaceTerminals()', context); assert.equal(frames.length, 1); frames.shift()(); };
    fit(); assert.deepEqual(fitted, ['default', 'chart', 'shell']); assert.equal(sent.length, 0);
    context.isDraggingWorkspaceSplitter = false; fit();
    assert.deepEqual(sent, [{ channel: 'resize-shell-tab', tabId: 'shell', cols: 42, rows: 12 }]); fit(); assert.equal(sent.length, 1);
});
test('production drag completion moves only to an existing admitted Stack and ignores stale targets', () => {
    const f = fixture(); f.act({ type: 'split-tab', tabId: 'tab-shell-1' });
    const button = f.document.querySelector('.main-tab[data-target="tab-shell-1"]');
    const drag = targetNodeId => { f.context.finishWorkspaceTabDrag({ tabId: 'tab-shell-1', tabButton: button, dragging: true, targetNodeId, insertionIndex: 1 }); };
    const before = f.read(); drag(null); drag('missing'); assert.equal(f.read(), before);
    const target = model.locateTab(f.read(), 'tab-main').stack.id; drag(target);
    assert.equal(model.locateTab(f.read(), 'tab-shell-1').stack.id, target); assert.equal(button.dataset.suppressClickUntil, '400');
    f.act({ type: 'add-group', options: { id: 'b', mainId: 'mb' } });
    const prior = f.read(); drag(model.locateTab(prior, 'mb').stack.id); assert.equal(f.read(), prior);
});
test('production local group merge leaves independent Shell region, resources and selection unchanged', async () => {
    const f = fixture(true); f.act({ type: 'split-group', groupId: 'b' });
    f.act({ type: 'split', source: { tabId: 'tab-shell-1' }, target: { nodeId: model.locateTab(f.read(), 'b').stack.id }, direction: 'right' });
    const shell = structuredClone(model.locateTab(f.read(), 'tab-shell-1').stack), rect = regions(f.read())['tab-shell-1'];
    vm.runInContext(section('async function handleTerminalContextMenuAction(', '\nfunction '), f.context);
    await f.context.handleTerminalContextMenuAction({ action: 'close-group-split', terminalType: 'group', groupId: 'b' });
    assert.deepEqual(model.locateTab(f.read(), 'tab-shell-1').stack, shell); assert.deepEqual(regions(f.read())['tab-shell-1'], rect);
    assert.ok(f.read().tabs.b); assert.equal(model.tree.stacks(f.read().layout.root).length, 2);
});
test('production ordering converges in one pass for all four-tab permutations', () => {
    const f = fixture(); f.render(); const list = f.host.querySelector('.pane-tabs-list'), buttons = list.children.slice();
    const first = buttons.slice(0, 4), rest = buttons.slice(4);
    const permutations = items => items.length ? items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map(tail => [item, ...tail])) : [[]];
    for (const order of permutations(first)) { [...order, ...rest].forEach(button => list.appendChild(button)); f.render(); assert.deepEqual(list.children, buttons); }
});
test('production root reconciliation keeps interleaved group/Shell order after local merge', () => {
    const f = fixture(true); f.render(); const root = model.locateTab(f.read(), 'b').stack.id;
    f.act({ type: 'move', tabId: 'tab-shell-1', target: { nodeId: root, index: 1 } });
    f.act({ type: 'split-group', groupId: 'b' }); f.act({ type: 'merge', groupId: 'b' });
    const list = f.document.getElementById(root).querySelector('.pane-tabs-list');
    assert.deepEqual(list.children.map(button => button.dataset.target || button.dataset.groupId), f.read().layout.root.items.map(item => item.tabId));
});
test('delegated visible-content activation updates sidebar owner for main/filter/chart and preserves Shell placement', () => {
    const f = fixture(true); f.act({ type: 'split-group', groupId: 'c' });
    f.mount('chart-c'); f.act({ type: 'add-leaf', groupId: 'c', options: { id: 'chart-c', kind: 'chart' } });
    vm.runInContext(fn('applyActiveSerialGroup'), f.context); vm.runInContext(fn('bindWorkspaceContentActivation'), f.context); f.context.bindWorkspaceContentActivation();
    const shell = structuredClone(model.locateTab(f.read(), 'tab-shell-1').stack);
    for (const id of ['tab-main-c', 'fc', 'chart-c', 'tab-main']) {
        f.act({ type: 'activate', tabId: id }); f.context.activeGroupId = id === 'tab-main' ? 'c' : 'default';
        const panel = f.document.getElementById(id); f.emit(id === 'fc' ? 'focusin' : 'click', { target: panel });
        assert.equal(f.context.activeGroupId, id === 'tab-main' ? 'default' : 'c'); assert.equal(f.read().focusedTabId, id);
    }
    assert.deepEqual(model.locateTab(f.read(), 'tab-shell-1').stack.items, shell.items);
    const control = f.context.activeGroupId; f.act({ type: 'activate', tabId: 'tab-shell-1' });
    f.emit('click', { target: f.document.getElementById('tab-shell-1') }); assert.equal(f.context.activeGroupId, control);
});
test('production drag preview uses pointer insertion and the same admission as final completion', () => {
    const f = fixture(); f.render(); const list = f.host.querySelector('.pane-tabs-list');
    list.rect = { left: 0, right: 500, top: 0, bottom: 30, width: 500, height: 30 };
    list.children.forEach((button, index) => { button.rect = { left: index * 100, width: 100 }; });
    const button = list.children[3], indicator = new f.Element('indicator'), state = { tabId: button.dataset.target, tabButton: button, dragging: true, indicator, preview: new f.Element('preview') };
    const before = f.read(); f.context.updateWorkspaceTabDrag(state, 490, 15); assert.equal(f.read(), before);
    assert.equal(state.insertionIndex, 4); assert.equal(list.children.at(-1), indicator);
    f.context.updateWorkspaceTabDrag(state, 0, 15); assert.equal(state.insertionIndex, 0); assert.equal(list.children[0], indicator);
    f.context.finishWorkspaceTabDrag(state); assert.equal(f.read().layout.root.items[0].tabId, button.dataset.target);
});
test('single/multi production rendering keeps panel/button/PTY identity across transitions', () => {
    const f = fixture(); f.act({ type: 'split-tab', tabId: 'tab-shell-1', direction: 'bottom' });
    const panel = f.document.getElementById('tab-shell-1'), button = f.document.querySelector('.main-tab[data-target="tab-shell-1"]'), pty = panel.pty;
    f.mount('mb'); f.act({ type: 'add-group', options: { id: 'b', mainId: 'mb' } });
    f.act({ type: 'remove-group', groupId: 'b' });
    assert.equal(f.document.getElementById('tab-shell-1'), panel); assert.equal(panel.pty, pty); assert.equal(f.document.querySelector('.main-tab[data-target="tab-shell-1"]'), button);
    assert.equal(f.host.querySelectorAll('.main-tab-pane').filter(node => node.id === 'tab-shell-1').length, 1);
});
test('all root/sub creation controls use common construction and route to clicked region owner', () => {
    const f = fixture(true); f.act({ type: 'split-group', groupId: 'c' }); f.context.activeGroupId = 'default';
    const stackId = model.locateTab(f.read(), 'fc').stack.id, pane = f.document.getElementById(stackId);
    const rootActions = f.host.querySelector('.pane-tab-actions'), actions = pane.querySelector('.pane-tab-actions');
    assert.deepEqual(rootActions.children.map(button => button.className), actions.children.map(button => button.className));
    assert.equal(actions.children.length, 4);
    actions.children.find(button => button.id.includes('new-filter')).emit('click');
    assert.equal(f.read().tabs['new-filter'].ownerGroupId, 'c'); assert.equal(model.locateTab(f.read(), 'new-filter').stack.id, stackId);
    actions.children.find(button => button.id.includes('new-shell')).emit('click');
    assert.equal(model.locateTab(f.read(), 'new-shell').stack.id, model.rootStackOf(f.read(), model.locateTab(f.read(), 'fc')).id);
});
test('business DOM exists before one-time import and later config echoes cannot replace live model', () => {
    const f = fixture(); f.context.workspaceModel = null;
    Object.assign(f.context, { currentConfig: {}, focusedWorkspaceTabId: 'tab-main', importWorkspace, decodeWorkspaceLayout: codec.restoreWorkspaceLayout,
        groupWorkspaceLayouts: new Map(), groupLayoutSnapshots: new Map(), groupWorkspaceManagers: new Map(),
        filterTabsStore: { getList: () => [{ id: 'f1' }, { id: 'f2' }] }, chartTabsStore: { getList: () => [] },
        shellTabs: [{ id: 'tab-shell-1' }, { id: 'tab-shell-2' }], focusedTabIdForProjection: () => 'tab-main',
        renderWorkspaceNow: () => f.render() });
    vm.runInContext(fn('buildLiveWorkspaceSections'), f.context); vm.runInContext(fn('initializeWorkspaceModel'), f.context);
    const panel = f.document.getElementById('tab-shell-1'); assert.equal(f.context.initializeWorkspaceModel(), true);
    const ws = f.read(); assert.equal(f.document.getElementById('tab-shell-1'), panel);
    f.context.currentConfig.workspaceLayoutState = { version: 99 }; assert.equal(f.context.initializeWorkspaceModel(), false); assert.equal(f.read(), ws);
});

test('actual business registration and activation honor a clicked root region instead of manager fallback', () => {
    const f = fixture(true); f.act({ type: 'split-group', groupId: 'c' });
    const rootId = model.locateTab(f.read(), 'c').stack.id;
    f.context.activeGroupId = 'default';
    f.context.resolveGroupIdFromPaneId = paneId => f.context.groupIdFromPaneId(paneId) || 'default';
    f.context.describeWorkspaceBusinessTab = id => ({ id, kind: 'filter' });
    f.context.getGroupWorkspaceManager = () => assert.fail('live registration must use the explicit tree target');
    vm.runInContext(fn('addTabToOwningGroupPane'), f.context);
    vm.runInContext(fn('switchPaneTab'), f.context);
    f.mount('created-on-root');
    const paneId = f.context.addTabToOwningGroupPane('created-on-root', rootId, { activate: false });
    assert.equal(paneId, model.locateTab(f.read(), 'tab-main-c').stack.id);
    assert.equal(f.read().tabs['created-on-root'].ownerGroupId, 'c');
    assert.equal(f.context.switchPaneTab(rootId, 'created-on-root'), true);
    assert.equal(f.read().focusedTabId, 'created-on-root');
    assert.ok(model.buildRenderPlan(f.read()).panelIds.includes('created-on-root'));
});

test('read-only production diagnostics follow real tree rows instead of removed group-column geometry', () => {
    const f = fixture(true); f.act({ type: 'split-group', groupId: 'b' });
    f.act({ type: 'split-tab', tabId: 'tab-shell-1' });
    Object.assign(f.context, { window: {}, buildLiveWorkspace: () => f.read(), buildLiveWorkspaceSections: () => ({ groups: [] }) });
    vm.runInContext(section('window.__readTabModelPlan =', '\n};') + '\n};', f.context);
    const before = JSON.stringify(f.read()), result = f.context.window.__readTabModelPlan();
    assert.deepEqual(Array.from(result.containerIds), ['default', 'b', 'c']);
    assert.equal(result.live.visibleColumns.length, model.tree.stacks(f.read().layout.root, true).filter(node => {
        const item = node.items.find(item => item.id === node.activeItemId);
        return item && (!model.tree.find(f.read().layout.root, node.id).scope || model.buildRenderPlan(f.read()).panelIds.includes(item.tabId));
    }).length);
    assert.deepEqual(Array.from(result.live.groupRowShellTabs), ['tab-shell-2', 'tab-shell-1']);
    assert.equal(JSON.stringify(f.read()), before);
});
