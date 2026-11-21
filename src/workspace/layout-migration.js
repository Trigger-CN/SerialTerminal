'use strict';

const model = require('./tab-model');
const list = value => Array.isArray(value) ? value : [];
const copy = value => JSON.parse(JSON.stringify(value));

// One-way import. Legacy columns/panes are consumed here, never retained in live state.
function importLegacyLayout(baseline, saved) {
    if (baseline.layout && !saved) return copy(baseline);
    const tabs = copy(baseline.tabs);
    const groups = Object.values(tabs).filter(model.isContainer).sort((a, b) => a.order - b.order);
    const groupSources = list(saved?.groups);
    for (const source of groupSources) {
        const group = tabs[source?.id];
        if (!model.isContainer(group)) continue;
        if (Number.isFinite(source.order)) group.order = source.order;
        group.collapsed = source.collapsed === true;
    }
    groups.sort((a, b) => a.order - b.order);
    const groupData = group => {
        const savedGroup = groupSources.find(item => item?.id === group.id);
        if (savedGroup?.panes) return savedGroup;
        if (!baseline.layout) return group;
        const layout = model.groupLayout(baseline, group.id);
        return { ...group, panes: layout.panes, activePaneId: layout.activePaneId, paneSplit: layout.paneSplit };
    };
    const single = groups.length === 1;
    const ws = { tabs, focusedTabId: saved?.focusedTabId || baseline.focusedTabId,
        layout: { nextId: 1, root: null, mergeOrigins: {} } };
    const id = () => { let value; do { value = `layout-${ws.layout.nextId++}`; } while (Object.hasOwn(tabs, value)); return value; };
    const claimed = new Set();
    const makeStack = (items, active) => ({ id: id(), type: 'stack', items,
        activeItemId: items.some(item => item.id === active) ? active : items[0]?.id || null });
    const branch = (nodes, orientation, sizes, keys) => nodes.length === 1 ? nodes[0]
        : { id: id(), type: 'split', orientation: orientation === 'vertical' ? 'vertical' : 'horizontal', children: nodes,
            weights: model.tree.weights(keys.map(key => sizes?.[key]), nodes.length) };
    const leaf = (tabId, owner) => {
        const tab = tabs[tabId];
        if (!tab || model.isContainer(tab) || claimed.has(tabId)) return null;
        if (tab.kind !== 'shell' && tab.ownerGroupId !== owner) return null;
        if (tab.kind === 'shell' && !single) return null;
        claimed.add(tabId); return { id: tabId, tabId };
    };
    const rootLeaf = tabId => {
        if (!tabs[tabId] || tabs[tabId].kind !== 'shell' || claimed.has(tabId)) return null;
        claimed.add(tabId); return { id: tabId, tabId };
    };
    const contents = (group, paneIds) => {
        const source = groupData(group);
        let panes = list(source.panes).filter(pane => pane && (!paneIds || paneIds.includes(pane.id)));
        if (!source.paneSplit?.enabled && !paneIds) panes = [{ id: panes[0]?.id, tabIds: panes.flatMap(pane => list(pane.tabIds)),
            activeTabId: panes.find(pane => pane.id === source.activePaneId)?.activeTabId || panes[0]?.activeTabId }];
        const nodes = []; const keys = [];
        for (const pane of panes) {
            const items = list(pane.tabIds).map(tabId => leaf(tabId, group.id)).filter(Boolean);
            if (items.length) { nodes.push(makeStack(items, pane.activeTabId)); keys.push(pane.id); }
        }
        if (!nodes.length) return null;
        return branch(nodes, source.paneSplit?.orientation, source.paneSplit?.sizes, keys);
    };
    for (const group of groups) {
        const source = groupData(group);
        for (const pane of list(source.panes)) for (const tabId of list(pane?.tabIds)) {
            const tab = tabs[tabId];
            if (tab && !model.isContainer(tab) && tab.kind !== 'shell' && !tab.ownerGroupId) tab.ownerGroupId = group.id;
        }
    }
    const split = saved?.split || baseline.split || {};
    const savedRoots = new Map(list(saved?.roots).filter(Boolean).map(item => [item.tabId, item]));
    const shells = Object.values(tabs).filter(tab => tab.kind === 'shell').sort((a, b) => {
        const aa = savedRoots.get(a.id); const bb = savedRoots.get(b.id);
        return (aa?.order ?? a.order ?? 0) - (bb?.order ?? b.order ?? 0);
    });
    const placement = tab => savedRoots.get(tab.id) || tab;
    if (single && !split.enabled) {
        ws.layout.root = contents(groups[0]);
        if (!ws.layout.root) ws.layout.root = makeStack([]);
        const home = model.tree.stacks(ws.layout.root)[0];
        shells.forEach(tab => { const item = rootLeaf(tab.id); if (item) home.items.push(item); });
    } else {
        let positions;
        if (split.enabled && Array.isArray(split.columns)) positions = split.columns.filter(Boolean);
        else if (split.enabled) positions = groups.map(group => ({ id: group.id, groupIds: [group.id] }));
        else positions = [{ id: 'legacy-root', groupIds: groups.map(group => group.id) }];
        const own = split.enabled ? shells.filter(tab => placement(tab).columnMode === 'ownColumn') : [];
        if (own.length) {
            const rank = Math.min(...own.map(tab => placement(tab).order ?? tab.order ?? groups.length));
            const index = positions.findIndex(position => Math.min(...list(position.groupIds).map(key => tabs[key]?.order ?? Infinity)) > rank);
            positions.splice(index < 0 ? positions.length : index, 0, { id: '__shell__', groupIds: [] });
        }
        const nodes = []; const keys = [];
        for (const position of positions) {
            const items = [];
            const selected = split.activeTabs?.[position.id];
            const ids = [...new Set([...list(position.groupIds), ...(position.containerId ? [position.containerId] : [])])];
            for (const groupId of ids) {
                const group = tabs[groupId];
                if (!model.isContainer(group)) continue;
                const content = contents(group, position.containerId === groupId ? position.paneIds : undefined);
                if (!content) continue;
                items.push({ id: id(), tabId: groupId, content });
            }
            shells.forEach(tab => {
                const place = placement(tab);
                const here = place.columnMode === 'ownColumn' ? position.id === '__shell__'
                    : !split.enabled || place.columnId === position.id || list(position.groupIds).includes(place.columnId)
                        || (!place.columnId && position === positions[0]);
                if (here) { const item = rootLeaf(tab.id); if (item) items.push(item); }
            });
            items.sort((a, b) => (savedRoots.get(a.tabId)?.order ?? tabs[a.tabId]?.order ?? 0)
                - (savedRoots.get(b.tabId)?.order ?? tabs[b.tabId]?.order ?? 0));
            if (items.length) {
                const active = items.find(item => item.tabId === selected || item.content && model.tree.stacks(item.content).some(node => node.items.some(item => item.tabId === selected)));
                nodes.push(makeStack(items, active?.id)); keys.push(position.id);
            }
        }
        ws.layout.root = nodes.length ? branch(nodes, split.orientation, split.sizes, keys) : makeStack([]);
    }
    for (const group of groups) {
        const missing = Object.values(tabs).filter(tab => !model.isContainer(tab) && tab.kind !== 'shell'
            && tab.ownerGroupId === group.id && !claimed.has(tab.id)).map(tab => { claimed.add(tab.id); return { id: tab.id, tabId: tab.id }; });
        if (!missing.length) continue;
        if (single) model.tree.stacks(ws.layout.root)[0].items.push(...missing);
        else {
            let anchor = model.locateTab(ws, group.id);
            if (!anchor) {
                const root = model.tree.stacks(ws.layout.root)[0];
                const item = { id: id(), tabId: group.id, content: makeStack(missing) };
                root.items.push(item);
            } else model.tree.stacks(anchor.item.content)[0].items.push(...missing);
        }
    }
    const first = model.tree.stacks(ws.layout.root)[0];
    shells.forEach(tab => { const item = rootLeaf(tab.id); if (item) first.items.push(item); });
    if (single) {
        // Old explicit single-group regions are real leaf trees after import, not pane projections.
        const unwrap = node => {
            if (node.type === 'split') { node.children = node.children.map(unwrap); return node; }
            const anchor = node.items.find(item => item.content);
            if (!anchor) return node;
            const destination = model.tree.stacks(anchor.content)[0];
            destination.items.push(...node.items.filter(item => item !== anchor));
            if (node.activeItemId !== anchor.id) destination.activeItemId = node.activeItemId;
            return anchor.content;
        };
        ws.layout.root = unwrap(ws.layout.root);
    }
    for (const tab of Object.values(tabs)) {
        for (const key of ['panes', 'paneSplit', 'activePaneId', 'columnId', 'columnMode', 'hostGroupId', 'hostPaneId', 'detachedColumn', 'topRowColumnId']) delete tab[key];
        tab.parentId = model.isContainer(tab) || tab.kind === 'shell' ? null : tab.ownerGroupId;
    }
    ws.layout.root = model.tree.clean(ws.layout.root);
    if (!model.locateTab(ws, ws.focusedTabId)) ws.focusedTabId = model.tree.stacks(ws.layout.root, true).flatMap(node => node.items).find(item => !item.content)?.tabId;
    for (const group of groups) if (model.groupStacks(ws, group.id).length < 2) group.collapsed = false;
    model.activateTab(ws, ws.focusedTabId);
    const errors = model.validateLayout(ws);
    if (errors.length) throw new Error(`旧布局迁移失败: ${errors.join('; ')}`);
    return ws;
}
module.exports = { importLegacyLayout };
