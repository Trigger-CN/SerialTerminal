'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../tab-model');
const { importWorkspace } = require('../tabs-workspace-projection');
const { groupPaneId, groupWorkspaceRootId, groupSplitterId } = require('../serial-group-layout-dom');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
function section(start, end) {
    const offset = source.indexOf(start);
    const limit = source.indexOf(end, offset);
    assert.ok(offset >= 0 && limit > offset, `Missing renderer section ${start}`);
    return source.slice(offset, limit);
}

function fixture() {
    const nodes = [];
    const listeners = new Map();
    const frames = new Map();
    let frameId = 0;
    class Element {
        constructor(id = '', className = '') {
            this.id = id; this.className = className; this.children = []; this.dataset = {};
            this.hidden = false; this.parentElement = null; this.rect = { left: 0, top: 0, width: 300, height: 300 };
            this.style = { removeProperty(name) { delete this[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]; } };
            this.classList = {
                contains: name => this.className.split(' ').includes(name),
                toggle: (name, on) => { const list = this.className.split(' ').filter(item => item && item !== name); if (on) list.push(name); this.className = list.join(' '); },
                add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false)
            };
            nodes.push(this);
        }
        appendChild(child) { return this.insertBefore(child, null); }
        insertBefore(child, before) {
            if (child === before) return child;
            if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
            const index = before ? this.children.indexOf(before) : this.children.length;
            assert.ok(index >= 0, 'Reference node must be a child');
            this.children.splice(index, 0, child); child.parentElement = this; return child;
        }
        get firstChild() { return this.children[0] || null; }
        get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
        querySelectorAll(selector) {
            const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
            if (selector === '*') return all;
            if (selector === '.workspace-pane') return all.filter(child => child.classList.contains('workspace-pane'));
            if (selector.startsWith('[data-pane-left')) {
                const left = /data-pane-left="([^"]+)"/.exec(selector)?.[1];
                const right = /data-pane-right="([^"]+)"/.exec(selector)?.[1];
                return all.filter(child => child.dataset.paneLeft && (!left || child.dataset.paneLeft === left) && (!right || child.dataset.paneRight === right));
            }
            return [];
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) {
            if (selector === '.workspace-root' && this.classList.contains('workspace-root')) return this;
            if (selector === '[data-group-splitter="pane"]' && this.dataset.groupSplitter === 'pane') return this;
            return this.parentElement?.closest(selector) || null;
        }
        getBoundingClientRect() { return this.classList.contains('workspace-splitter') ? { ...this.rect, width: 10, height: 10 } : this.rect; }
    }
    const get = id => nodes.find(node => node.id === id) || null;
    const root = new Element('workspace-root', 'workspace-root');
    const legacy = new Element('workspace-splitter', 'workspace-splitter'); root.appendChild(legacy);
    const createPane = (id, rootId) => { const pane = new Element(id, 'workspace-pane'); if (rootId) get(rootId).appendChild(pane); return pane; };
    const messages = [];
    const context = vm.createContext({
        workspaceModel: null, tabModel: model, REGISTRY_DEFAULT_GROUP_ID: 'default',
        groupPaneId, groupWorkspaceRootId, groupSplitterId,
        document: { getElementById: get, createElement: () => new Element(),
            addEventListener: (name, callback) => { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); },
            removeEventListener: (name, callback) => listeners.set(name, (listeners.get(name) || []).filter(item => item !== callback)) },
        getPaneDom: get, getGroupTabRow: () => null,
        createPaneElement: createPane, createGroupPaneElement: (_, id) => createPane(id),
        workspaceRootEl: root, workspaceSplitterEl: legacy, isDraggingWorkspaceSplitter: false,
        requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
        fitWorkspaceTerminals: () => {}, persistGroupWorkspaceLayout: id => messages.push(id),
        getGroupWorkspaceManager: id => ({ isSplitEnabled: () => context.workspaceModel.tabs[id].paneSplit.enabled,
            getOrientation: () => context.workspaceModel.tabs[id].paneSplit.orientation }),
        dispatchWorkspaceAction: action => { const result = model.applyWorkspaceAction(context.workspaceModel, action); if (result.ok) context.workspaceModel = result.workspace; return result; }
    });
    vm.runInContext(section('function reconcileRows(', '// ── 第 3 步'), context);
    vm.runInContext(section('function bindWorkspaceSplitter(', '// 分组级分屏的分界条拖动。'), context);
    return { context, root, legacy, get, nodes, messages, createPane, Element,
        run: code => vm.runInContext(code, context),
        emit: (name, event) => (listeners.get(name) || []).slice().forEach(callback => callback({ preventDefault() {}, ...event })) };
}

function singleWorkspace() {
    return importWorkspace({ groups: [{ id: 'default', panes: [
        { id: 'pane-1', tabIds: ['tab-main', 'f1', 'tab-shell-1'], activeTabId: 'tab-main' }
    ] }], filterTabs: { default: [{ id: 'f1' }] }, shellTabs: [{ id: 'tab-shell-1' }], focusedTabId: 'tab-main' });
}

function split(f, tabId, paneId) {
    const result = model.applyWorkspaceAction(f.context.workspaceModel, { type: 'split-tab', tabId, groupId: 'default', paneId });
    assert.equal(result.ok, true, result.reason); f.context.workspaceModel = result.workspace;
}

function render(f) { f.context.plan = model.buildRenderPlan(f.context.workspaceModel); f.run('reconcileRows(plan)'); }

test('production row reconciliation preserves pane nodes, orders N-1 gutters and collapses without empty panes', () => {
    const f = fixture(); f.context.workspaceModel = singleWorkspace();
    const first = f.createPane('pane-1', 'workspace-root');
    const shell = f.createPane('pane-2', 'workspace-root');
    split(f, 'tab-shell-1', 'pane-2'); split(f, 'f1', 'pane-3'); render(f);
    const visible = () => f.root.children.filter(node => !node.hidden);
    assert.deepEqual(visible().map(node => node.id || `${node.dataset.paneLeft}:${node.dataset.paneRight}`),
        ['pane-1', 'pane-1:pane-3', 'pane-3', 'pane-3:pane-2', 'pane-2']);
    const before = visible(); render(f);
    assert.deepEqual(visible(), before);
    assert.equal(f.get('pane-1'), first); assert.equal(f.get('pane-2'), shell);
    assert.equal(f.nodes.filter(node => node.id === 'pane-2').length, 1);
    assert.equal(f.legacy.hidden, true);
    const result = model.applyWorkspaceAction(f.context.workspaceModel, { type: 'pane-split', groupId: 'default', enabled: false });
    f.context.workspaceModel = result.workspace; render(f);
    assert.deepEqual(visible(), [first]);
    assert.equal(first.style.flexBasis, undefined);
});

test('delegated pane splitter resizes only its adjacent pair and persists the owning group', () => {
    const f = fixture(); f.context.workspaceModel = singleWorkspace();
    split(f, 'tab-shell-1', 'pane-2'); split(f, 'f1', 'pane-3'); render(f);
    f.run('bindWorkspaceSplitter()');
    const gutter = f.root.children.find(node => node.dataset.paneLeft === 'pane-3' && !node.hidden);
    f.get('pane-3').rect = { left: 300, top: 0, width: 300, height: 300 };
    f.get('pane-2').rect = { left: 610, top: 0, width: 300, height: 300 };
    f.emit('pointerdown', { target: gutter });
    f.emit('pointermove', { clientX: 720, clientY: 0 });
    f.emit('pointerup', {});
    const sizes = f.context.workspaceModel.tabs.default.paneSplit.sizes;
    assert.ok(Math.abs(sizes['pane-1'] - 1 / 3) < 1e-12);
    assert.ok(Math.abs(sizes['pane-3'] - 0.7 * 2 / 3) < 1e-12);
    assert.ok(Math.abs(sizes['pane-2'] - 0.3 * 2 / 3) < 1e-12);
    assert.deepEqual(f.messages, ['default']);
});

test('moving a shared-column pane reuses its DOM and does not leave duplicate identities', () => {
    const f = fixture(); f.context.workspaceModel = singleWorkspace();
    const otherRoot = new f.Element('workspace-root-g-1', 'workspace-root');
    const pane = f.createPane('pane-1-g-1', 'workspace-root');
    f.context.plan = { tabBarVisible: true, columns: [{ domKey: 'g-1', containerId: 'g-1', rows: [
        { paneId: pane.id, tabs: [], activeTabId: 'tab-main-g-1' }
    ], splitEnabled: false, orientation: 'horizontal', paneSizes: {} }] };
    f.run('reconcileRows(plan)');
    assert.equal(pane.parentElement, otherRoot);
    assert.equal(f.nodes.filter(node => node.id === pane.id).length, 1);
});


test('production fit skips hidden panels and sends final Shell size after dragging stops', () => {
    const frames = []; const sent = []; const fitted = [];
    const panel = (active = true, visible = true, width = 300) => ({
        classList: { contains: () => active }, offsetParent: visible ? {} : null,
        getBoundingClientRect: () => ({ width, height: 200 })
    });
    const panels = new Map([['tab-main', panel()], ['tab-main-g-1', panel(true, false)],
        ['filter', panel(false)], ['chart', panel()], ['shell', panel()], ['zero', panel(true, true, 0)]]);
    const shell = { id: 'shell', term: { cols: 80, rows: 24 }, lastFitCols: 80, lastFitRows: 24,
        fitAddon: { fit() { fitted.push('shell'); shell.term.cols = 42; shell.term.rows = 12; } } };
    const context = vm.createContext({ workspaceFitFrame: null, requestAnimationFrame: fn => (frames.push(fn), frames.length),
        document: { getElementById: id => panels.get(id) }, serialGroups: [{ id: 'default' }, { id: 'g-1' }],
        mainTabId: id => id === 'default' ? 'tab-main' : 'tab-main-g-1',
        serialRuntimes: new Map(['default', 'g-1'].map(id => [id, { fitAddon: { fit: () => fitted.push(id) } }])),
        filterTabsStore: { getList: () => [{ id: 'filter', fitAddon: { fit: () => fitted.push('filter') } }] },
        chartTabsStore: { getList: id => id === 'default' ? [{ id: 'chart', view: { resize: () => fitted.push('chart') } }] : [] },
        shellTabs: [shell, { id: 'zero', fitAddon: { fit: () => fitted.push('zero') } }],
        isDraggingWorkspaceSplitter: true, ipcRenderer: { send: (channel, payload) => sent.push({ channel, ...payload }) }
    });
    vm.runInContext(section('function fitWorkspaceTerminals(', 'function getPaneById('), context);
    const fit = () => { vm.runInContext('fitWorkspaceTerminals(); fitWorkspaceTerminals()', context); assert.equal(frames.length, 1); frames.shift()(); };
    fit(); assert.deepEqual(fitted, ['default', 'chart', 'shell']); assert.equal(sent.length, 0);
    context.isDraggingWorkspaceSplitter = false; fit();
    assert.deepEqual(sent, [{ channel: 'resize-shell-tab', tabId: 'shell', cols: 42, rows: 12 }]);
    fit(); assert.equal(sent.length, 1);
});

test('production drag completion shares atomic move admission and ignores missing drop targets', () => {
    const f = fixture(); const saved = [];
    f.context.workspaceModel = singleWorkspace(); split(f, 'tab-shell-1', 'pane-2');
    Object.assign(f.context, { serialGroups: [{ id: 'default' }], performance: { now: () => 100 },
        persistGroupWorkspaceLayout: id => saved.push(id), persistShellTabs: () => saved.push('shell') });
    f.run(section('function finishWorkspaceTabDrag(', '// 跨分组移动标签必须走'));
    const button = { classList: { remove() {} }, dataset: {} };
    const drag = target => { f.context.drag = { tabId: 'tab-shell-1', tabButton: button, dragging: true, ...target }; f.run('finishWorkspaceTabDrag(drag)'); };
    const original = f.context.workspaceModel;
    drag({ targetPaneId: null, insertionIndex: null });
    assert.equal(f.context.workspaceModel, original); assert.equal(saved.length, 0);
    drag({ targetGroupId: 'default', targetPaneId: 'pane-1', insertionIndex: 1 });
    assert.ok(f.context.workspaceModel.tabs.default.panes[0].tabIds.includes('tab-shell-1'));
    assert.deepEqual(saved, ['default', 'shell']); assert.equal(button.dataset.suppressClickUntil, '400');
    const added = model.applyWorkspaceAction(f.context.workspaceModel, { type: 'add-group', options: { id: 'g-1', groupId: 'g-1', mainId: 'tab-main-g-1', paneIds: ['pane-1-g-1'] } });
    assert.equal(added.ok, true); assert.ok(added.workspace.tabs['g-1']); f.context.workspaceModel = added.workspace;
    const beforeRejected = f.context.workspaceModel; saved.length = 0;
    drag({ targetGroupId: 'g-1', targetPaneId: 'pane-1-g-1', insertionIndex: 0 });
    assert.equal(f.context.workspaceModel, beforeRejected); assert.equal(saved.length, 0);
});

test('production close-group-split menu reads Shell placement from the active model', async () => {
    const ws = singleWorkspace();
    const added = model.applyWorkspaceAction(ws, { type: 'add-group', options: { id: 'g-1', groupId: 'g-1', mainId: 'tab-main-g-1', paneIds: ['pane-1-g-1'] } });
    assert.equal(added.ok, true); assert.ok(added.workspace.tabs['g-1']);
    const placed = model.applyWorkspaceAction(added.workspace, { type: 'shell-placement', tabId: 'tab-shell-1', placement: { columnMode: 'ownColumn' } });
    assert.equal(placed.ok, true);
    const context = vm.createContext({ workspaceModel: placed.workspace, activeGroupId: 'default', shellTabs: [{ id: 'tab-shell-1', columnMode: 'row' }],
        resolveSerialGroupId: id => id, setActionStatus: () => {}, filterTabsStore: {}, chartTabsStore: {},
        setShellColumnModeInModel: (tabId, columnMode) => {
            const result = model.applyWorkspaceAction(context.workspaceModel, { type: 'shell-placement', tabId, placement: { columnMode } });
            assert.equal(result.ok, true); context.workspaceModel = result.workspace;
        }, setGroupWorkspaceSplit: enabled => { context.workspaceModel = model.applyWorkspaceAction(context.workspaceModel, { type: 'column-split', enabled }).workspace; }
    });
    const start = source.indexOf('async function handleTerminalContextMenuAction(');
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(end > start); vm.runInContext(source.slice(start, end), context);
    await vm.runInContext("handleTerminalContextMenuAction({action:'close-group-split',terminalType:'group',groupId:'default'})", context);
    assert.equal(context.workspaceModel.tabs['tab-shell-1'].columnMode, 'row');
    assert.equal(model.layoutColumns(context.workspaceModel).length, 1);
});


test('production button ordering converges in one pass for every four-tab permutation', () => {
    const f = fixture();
    f.run(section('function orderButtons(', '// ── 第 4 步'));
    const list = new f.Element('tabs');
    const buttons = ['main', 'filter', 'chart', 'shell'].map(id => new f.Element(id));
    Object.defineProperty(f.Element.prototype, 'nextElementSibling', { get() { return this.nextSibling; } });
    const permutations = items => items.length ? items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map(tail => [item, ...tail])) : [[]];
    for (const order of permutations(buttons)) {
        order.forEach(button => list.appendChild(button));
        f.context.list = list; f.context.buttons = buttons;
        f.run('orderButtons(list, buttons)');
        assert.deepEqual(list.children, buttons, order.map(button => button.id).join(','));
    }
});

test('production root reconciliation restores mixed group and Shell order after merging columns', () => {
    const f = fixture();
    const list = new f.Element('root-tabs');
    const buttons = ['g1', 'g2', 'shell1', 'shell2'].map(id => new f.Element(id));
    buttons.forEach(button => list.appendChild(button));
    Object.defineProperty(f.Element.prototype, 'nextElementSibling', { get() { return this.nextSibling; } });
    const byId = new Map(buttons.map(button => [button.id, button]));
    Object.assign(f.context, { activeGroupId: 'g1', serialGroups: [{ id: 'g1' }, { id: 'g2' }],
        getGroupTabList: () => list, getSerialGroupById: () => ({}),
        describeGroupTab: group => ({ buttonId: group.id }), updateGroupTabButtonState() {},
        getPaneTabsList: () => null, syncSerialGroupAddButtonLayer() {}, syncShellAddButtonVisibility() {}, placeGroupAddButton() {}, placeShellAddButton() {} });
    f.context.document.querySelector = selector => byId.get(/data-target="([^"]+)"/.exec(selector)?.[1]);
    f.context.document.querySelectorAll = () => [];
    f.context.plan = { tabBarVisible: true, columns: [{ domKey: 'g1', rows: [],
        tabItems: [{ id: 'g1', panes: [] }, { id: 'shell1' }, { id: 'g2', panes: [] }, { id: 'shell2' }] }] };
    f.run(section('function reconcileButtons(', '// ── 第 4 步'));
    f.run('reconcileButtons(plan)');
    assert.deepEqual(list.children.map(button => button.id), ['g1', 'shell1', 'g2', 'shell2']);
});

test('delegated content activation follows main/filter/chart owner and preserves other panes and Shell placement', () => {
    const f = fixture();
    f.context.workspaceModel = importWorkspace({ groups: [
        { id: 'default', panes: [{ id: 'pane-1', tabIds: ['tab-main'], activeTabId: 'tab-main' }] },
        { id: 'g-1', panes: [{ id: 'pane-1-g-1', tabIds: ['tab-main-g-1', 'f2', 'c2'], activeTabId: 'tab-main-g-1' }] }
    ], filterTabs: { 'g-1': [{ id: 'f2' }] }, chartTabs: { 'g-1': [{ id: 'c2' }] }, shellTabs: [{ id: 'tab-shell-1' }], focusedTabId: 'tab-main' });
    f.context.workspaceModel = model.applyWorkspaceAction(f.context.workspaceModel, { type: 'split-group', groupId: 'g-1' }).workspace;
    const shell = JSON.stringify(f.context.workspaceModel.tabs['tab-shell-1']);
    const synced = [];
    Object.assign(f.context, { activeGroupId: 'default',
        groupIdForWorkspaceTab: id => f.context.workspaceModel.tabs[id]?.ownerGroupId || null,
        setFocusedTab: id => f.context.dispatchWorkspaceAction({ type: 'activate', tabId: id }).ok,
        resolveSerialGroupId: id => id, serialGroupRegistry: { setActiveGroup: id => synced.push(id) },
        setActiveGroupTabLists() {}, setActiveGroupWorkspace() {}, mainTabId: id => `tab-main-${id}`,
        getGroupWorkspaceManager: () => ({ getActiveTabId: () => 'tab-main', switchPaneTab() { assert.fail('content focus must not switch another tab'); } }),
        renderSerialGroupTabBar() {}, applyGroupSerialOptionsToSidebar: id => synced.push(`options:${id}`),
        syncDisplayPrefCheckboxes() {}, getGroupDisplayPrefs: () => ({}), updateSidebarActiveGroupLabel() {},
        refreshConnectButtonState() {}, updateFilterModeStatuses() {},
        // applyActiveSerialGroup 现在通过该函数同步分组标签的 active/control 样式；
        // 本用例断言的是内容区激活链路，标签样式不在范围内，注入空实现即可。
        syncGroupTabVisualState() {} });
    f.context.document.querySelectorAll = () => [];
    f.run(section('function applyActiveSerialGroup(', '// 更新侧栏顶部'));
    f.run(section('function bindWorkspaceContentActivation(', 'window.addEventListener(\'main-tab-changed\''));
    f.run('bindWorkspaceContentActivation()');
    for (const id of ['tab-main-g-1', 'f2', 'c2', 'tab-main']) {
        f.context.activeGroupId = id === 'tab-main' ? 'g-1' : 'default';
        const panel = { id, classList: { contains: () => true } };
        const target = { closest: selector => selector === '.main-tab-pane' ? panel : null };
        f.emit(id === 'f2' ? 'focusin' : 'click', { target });
        assert.equal(f.context.activeGroupId, id === 'tab-main' ? 'default' : 'g-1');
        assert.equal(f.context.workspaceModel.focusedTabId, id);
        assert.equal(f.context.workspaceModel.tabs.default.panes[0].activeTabId, 'tab-main');
        assert.equal(JSON.stringify(f.context.workspaceModel.tabs['tab-shell-1']), shell);
        assert.equal(model.buildRenderPlan(f.context.workspaceModel).columns.length, 2);
    }
    assert.deepEqual(synced, ['g-1', 'options:g-1', 'g-1', 'options:g-1', 'g-1', 'options:g-1', 'default', 'options:default']);
    const beforeShell = f.context.activeGroupId;
    f.emit('click', { target: { closest: () => ({ id: 'tab-shell-1', classList: { contains: () => true } }) } });
    assert.equal(f.context.activeGroupId, beforeShell, 'Shell keeps the previous serial control target');
});


test('production Shell drag places the root-row indicator at the actual pointer position', () => {
    const { getHorizontalInsertionIndex } = require('../tab-reorder');
    const f = fixture();
    const list = new f.Element('roots');
    const tabs = ['group', 'shell-a', 'shell-b'].map((id, i) => {
        const tab = new f.Element(id); tab.rect = { left: i * 100, width: 100 }; list.appendChild(tab); return tab;
    });
    list.querySelectorAll = () => tabs;
    const row = { querySelector: () => list };
    Object.assign(f.context, { getGroupRowDropTarget: () => ({ row, groupId: 'default' }), getHorizontalInsertionIndex,
        window: { innerWidth: 1000, innerHeight: 600 },
        state: { dragging: true, isShell: true, tabButton: tabs[1], preview: { style: {}, offsetWidth: 80, offsetHeight: 20 }, indicator: { remove() {} } } });
    f.run(section('function updateWorkspaceTabDrag(', 'function startWorkspaceTabDrag('));
    f.run('updateWorkspaceTabDrag(state, 275, 20)');
    assert.equal(f.context.state.insertionIndex, 2);
    assert.equal(list.children.at(-1), f.context.state.indicator);
    f.run('updateWorkspaceTabDrag(state, 10, 20)');
    assert.equal(f.context.state.insertionIndex, 0);
    assert.equal(list.children[0], f.context.state.indicator);
});
