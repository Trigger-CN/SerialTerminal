'use strict';

const model = require('./tab-model');
const VERSION = 1;
const WORKSPACE_CONFIG_VERSION = 16;
const copy = value => JSON.parse(JSON.stringify(value));
const list = value => Array.isArray(value) ? value : [];
const orientation = value => value === 'vertical' ? 'vertical' : 'horizontal';

// Only layout IDs cross this boundary; terminals, connection state and titles stay in business stores.
function serializeWorkspaceLayout(ws) {
    const groups = Object.values(ws.tabs).filter(model.isContainer).sort((a, b) => a.order - b.order);
    return {
        version: VERSION,
        groups: groups.map(group => ({ id: group.id, order: group.order, collapsed: group.collapsed === true,
            activePaneId: group.activePaneId || group.panes[0]?.id || null,
            panes: group.panes.map(pane => ({ id: pane.id, tabIds: pane.tabIds.slice(), activeTabId: pane.activeTabId })),
            paneSplit: { enabled: group.paneSplit.enabled === true, orientation: orientation(group.paneSplit.orientation),
                sizes: copy(group.paneSplit.sizes || {}) } })),
        roots: model.roots(ws).filter(tab => !model.isContainer(tab)).map(tab => ({ tabId: tab.id, order: tab.order,
            columnId: tab.columnId || null, columnMode: tab.columnMode === 'ownColumn' ? 'ownColumn' : 'row' })),
        focusedTabId: ws.focusedTabId,
        split: copy(ws.split)
    };
}

function restoreWorkspaceLayout(baseline, saved) {
    const ws = copy(baseline);
    model.normalizeSerialOwnership(ws, { discardUnknownOwners: true });
    if (!saved || saved.version !== VERSION) return ws;
    const groups = Object.values(ws.tabs).filter(model.isContainer);
    const groupIds = new Set(groups.map(group => group.id));
    const single = groups.length === 1;
    const claimed = new Set();
    const paneIds = new Set();
    const sourceGroups = list(saved.groups);
    const rootItems = list(saved.roots);
    const rootIds = new Set(rootItems.map(item => item?.tabId));
    const owner = tab => tab.ownerGroupId || tab.parentId;
    const allowed = (id, group) => {
        const tab = ws.tabs[id];
        return tab && !model.isContainer(tab) && !claimed.has(id)
            && (tab.kind === 'shell' ? single : owner(tab) === group.id);
    };
    const uniquePaneId = (id, fallback) => {
        let key = typeof id === 'string' && id ? id : fallback;
        const base = key; let suffix = 2;
        while (paneIds.has(key)) key = `${base}-${suffix++}`;
        paneIds.add(key); return key;
    };
    const groupOrder = new Map(sourceGroups.map((item, index) => [item?.id, index]));
    groups.sort((a, b) => (groupOrder.get(a.id) ?? sourceGroups.length + a.order)
        - (groupOrder.get(b.id) ?? sourceGroups.length + b.order));
    groups.forEach((group, index) => {
        const source = sourceGroups.find(item => item?.id === group.id);
        group.order = Number.isFinite(source?.order) ? source.order : index;
    });
    for (const group of groups) {
        const source = sourceGroups.find(item => item?.id === group.id);
        const original = group.panes;
        const panes = [];
        for (const item of list(source?.panes || original)) {
            if (!item || typeof item !== 'object') continue;
            const tabIds = [];
            for (const id of list(item.tabIds)) {
                if (!allowed(id, group)) continue;
                claimed.add(id); tabIds.push(id);
            }
            if (tabIds.length) panes.push({ id: uniquePaneId(item.id, `${group.id}-pane-1`), tabIds,
                activeTabId: tabIds.includes(item.activeTabId) ? item.activeTabId : tabIds[0] });
        }
        // Missing business leaves are recovered, never synthesized from a corrupt layout ID.
        const missing = Object.values(ws.tabs).filter(tab => !model.isContainer(tab) && !claimed.has(tab.id)
            && (tab.kind === 'shell' ? single && !rootIds.has(tab.id) && baseline.tabs[tab.id]?.parentId === group.id : owner(tab) === group.id));
        if (!panes.length && missing.length) panes.push({ id: uniquePaneId(original[0]?.id, `${group.id}-pane-1`), tabIds: [], activeTabId: null });
        for (const tab of missing) { panes[0].tabIds.push(tab.id); claimed.add(tab.id); }
        if (!panes.length) continue;
        if (!panes[0].activeTabId) panes[0].activeTabId = panes[0].tabIds[0];
        group.panes = panes;
        const split = source?.paneSplit || group.paneSplit;
        group.paneSplit = { enabled: split?.enabled === true && panes.length > 1,
            orientation: orientation(split?.orientation), sizes: split?.enabled === true || Object.keys(split?.sizes || {}).length
                ? model.normalizeSizes(split?.sizes || {}, panes.map(pane => pane.id)) : {} };
        if (!group.paneSplit.enabled && panes.length > 1) {
            panes[0].tabIds = panes.flatMap(pane => pane.tabIds); group.panes = [panes[0]];
            group.paneSplit.sizes = {};
        }
        group.activePaneId = group.panes.some(pane => pane.id === source?.activePaneId) ? source.activePaneId : group.panes[0].id;
        group.collapsed = source?.collapsed === true && group.panes.length > 1;
    }
    const rootOrder = new Map(rootItems.map((item, index) => [item?.tabId, index]));
    for (const tab of Object.values(ws.tabs)) {
        if (model.isContainer(tab) || tab.kind !== 'shell') continue;
        const item = rootItems.find(item => item?.tabId === tab.id);
        if (!claimed.has(tab.id)) {
            tab.parentId = null;
            tab.order = Number.isFinite(item?.order) ? item.order : groups.length + (rootOrder.get(tab.id) ?? rootItems.length);
            tab.columnMode = item?.columnMode === 'ownColumn' ? 'ownColumn' : 'row';
            tab.columnId = item?.columnId == null ? null : groupIds.has(item.columnId) ? item.columnId : groups[0]?.id || null;
        }
        tab.hostGroupId = null; tab.hostPaneId = null;
    }
    ws.split = { enabled: saved.split?.enabled === true, orientation: orientation(saved.split?.orientation), sizes: {} };
    if (ws.split.enabled && Array.isArray(saved.split?.columns)) {
        const used = new Set(); const usedColumns = new Set();
        ws.split.columns = [];
        for (const item of saved.split.columns) {
            const ids = list(item?.groupIds).filter(id => {
                if (!groupIds.has(id) || used.has(id)) return false;
                used.add(id); return true;
            });
            if (!ids.length) continue;
            const id = ids.includes(item.id) && !usedColumns.has(item.id) ? item.id : ids[0];
            usedColumns.add(id); ws.split.columns.push({ id, groupIds: ids });
        }
        const remaining = groups.filter(group => !used.has(group.id)).map(group => group.id);
        if (remaining.length) {
            if (ws.split.columns.length) ws.split.columns[0].groupIds.push(...remaining);
            else ws.split.columns.push({ id: remaining[0], groupIds: remaining });
        }
        ws.split.activeTabs = {};
        for (const column of ws.split.columns) {
            const id = saved.split.activeTabs?.[column.id];
            const tab = ws.tabs[id];
            if (tab && (column.groupIds.includes(id) || column.groupIds.includes(tab.parentId)
                || (tab.kind === 'shell' && tab.columnMode !== 'ownColumn'
                    && (column.groupIds.includes(tab.columnId) || (!tab.columnId && column === ws.split.columns[0]))))) ws.split.activeTabs[column.id] = id;
        }
    }
    model.rebuildIndex(ws);
    ws.focusedTabId = ws.tabs[saved.focusedTabId] ? saved.focusedTabId : groups[0]?.panes[0]?.activeTabId || null;
    const focusedPane = model.paneOfTab(ws, ws.tabs[ws.focusedTabId]);
    if (focusedPane) focusedPane.container.activePaneId = focusedPane.pane.id;
    if (!model.buildRenderPlan(ws).panelIds.includes(ws.focusedTabId)) model.activateTab(ws, ws.focusedTabId);
    const columns = model.layoutColumns(ws);
    ws.split.sizes = ws.split.enabled && Object.keys(saved.split?.sizes || {}).length
        ? model.normalizeSizes(saved.split.sizes, columns.map(column => column.id)) : {};
    return ws;
}

function migrateWorkspaceLayoutConfig(config) {
    const { importWorkspace } = require('./tabs-workspace-projection');
    const sourceGroups = list(config.serialGroups);
    const usedIds = new Set(sourceGroups.flatMap(group => [group.id, group.mainTabId
        || (group.id === 'default' ? 'tab-main' : `tab-main-${String(group.id).replace(/[^A-Za-z0-9_-]/g, '_')}`)]));
    const cleanTabs = entries => list(entries).filter(tab => {
        if (!tab || typeof tab.id !== 'string' || !tab.id.trim() || usedIds.has(tab.id)
            || Object.prototype.hasOwnProperty.call(Object.prototype, tab.id)) return false;
        usedIds.add(tab.id); return true;
    });
    // Reserve Shell identities before serial leaves so a corrupt filter cannot replace a PTY.
    const shellTabs = cleanTabs(config.shellTabs);
    const groups = sourceGroups.map(group => ({ ...group, filterTabs: cleanTabs(group.filterTabs), chartTabs: cleanTabs(group.chartTabs) }));
    const sections = { groups: groups.map(group => ({ ...group, activePaneId: group.paneSplit?.activePaneId,
        panes: group.panes || group.workspaceLayout?.panes })),
        filterTabs: Object.fromEntries(groups.map(group => [group.id, group.filterTabs || []])),
        chartTabs: Object.fromEntries(groups.map(group => [group.id, group.chartTabs || []])),
        shellTabs, focusedTabId: config.workspaceLayoutState?.focusedTabId
            || groups.find(group => group.focusedTabId)?.focusedTabId, split: { enabled: false, orientation: 'horizontal', sizes: {} } };
    const baseline = importWorkspace(sections);
    const defaultGroup = groups.find(group => group.id === 'default');
    return { ...config, serialGroups: groups, shellTabs,
        ...(defaultGroup ? { filterTabs: defaultGroup.filterTabs, chartTabs: defaultGroup.chartTabs } : {}),
        configVersion: WORKSPACE_CONFIG_VERSION, workspaceLayoutState: serializeWorkspaceLayout(restoreWorkspaceLayout(baseline, config.workspaceLayoutState)) };
}

module.exports = { WORKSPACE_CONFIG_VERSION, serializeWorkspaceLayout, restoreWorkspaceLayout, migrateWorkspaceLayoutConfig };
