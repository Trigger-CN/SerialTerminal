'use strict';
const model = require('./tab-model');
const tree = require('./layout-tree');
const copy = value => JSON.parse(JSON.stringify(value));

// Disk input is untrusted; repair locations against the existing business inventory only.
function recoverLayout(baseline, saved) {
    const ws = copy(baseline);
    const groups = Object.values(ws.tabs).filter(model.isContainer);
    const groupIds = new Set(groups.map(group => group.id));
    for (const tab of Object.values(ws.tabs)) {
        if (model.isContainer(tab) || tab.kind === 'shell') continue;
        if (!tab.ownerGroupId) tab.ownerGroupId = groupIds.has(tab.parentId) ? tab.parentId : groups.length === 1 ? groups[0].id : null;
        if (!groupIds.has(tab.ownerGroupId)) delete ws.tabs[tab.id];
    }
    const multiple = groups.length > 1;
    const raw = saved?.layout;
    let next = Number.isSafeInteger(raw?.nextId) && raw.nextId > 0 && raw.nextId < Number.MAX_SAFE_INTEGER ? raw.nextId : 1;
    const reserve = (node, depth = 0) => {
        if (!node || depth > 64) return;
        for (const id of [node.id, ...(Array.isArray(node.items) ? node.items.map(item => item?.id) : [])]) {
            const n = /^layout-(\d+)$/.exec(id);
            if (n && Number.isSafeInteger(Number(n[1])) && Number(n[1]) < Number.MAX_SAFE_INTEGER - 1) next = Math.max(next, Number(n[1]) + 1);
        }
        if (Array.isArray(node.children)) node.children.forEach(child => reserve(child, depth + 1));
        if (Array.isArray(node.items)) node.items.forEach(item => reserve(item?.content, depth + 1));
    };
    reserve(raw?.root);
    const nodes = new Set(); const members = new Set(); const placed = new Set();
    const allocate = () => {
        let id;
        do {
            if (next >= Number.MAX_SAFE_INTEGER) next = 1;
            id = `layout-${next++}`;
        } while (nodes.has(id) || members.has(id) || Object.hasOwn(ws.tabs, id));
        return id;
    };
    const identity = (id, used, tabId) => {
        const value = typeof id === 'string' && id && !nodes.has(id) && !members.has(id)
            && (!Object.hasOwn(ws.tabs, id) || id === tabId) ? id : allocate();
        used.add(value); return value;
    };
    let count = 0;
    const read = (node, owner = null, depth = 0) => {
        if (!node || depth > 64 || ++count > 4096) return null;
        if (node.type === 'split') {
            const children = []; const weights = [];
            (Array.isArray(node.children) ? node.children : []).forEach((child, index) => {
                const result = read(child, owner, depth + 1);
                if (result) { children.push(result); weights.push(node.weights?.[index]); }
            });
            if (!children.length) return null;
            if (children.length === 1) return children[0];
            return { id: identity(node.id, nodes), type: 'split', orientation: node.orientation === 'vertical' ? 'vertical' : 'horizontal',
                children, weights: tree.weights(weights, children.length) };
        }
        if (node.type !== 'stack') return null;
        const items = [];
        for (const item of Array.isArray(node.items) ? node.items : []) {
            const tab = item && ws.tabs[item.tabId];
            if (!tab) continue;
            if (model.isContainer(tab)) {
                if (!multiple || owner || !item.content) continue;
                const content = read(item.content, tab.id, depth + 1);
                if (content) items.push({ id: identity(item.id, members), tabId: tab.id, content });
            } else {
                if (placed.has(tab.id) || (multiple && (owner ? tab.kind === 'shell' || tab.ownerGroupId !== owner : tab.kind !== 'shell'))) continue;
                placed.add(tab.id);
                items.push({ id: identity(item.id || tab.id, members, tab.id), tabId: tab.id });
            }
        }
        if (!items.length) return null;
        return { id: identity(node.id, nodes), type: 'stack', items,
            activeItemId: items.some(item => item.id === node.activeItemId) ? node.activeItemId : items[0].id };
    };
    let root = read(raw?.root);
    const makeStack = () => ({ id: identity(null, nodes), type: 'stack', items: [], activeItemId: null });
    if (!root) root = makeStack();
    const rootStack = () => tree.stacks(root)[0];
    const targetFor = tab => {
        if (!multiple || tab.kind === 'shell') return rootStack();
        let target = null;
        tree.walk(root, node => { if (node.type === 'stack') for (const item of node.items) {
            if (!target && item.tabId === tab.ownerGroupId && item.content) target = tree.stacks(item.content)[0];
        } });
        if (!target) {
            target = makeStack();
            const host = rootStack();
            const item = { id: identity(null, members), tabId: tab.ownerGroupId, content: target };
            host.items.push(item); host.activeItemId ||= item.id;
        }
        return target;
    };
    for (const tab of Object.values(ws.tabs)) {
        if (model.isContainer(tab) || placed.has(tab.id)) continue;
        const target = targetFor(tab);
        const item = { id: identity(tab.id, members, tab.id), tabId: tab.id };
        target.items.push(item); target.activeItemId ||= item.id;
    }
    ws.layout = { nextId: next, root: tree.clean(root), mergeOrigins: {} };
    for (const [itemId, nodeId] of Object.entries(raw?.mergeOrigins || {})) {
        if (members.has(itemId) && tree.find(ws.layout.root, nodeId)?.node.type === 'stack') ws.layout.mergeOrigins[itemId] = nodeId;
    }
    for (const entry of Array.isArray(saved?.groups) ? saved.groups : []) {
        const group = ws.tabs[entry?.id];
        if (!model.isContainer(group)) continue;
        if (Number.isFinite(entry.order)) group.order = entry.order;
        group.collapsed = entry.collapsed === true;
        const focused = ws.tabs[entry.focusedTabId];
        if (focused?.ownerGroupId === group.id) group.focusedTabId = focused.id;
    }
    for (const group of groups) if (model.groupStacks(ws, group.id).length < 2) group.collapsed = false;
    for (const tab of Object.values(ws.tabs)) if (!model.isContainer(tab)) tab.parentId = tab.kind === 'shell' ? null : tab.ownerGroupId;
    const focused = ws.tabs[saved?.focusedTabId] && !model.isContainer(ws.tabs[saved.focusedTabId]) ? saved.focusedTabId
        : ws.tabs[baseline.focusedTabId] ? baseline.focusedTabId : Object.values(ws.tabs).find(tab => !model.isContainer(tab))?.id;
    model.activateTab(ws, focused);
    const errors = model.validateLayout(ws);
    if (errors.length) throw new Error(`工作区布局恢复失败: ${errors.join('; ')}`);
    return ws;
}
module.exports = { recoverLayout };
