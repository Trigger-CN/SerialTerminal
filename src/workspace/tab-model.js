'use strict';

const tree = require('./layout-tree');
const copy = value => JSON.parse(JSON.stringify(value));
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isContainer = tab => Boolean(tab && (tab.kind === 'group' || Array.isArray(tab.panes)));
const tabOf = (ws, id) => ws?.tabs && hasOwn(ws.tabs, id) ? ws.tabs[id] : null;
const groupsOf = ws => Object.values(ws.tabs).filter(isContainer).sort((a, b) => a.order - b.order);
const isFlat = ws => groupsOf(ws).length <= 1;
let sequence = 0;
const nextId = prefix => `${prefix}-${++sequence}`;
const resetIdSeq = () => { sequence = 0; };
function nodeId(ws) {
    const used = new Set(Object.keys(ws.tabs));
    tree.walk(ws.layout.root, node => { used.add(node.id); if (node.type === 'stack') node.items.forEach(item => used.add(item.id)); });
    let id;
    do {
        if (!Number.isSafeInteger(ws.layout.nextId) || ws.layout.nextId < 1 || ws.layout.nextId >= Number.MAX_SAFE_INTEGER) ws.layout.nextId = 1;
        id = `layout-${ws.layout.nextId++}`;
    } while (used.has(id));
    return id;
}
function stack(ws, items = [], activeItemId) {
    return { id: nodeId(ws), type: 'stack', items, activeItemId: activeItemId || items[0]?.id || null };
}
function leafItem(tabId) { return { id: tabId, tabId }; }
function groupItem(ws, groupId, content) { return { id: nodeId(ws), tabId: groupId, content }; }
function createLeaf(kind, extra = {}) {
    const id = extra.id || nextId(kind);
    return { id, kind, parentId: null, order: 0, panel: { id }, ...extra };
}
function createWorkspace(options = {}) {
    const id = options.containerId || 'grp-default';
    const main = createLeaf('main', { ownerGroupId: id, parentId: id });
    const ws = { tabs: { [id]: { id, kind: 'group', groupId: 'default', title: id, order: 0, collapsed: false },
        [main.id]: main }, focusedTabId: main.id, layout: { nextId: 1, root: null, mergeOrigins: {} } };
    ws.layout.root = stack(ws, [leafItem(main.id)]);
    return ws;
}
function locateTab(ws, tabId, itemId) {
    if (!ws?.layout?.root || !tabId) return null;
    const found = [];
    tree.walk(ws.layout.root, (node, context) => {
        if (node.type !== 'stack') return;
        node.items.forEach((item, index) => {
            if (item.tabId === tabId && (!itemId || item.id === itemId)) found.push({ stack: node, item, index, ...context });
        });
    });
    return found.find(hit => hit.item.content && containsTab(hit.item.content, ws.focusedTabId)) || found[0] || null;
}
function containsTab(root, tabId) {
    let found = false;
    tree.walk(root, node => { if (node.type === 'stack' && node.items.some(item => item.tabId === tabId)) found = true; });
    return found;
}
function rootStackOf(ws, hit) {
    if (!hit) return null;
    if (!hit.scope) return hit.stack;
    return locateTab(ws, hit.scope.tabId, hit.scope.id)?.stack || null;
}
function scopeRoot(ws, hit) { return hit.scope ? hit.scope.content : ws.layout.root; }
function sourceOf(ws, source) {
    if (!source) return null;
    if (typeof source === 'string') return locateTab(ws, source);
    if (source.itemId) {
        let result = null;
        tree.walk(ws.layout.root, (node, context) => {
            if (node.type !== 'stack') return;
            const index = node.items.findIndex(item => item.id === source.itemId);
            if (index >= 0 && (!source.tabId || node.items[index].tabId === source.tabId)) result = { stack: node, item: node.items[index], index, ...context };
        });
        return result;
    }
    return locateTab(ws, source.tabId, source.anchorId);
}
function allowed(ws, item, context) {
    const tab = tabOf(ws, item.tabId);
    if (!tab) return false;
    if (isFlat(ws)) return !isContainer(tab) && !context.scope;
    if (context.scope) return !isContainer(tab) && tab.kind !== 'shell' && tab.ownerGroupId === context.scope.tabId;
    return isContainer(tab) || tab.kind === 'shell';
}
function resolveTarget(ws, target, source) {
    if (!target) return null;
    const key = target.nodeId || target.stackId || target.paneId || target.columnId;
    if (key) {
        const hit = tree.find(ws.layout.root, key);
        if (hit) return hit;
        if (target.nodeId || target.stackId) return null;
        const tabHit = locateTab(ws, key);
        if (tabHit) return { node: rootStackOf(ws, tabHit), scope: null, ancestors: [] };
    }
    if (target.type === 'pane' && target.groupId) {
        const hit = locateTab(ws, target.groupId);
        const node = tree.stacks(hit?.item.content || ws.layout.root)[0];
        return node ? tree.find(ws.layout.root, node.id) : null;
    }
    if (target.type === 'roots' && source) {
        const node = rootStackOf(ws, source);
        return node ? tree.find(ws.layout.root, node.id) : null;
    }
    return null;
}
function activateTab(ws, tabId, itemId) {
    let hit = locateTab(ws, tabId, itemId);
    if (!hit) return false;
    hit.stack.activeItemId = hit.item.id;
    if (hit.item.content) {
        const leaves = tree.stacks(hit.item.content);
        const preferred = tabOf(ws, tabId)?.focusedTabId || ws.focusedTabId;
        const active = leaves.find(node => node.items.some(item => item.tabId === preferred)) || leaves[0];
        const item = active?.items.find(item => item.id === active.activeItemId) || active?.items[0];
        if (!item) return false;
        tabId = item.tabId;
    }
    if (hit.scope) {
        const parent = locateTab(ws, hit.scope.tabId, hit.scope.id);
        if (parent) parent.stack.activeItemId = parent.item.id;
    }
    ws.focusedTabId = tabId;
    const owner = tabOf(ws, tabOf(ws, tabId)?.ownerGroupId);
    if (owner) owner.focusedTabId = tabId;
    return true;
}
function nearestTarget(ws, source, { merge = false } = {}) {
    const candidates = (source.scope ? groupStacks(ws, source.scope.tabId) : tree.stacks(ws.layout.root))
        .filter(node => node.id !== source.stack.id);
    const legal = candidates.filter(node => allowed(ws, source.item, tree.find(ws.layout.root, node.id)));
    const eligible = merge && source.item.content
        ? legal.filter(node => node.items.some(item => isContainer(tabOf(ws, item.tabId)))) : legal;
    const origin = ws.layout.mergeOrigins[source.item.id];
    if (merge && eligible.some(node => node.id === origin)) return eligible.find(node => node.id === origin);
    const all = source.scope ? groupStacks(ws, source.scope.tabId) : tree.stacks(scopeRoot(ws, source));
    const index = all.findIndex(node => node.id === source.stack.id);
    return eligible.sort((a, b) => {
        const ai = all.indexOf(a); const bi = all.indexOf(b);
        return Math.abs(ai - index) - Math.abs(bi - index) || ai - bi;
    })[0] || null;
}
function detach(source) {
    source.stack.items.splice(source.index, 1);
    if (source.stack.activeItemId === source.item.id) {
        source.stack.activeItemId = source.stack.items[Math.min(source.index, source.stack.items.length - 1)]?.id || null;
    }
}
function insert(ws, source, target, index) {
    if (!target || target.node.type !== 'stack' || !allowed(ws, source.item, target)) return false;
    const selected = source.stack.activeItemId;
    const sameStack = source.stack.id === target.node.id;
    detach(source);
    const position = Number.isInteger(index) ? Math.max(0, Math.min(index, target.node.items.length)) : target.node.items.length;
    target.node.items.splice(position, 0, source.item);
    if (sameStack) target.node.activeItemId = selected;
    if (!sameStack) tree.releaseTo(ws.layout.root, source.stack.id, target.node.id);
    return true;
}
function splitMember(ws, action) {
    const source = sourceOf(ws, action.source || { tabId: action.tabId, itemId: action.itemId });
    if (!source || !['left', 'right', 'top', 'bottom'].includes(action.direction)) return false;
    let target = resolveTarget(ws, action.target, source);
    if (!target || !allowed(ws, source.item, target)) return false;
    if (target.node.id === source.stack.id && source.stack.items.length < 2) {
        const neighbor = nearestTarget(ws, source);
        target = neighbor && tree.find(ws.layout.root, neighbor.id);
        if (!target) return false;
    }
    if (target.node.id !== source.stack.id && containsTab(target.node, source.item.tabId)) return false;
    if (source.stack.items.length > 1) ws.layout.mergeOrigins[source.item.id] = source.stack.id;
    detach(source);
    const sibling = stack(ws, [source.item]);
    ws.layout.root = tree.split(ws.layout.root, target.node.id, sibling, action.direction, () => nodeId(ws));
    if (action.activate !== false || source.item.tabId === ws.focusedTabId
        || source.item.content && containsTab(source.item.content, ws.focusedTabId)) activateTab(ws, source.item.tabId, source.item.id);
    return true;
}
function mergeMember(ws, action) {
    const source = sourceOf(ws, action.source || { tabId: action.tabId || action.groupId, itemId: action.itemId });
    if (!source) return false;
    const candidate = action.target ? resolveTarget(ws, action.target, source)
        : (() => { const node = nearestTarget(ws, source, { merge: true }); return node && tree.find(ws.layout.root, node.id); })();
    if (!candidate || candidate.node.id === source.stack.id || !insert(ws, source, candidate, action.index)) return false;
    delete ws.layout.mergeOrigins[source.item.id];
    if (action.activate !== false || source.item.tabId === ws.focusedTabId
        || source.item.content && containsTab(source.item.content, ws.focusedTabId)) activateTab(ws, source.item.tabId, source.item.id);
    return true;
}
function wrapGroups(ws) {
    const visit = node => {
        if (node.type === 'split') { node.children.forEach(visit); return; }
        const originalActive = node.activeItemId;
        const owners = [...new Set(node.items.map(item => tabOf(ws, item.tabId)?.ownerGroupId).filter(Boolean))];
        for (const owner of owners) {
            const items = node.items.filter(item => tabOf(ws, item.tabId)?.ownerGroupId === owner);
            const first = node.items.indexOf(items[0]);
            const content = stack(ws, items, items.some(item => item.id === originalActive) ? originalActive : undefined);
            const anchor = groupItem(ws, owner, content);
            node.items = node.items.filter(item => !items.includes(item));
            node.items.splice(first, 0, anchor);
            if (items.some(item => item.id === originalActive)) node.activeItemId = anchor.id;
        }
    };
    visit(ws.layout.root);
}
function unwrapGroups(ws) {
    const unwrap = node => {
        if (node.type === 'split') { node.children = node.children.map(unwrap); return node; }
        const anchors = node.items.filter(item => item.content);
        if (!anchors.length) return node;
        const anchor = anchors.find(item => item.id === node.activeItemId) || anchors[0];
        const content = anchor.content;
        const preferred = locateTab(ws, ws.focusedTabId);
        const host = preferred && containsTab(content, ws.focusedTabId) ? preferred.stack : tree.stacks(content)[0];
        const before = []; const after = []; let passed = false;
        for (const item of node.items) {
            if (item === anchor) { passed = true; continue; }
            if (!item.content) (passed ? after : before).push(item);
        }
        host.items = [...before, ...host.items, ...after];
        const selected = node.items.find(item => item.id === node.activeItemId);
        if (selected && !selected.content) host.activeItemId = selected.id;
        // Co-stacked anchors may each own a nested layout. Compose those intact, never flatten their leaves.
        const branches = anchors.map(item => item.content);
        if (branches.length > 1) return { id: nodeId(ws), type: 'split', orientation: 'horizontal',
            children: branches, weights: tree.weights([], branches.length) };
        return content.type === 'stack' ? { ...content, id: node.id } : content;
    };
    ws.layout.root = unwrap(ws.layout.root);
}
function addGroup(ws, options = {}) {
    const id = options.id || nextId('grp');
    const mainId = options.mainId || nextId('main');
    if (tabOf(ws, id) || tabOf(ws, mainId)) return null;
    if (isFlat(ws)) wrapGroups(ws);
    const group = { id, kind: 'group', groupId: options.groupId || id, title: options.title || id,
        order: options.order ?? groupsOf(ws).length, collapsed: false };
    ws.tabs[id] = group;
    ws.tabs[mainId] = createLeaf('main', { id: mainId, ownerGroupId: id, parentId: id });
    const anchor = groupItem(ws, id, stack(ws, [leafItem(mainId)]));
    const rootStacks = tree.stacks(ws.layout.root);
    const focused = rootStackOf(ws, locateTab(ws, ws.focusedTabId));
    const destination = focused?.items.some(item => item.content) ? focused
        : rootStacks.find(node => node.items.some(item => item.content)) || rootStacks[0];
    destination.items.push(anchor);
    return group;
}
function addLeafToWorkspace(ws, groupId, options, paneId, shouldActivate = true) {
    if (!options?.id || tabOf(ws, options.id) || !isContainer(tabOf(ws, groupId))) return false;
    const shell = options.kind === 'shell';
    const leaf = createLeaf(options.kind, { ...options, ownerGroupId: shell ? null : groupId, parentId: shell ? null : groupId });
    let target;
    if (isFlat(ws)) target = tree.find(ws.layout.root, paneId)?.node || locateTab(ws, ws.focusedTabId)?.stack || tree.stacks(ws.layout.root)[0];
    else if (shell) {
        const found = tree.find(ws.layout.root, paneId);
        target = found ? found.scope ? rootStackOf(ws, locateTab(ws, found.scope.tabId, found.scope.id)) : found.node
            : rootStackOf(ws, locateTab(ws, ws.focusedTabId)) || tree.stacks(ws.layout.root)[0];
    }
    else {
        const found = tree.find(ws.layout.root, paneId);
        const group = found?.node.type === 'stack' ? found.node.items.find(item => item.tabId === groupId && item.content) : null;
        const anchor = group || locateTab(ws, groupId)?.item;
        const focused = locateTab(ws, tabOf(ws, groupId)?.focusedTabId);
        target = found?.scope?.tabId === groupId ? found.node
            : group ? tree.stacks(group.content)[0] : focused?.scope?.tabId === groupId ? focused.stack : tree.stacks(anchor?.content)[0];
    }
    if (!target || target.type !== 'stack') return false;
    ws.tabs[leaf.id] = leaf;
    target.items.push(leafItem(leaf.id));
    if (shouldActivate) activateTab(ws, leaf.id);
    return true;
}
function removeGroup(ws, groupId) {
    const group = tabOf(ws, groupId);
    if (!isContainer(group) || groupsOf(ws).length < 2 || group.groupId === 'default' || ['default', 'grp-default'].includes(groupId)) return false;
    tree.walk(ws.layout.root, node => { if (node.type === 'stack') node.items = node.items.filter(item => item.tabId !== groupId); });
    Object.values(ws.tabs).filter(tab => tab.id === groupId || tab.ownerGroupId === groupId).forEach(tab => { delete ws.tabs[tab.id]; });
    ws.layout.root = tree.clean(ws.layout.root);
    if (isFlat(ws)) unwrapGroups(ws);
    return true;
}
function collapse(ws, groupId) {
    if (groupId && !isContainer(tabOf(ws, groupId))) return false;
    const anchors = [];
    if (groupId && !isFlat(ws)) tree.walk(ws.layout.root, node => {
        if (node.type === 'stack') node.items.filter(item => item.tabId === groupId && item.content)
            .forEach(item => anchors.push({ item, host: node }));
    });
    const roots = anchors.length ? anchors.map(entry => entry.item.content) : !groupId || isFlat(ws) ? [ws.layout.root] : [];
    if (!roots.length || roots.length === 1 && roots[0].type !== 'split') return false;
    const items = roots.flatMap(root => tree.stacks(root).flatMap(node => node.items));
    const node = tree.stacks(roots[0])[0];
    node.items = items;
    const focused = items.find(item => item.tabId === ws.focusedTabId || item.content && containsTab(item.content, ws.focusedTabId));
    node.activeItemId = focused?.id || node.activeItemId;
    ws.layout.root = tree.replace(ws.layout.root, roots[0].id, node);
    for (const { item, host } of anchors.slice(1)) {
        host.items = host.items.filter(member => member !== item);
        tree.releaseTo(ws.layout.root, host.id, anchors[0].host.id);
    }
    if (focused) activateTab(ws, ws.focusedTabId);
    return true;
}
function restoreGroupLayout(ws, groupId, layout) {
    if (!isContainer(tabOf(ws, groupId)) || !Array.isArray(layout?.trees)) return false;
    const roots = isFlat(ws) ? [{ content: ws.layout.root }] : [];
    if (!isFlat(ws)) tree.walk(ws.layout.root, node => {
        if (node.type === 'stack') roots.push(...node.items.filter(item => item.tabId === groupId && item.content));
    });
    if (roots.length !== layout.trees.length) return false;
    if (isFlat(ws)) ws.layout.root = copy(layout.trees[0]);
    else roots.forEach((item, index) => { item.content = copy(layout.trees[index]); });
    const active = layout.panes?.find(pane => pane.id === layout.activePaneId)?.activeTabId;
    if (active && locateTab(ws, active)) activateTab(ws, active);
    return true;
}
function normalizeAfterAction(ws) {
    ws.layout.root = tree.clean(ws.layout.root);
    if (!locateTab(ws, ws.focusedTabId)) {
        const first = tree.stacks(ws.layout.root, true).flatMap(node => node.items).find(item => !item.content);
        if (first) activateTab(ws, first.tabId);
    }
    const liveMembers = new Set();
    tree.walk(ws.layout.root, node => { if (node.type === 'stack') node.items.forEach(item => liveMembers.add(item.id)); });
    for (const [itemId, targetId] of Object.entries(ws.layout.mergeOrigins)) {
        if (!liveMembers.has(itemId) || tree.find(ws.layout.root, targetId)?.node.type !== 'stack') delete ws.layout.mergeOrigins[itemId];
    }
    for (const tab of Object.values(ws.tabs)) {
        if (!isContainer(tab)) tab.parentId = tab.kind === 'shell' ? null : tab.ownerGroupId || null;
        else if (!tabOf(ws, tab.focusedTabId) || tabOf(ws, tab.focusedTabId)?.ownerGroupId !== tab.id) {
            const node = groupStacks(ws, tab.id)[0];
            const item = node?.items.find(item => item.id === node.activeItemId);
            tab.focusedTabId = item && tabOf(ws, item.tabId)?.ownerGroupId === tab.id ? item.tabId
                : Object.values(ws.tabs).find(leaf => leaf.ownerGroupId === tab.id)?.id;
        }
        if (isContainer(tab) && groupStacks(ws, tab.id).length < 2) tab.collapsed = false;
    }
}
function validateLayout(ws) {
    const errors = []; const identities = new Set(); const leaves = new Set(); const anchors = new Set(); const panels = new Set();
    if (!ws?.layout?.root || !ws.tabs || !Object.keys(ws.tabs).length) return ['布局根节点或业务清单缺失'];
    const multiple = groupsOf(ws).length > 1; let count = 0; let focusVisible = false;
    const identity = id => {
        if (typeof id !== 'string' || !id || identities.has(id)) return false;
        identities.add(id); return true;
    };
    const visit = (node, scope = null, depth = 0, visible = true) => {
        if (!node || !identity(node.id) || depth > 64 || ++count > 4096) { errors.push('布局节点身份无效'); return; }
        if (node.type === 'split') {
            const children = Array.isArray(node.children) ? node.children : [];
            if (!['horizontal', 'vertical'].includes(node.orientation) || children.length < 2
                || !Array.isArray(node.weights) || node.weights.length !== children.length
                || node.weights.some(value => !Number.isFinite(value) || value <= 0)
                || Math.abs(node.weights.reduce((sum, value) => sum + value, 0) - 1) > 1e-10) errors.push(`分屏结构无效: ${node.id}`);
            children.forEach(child => visit(child, scope, depth + 1, visible));
        } else if (node.type === 'stack') {
            if (!Array.isArray(node.items) || !node.items.length) { errors.push(`空区域: ${node.id}`); return; }
            if (!node.items.some(item => item?.id === node.activeItemId)) errors.push(`区域选择无效: ${node.id}`);
            for (const item of node.items) {
                const tab = tabOf(ws, item?.tabId);
                if (!item || !identity(item.id) || !allowed(ws, item, { scope })
                    || Boolean(item.content) !== isContainer(tab)) { errors.push(`成员位置无效: ${item?.tabId}`); continue; }
                const selected = visible && item.id === node.activeItemId;
                if (item.content) { anchors.add(item.tabId); visit(item.content, item, depth + 1, selected); }
                else {
                    if (leaves.has(item.tabId)) errors.push(`重复叶位置: ${item.tabId}`);
                    leaves.add(item.tabId);
                    if (item.tabId === ws.focusedTabId && selected) focusVisible = true;
                }
            }
        } else errors.push(`未知节点: ${node.id}`);
    };
    visit(ws.layout.root);
    for (const [id, tab] of Object.entries(ws.tabs)) {
        if (!tab || tab.id !== id) { errors.push(`业务身份无效: ${id}`); continue; }
        if (isContainer(tab)) {
            if (tab.panel || multiple && !anchors.has(tab.id)) errors.push(`分组结构无效: ${tab.id}`);
            if (tab.collapsed && groupStacks(ws, tab.id).length < 2) errors.push(`收起行数不足: ${tab.id}`);
        } else {
            if (!leaves.has(tab.id)) errors.push(`标签无位置: ${tab.id}`);
            if (tab.panel?.id !== tab.id || panels.has(tab.panel.id)) errors.push(`面板身份无效: ${tab.id}`);
            panels.add(tab.panel?.id);
            if (tab.kind === 'shell' ? Boolean(tab.ownerGroupId || tab.parentId)
                : !isContainer(tabOf(ws, tab.ownerGroupId)) || tab.parentId !== tab.ownerGroupId) errors.push(`业务归属无效: ${tab.id}`);
        }
    }
    if (!leaves.has(ws.focusedTabId) || !focusVisible) errors.push('焦点无效或不可见');
    return errors;
}
function applyWorkspaceAction(ws, action) {
    if (!ws?.layout || !action?.type) return { ok: false, workspace: ws, reason: '动作或布局无效' };
    try {
        const next = copy(ws);
        let changed = false;
        const groupId = action.groupId;
        switch (action.type) {
            case 'activate': changed = activateTab(next, action.tabId, action.itemId); break;
            case 'add-group': {
                const group = addGroup(next, action.options);
                changed = Boolean(group);
                if (changed && action.activate !== false) {
                    const main = Object.values(next.tabs).find(tab => tab.ownerGroupId === group.id && tab.kind === 'main');
                    activateTab(next, main.id);
                }
                break;
            }
            case 'remove-group': changed = removeGroup(next, groupId); break;
            case 'add-leaf': changed = addLeafToWorkspace(next, groupId, action.options, action.paneId, action.activate !== false); break;
            case 'split': changed = splitMember(next, action); break;
            case 'merge': changed = mergeMember(next, action); break;
            case 'split-tab':
            case 'split-group': {
                const id = action.tabId || groupId;
                const source = locateTab(next, id, action.itemId);
                changed = Boolean(source && splitMember(next, { ...action, source: { tabId: id, itemId: source.item.id },
                    target: action.target || { nodeId: source.stack.id }, direction: action.direction
                        || (action.orientation === 'vertical' ? action.before ? 'top' : 'bottom' : action.before ? 'left' : 'right') }));
                break;
            }
            case 'move': {
                const source = sourceOf(next, action.source || { tabId: action.tabId, itemId: action.itemId });
                const target = resolveTarget(next, action.target, source);
                const sameStack = source && target?.node.id === source.stack.id;
                const focused = source && (source.item.tabId === next.focusedTabId
                    || source.item.content && containsTab(source.item.content, next.focusedTabId));
                changed = Boolean(source && target && insert(next, source, target, action.target?.index));
                if (changed && !sameStack && (action.activate !== false || focused)) activateTab(next, source.item.tabId, source.item.id);
                break;
            }
            case 'close': {
                const tab = tabOf(next, action.tabId);
                const source = locateTab(next, action.tabId);
                if (source && tab.kind !== 'main' && !isContainer(tab)) {
                    const wasFocused = next.focusedTabId === tab.id;
                    detach(source); delete next.tabs[tab.id]; changed = true;
                    if (wasFocused) {
                        const fallback = tabOf(next, action.fallbackTabId);
                        const local = source.stack.items.find(item => item.id === source.stack.activeItemId);
                        const preferred = !isFlat(next) && tab.kind === 'shell' && fallback && !isContainer(fallback)
                            ? fallback.id : local?.tabId;
                        if (preferred) activateTab(next, preferred);
                    }
                }
                break;
            }
            case 'restore-group-layout': changed = restoreGroupLayout(next, groupId, action.layout); break;
            case 'resize': changed = tree.resize(next.layout.root, action.splitNodeId, action.beforeId, action.afterId, action.ratio); break;
            case 'collapse-all': changed = collapse(next, action.scopeGroupId); break;
            case 'pane-split': {
                if (action.enabled === false) changed = collapse(next, groupId);
                else {
                    const panes = groupStacks(next, groupId);
                    const source = panes.find(node => node.items.length > 1);
                    const item = source?.items.find(item => item.id !== source.activeItemId);
                    changed = Boolean(item && splitMember(next, { source: { itemId: item.id }, target: { nodeId: source.id },
                        direction: action.orientation === 'vertical' ? 'bottom' : 'right' }));
                }
                break;
            }
            case 'active-pane': {
                const node = tree.find(next.layout.root, action.paneId)?.node;
                const item = node?.type === 'stack' && node.items.find(item => item.id === node.activeItemId);
                changed = Boolean(item && activateTab(next, item.tabId, item.id));
                break;
            }
            case 'collapse-group': {
                const group = tabOf(next, groupId);
                if (isContainer(group) && (action.collapsed !== true || groupStacks(next, groupId).length >= 2)) {
                    group.collapsed = action.collapsed === true; changed = true;
                }
                break;
            }
            default: break;
        }
        if (!changed) return { ok: false, workspace: ws, reason: `动作目标或放置规则不允许: ${action.type}` };
        normalizeAfterAction(next);
        const errors = validateLayout(next);
        return errors.length ? { ok: false, workspace: ws, reason: errors.join('; ') } : { ok: true, workspace: next, repairs: [] };
    } catch (error) { return { ok: false, workspace: ws, reason: error.message }; }
}
function groupStacks(ws, groupId) {
    if (isFlat(ws)) return tree.stacks(ws.layout.root);
    const result = [];
    tree.walk(ws.layout.root, node => {
        if (node.type === 'stack') node.items.filter(item => item.tabId === groupId && item.content).forEach(item => result.push(...tree.stacks(item.content)));
    });
    return result;
}
function panesOf(container, ws) {
    return ws ? groupStacks(ws, container.id).map(node => ({ id: node.id, tabIds: node.items.map(item => item.tabId),
        activeTabId: node.items.find(item => item.id === node.activeItemId)?.tabId })) : container?.panes || [];
}
function paneOfTab(ws, tab) {
    if (!tab || isContainer(tab)) return null;
    const hit = locateTab(ws, tab.id);
    if (!hit) return null;
    const container = tabOf(ws, tab.ownerGroupId) || (isFlat(ws) ? groupsOf(ws)[0] : null);
    return container ? { container, pane: { id: hit.stack.id, tabIds: hit.stack.items.map(item => item.tabId),
        activeTabId: hit.stack.items.find(item => item.id === hit.stack.activeItemId)?.tabId } } : null;
}
function groupLayout(ws, groupId) {
    const group = tabOf(ws, groupId);
    if (!isContainer(group)) return null;
    const panes = panesOf(group, ws);
    const hit = locateTab(ws, group.focusedTabId || ws.focusedTabId);
    const roots = isFlat(ws) ? [ws.layout.root] : (() => { const out = []; tree.walk(ws.layout.root, node => {
        if (node.type === 'stack') node.items.filter(item => item.tabId === groupId && item.content).forEach(item => out.push(item.content));
    }); return out; })();
    return { panes, activePaneId: panes.some(pane => pane.id === hit?.stack.id) ? hit.stack.id : panes[0]?.id,
        splitEnabled: panes.length > 1, orientation: roots[0]?.orientation || 'horizontal', paneSizes: {},
        paneSplit: { enabled: panes.length > 1, orientation: roots[0]?.orientation || 'horizontal', sizes: {} }, trees: roots.map(copy) };
}
function buildRenderPlan(ws) {
    const panels = []; const allPanels = []; const rows = []; const multiple = !isFlat(ws);
    const rowState = new Map();
    for (const group of groupsOf(ws)) {
        const stacks = groupStacks(ws, group.id);
        const visible = stacks.filter(node => {
            const scope = tree.find(ws.layout.root, node.id)?.scope;
            const parent = scope && locateTab(ws, scope.tabId, scope.id);
            return !parent || parent.stack.activeItemId === scope.id;
        });
        const restore = visible[0] || stacks[0];
        stacks.forEach(node => rowState.set(node.id, { collapseGroupId: group.id,
            canCollapse: stacks.length > 1 && node === restore, collapsed: group.collapsed === true,
            headerHidden: group.collapsed === true && node !== restore }));
    }
    const render = (node, scope = null, visible = true) => {
        if (node.type === 'split') return { ...node, children: node.children.map(child => render(child, scope, visible)) };
        const members = node.items.map(item => {
            const tab = tabOf(ws, item.tabId);
            const selected = item.id === node.activeItemId;
            if (!item.content) { allPanels.push(tab.id); if (visible && selected) panels.push(tab.id); }
            return { id: item.id, tabId: item.tabId, tab, active: selected,
                ...(item.content ? { content: render(item.content, item, visible && selected) } : {}) };
        });
        rows.push({ nodeId: node.id, groupId: scope?.tabId || null, rootLevel: !scope, members });
        return { id: node.id, type: 'stack', activeItemId: node.activeItemId, members,
            groupId: scope?.tabId || null, rootLevel: !scope, visible, ...rowState.get(node.id),
            rowRole: multiple ? scope ? 'sub' : 'root' : tree.stacks(ws.layout.root).length > 1 ? 'sub' : 'root' };
    };
    const root = render(ws.layout.root);
    const columns = tree.stacks(ws.layout.root).map(node => {
        const active = node.items.find(item => item.id === node.activeItemId);
        const containerId = active?.content ? active.tabId : node.items.find(item => item.content)?.tabId || null;
        const inner = active?.content ? tree.stacks(active.content) : [];
        return { columnId: node.id, domKey: node.id, containerId, rootOnly: !containerId, isFamily: !multiple,
            tabItems: node.items.map(item => tabOf(ws, item.tabId)), rows: inner.map(row => ({ paneId: row.id,
                tabs: row.items.map(item => tabOf(ws, item.tabId)), activeTabId: row.items.find(item => item.id === row.activeItemId)?.tabId })),
            panelIds: panels.filter(id => containsTab(node, id)), panelIdsAll: allPanels.filter(id => containsTab(node, id)) };
    });
    return { root, rows, columns, panelIds: panels, panelIdsAll: allPanels, containerCount: groupsOf(ws).length,
        tabBarVisible: multiple, subRowTabIds: rows.filter(row => !row.rootLevel).flatMap(row => row.members.map(item => item.tabId)) };
}
function canSplitTab(ws, tabId, groupId, itemId) {
    const source = locateTab(ws, tabId, itemId);
    if (!source || groupId && tabOf(ws, tabId)?.ownerGroupId && tabOf(ws, tabId).ownerGroupId !== groupId) return false;
    return source.stack.items.length > 1 || Boolean(nearestTarget(ws, source));
}
function getOtherPaneTarget(ws, tabId, groupId, itemId) {
    const source = locateTab(ws, tabId, itemId);
    if (!source || groupId && tabOf(ws, tabId)?.ownerGroupId && tabOf(ws, tabId).ownerGroupId !== groupId) return null;
    const node = nearestTarget(ws, source);
    return node ? { type: 'pane', nodeId: node.id, paneId: node.id, groupId, index: node.items.length } : null;
}
function getMergeTarget(ws, tabId, itemId) {
    const source = locateTab(ws, tabId, itemId);
    const node = source && nearestTarget(ws, source, { merge: true });
    return node ? { nodeId: node.id } : null;
}
function normalizeSizes(sizes, ids) {
    const values = tree.weights(ids.map(id => sizes?.[id]), ids.length);
    return Object.fromEntries(ids.map((id, index) => [id, values[index]]));
}
// Historical import utilities operate only before a live tree exists.
function rebuildIndex(ws) {
    if (ws.layout) { normalizeAfterAction(ws); return; }
    Object.values(ws.tabs).filter(tab => !isContainer(tab)).forEach(tab => { tab.parentId = null; });
    Object.values(ws.tabs).filter(isContainer).forEach(group => group.panes.forEach(pane => pane.tabIds.forEach(id => {
        if (ws.tabs[id]) ws.tabs[id].parentId = group.id;
    })));
}
function normalizeSerialOwnership(ws) {
    if (ws.layout) { normalizeAfterAction(ws); return; }
    const groups = Object.values(ws.tabs).filter(isContainer);
    for (const tab of Object.values(ws.tabs)) {
        if (isContainer(tab) || tab.kind === 'shell') continue;
        const owner = groups.find(group => group.id === tab.ownerGroupId || group.id === tab.parentId) || groups[0];
        if (owner) tab.ownerGroupId = owner.id;
    }
    rebuildIndex(ws);
}
function roots(ws) { return Object.values(ws.tabs).filter(tab => isContainer(tab) || !tab.parentId).sort((a, b) => a.order - b.order); }
function childrenOf(ws, group) { return Object.values(ws.tabs).filter(tab => tab.ownerGroupId === group.id); }
function rootOf(ws, tab) { return tab?.ownerGroupId ? tabOf(ws, tab.ownerGroupId) : tab; }
function mutable(ws, action) {
    const result = applyWorkspaceAction(ws, action);
    if (!result.ok) return false;
    Object.assign(ws, result.workspace);
    return true;
}
function addShell(ws) { const id = nextId('shell'); return mutable(ws, { type: 'add-leaf', groupId: groupsOf(ws)[0].id, options: { id, kind: 'shell' }, activate: false }) ? ws.tabs[id] : null; }
function addLeaf(ws, kind, options = {}) { const id = options.id || nextId(kind); return mutable(ws, { type: 'add-leaf', groupId: options.containerId || groupsOf(ws)[0].id, options: { ...options, id, kind }, activate: false }) ? ws.tabs[id] : null; }
function addContainerTab(ws, options) { const group = addGroup(ws, options); normalizeAfterAction(ws); return group; }
function layoutColumns(ws) { return buildRenderPlan(ws).columns.map(column => ({ ...column, id: column.columnId })); }
function layoutRowsOf(ws, column) { return groupLayout(ws, column.containerId)?.panes || []; }
const visiblePanels = ws => new Set(buildRenderPlan(ws).panelIds);
function resolveLeafColumnId(ws, tab) { return rootStackOf(ws, locateTab(ws, tab?.id))?.id || null; }
module.exports = { tree, isContainer, hasOwn, tabOf, roots, rootOf, childrenOf, panesOf, paneOfTab, groupStacks, groupLayout,
    containerIds: ws => groupsOf(ws).map(group => group.id), isFlat, locateTab, rootStackOf, getMergeTarget,
    layoutColumns, layoutRowsOf, visiblePanels, buildRenderPlan, normalizeSizes, rebuildIndex, normalizeSerialOwnership,
    nextId, resetIdSeq, createLeaf, createWorkspace, addShell, addLeaf, addContainerTab, activateTab,
    canSplitTab, getOtherPaneTarget, applyWorkspaceAction, validateLayout, resolveLeafColumnId,
    withDiagnostics: ws => ({ ...ws, visiblePanels: () => visiblePanels(ws) }),
    validateAndRepair: ws => ({ ok: validateLayout(ws).length === 0, fatal: false, repairs: [] }),
    moveTab: (ws, tabId, target) => mutable(ws, { type: 'move', tabId, target }),
    closeTab: (ws, tabId) => mutable(ws, { type: 'close', tabId }) };
