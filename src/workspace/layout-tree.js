'use strict';

// Geometry primitives shared by root regions and group content. No business state or DOM.
function walk(root, visit, scope = null, ancestors = []) {
    if (!root) return;
    visit(root, { scope, ancestors });
    if (root.type === 'split') {
        for (const child of root.children) walk(child, visit, scope, [...ancestors, root]);
    } else {
        for (const item of root.items) {
            if (item.content) walk(item.content, visit, item, [...ancestors, root]);
        }
    }
}
function find(root, id) {
    let result = null;
    walk(root, (node, context) => { if (node.id === id) result = { node, ...context }; });
    return result;
}
function stacks(root, includeContent = false) {
    const result = [];
    function visit(node) {
        if (!node) return;
        if (node.type === 'split') node.children.forEach(visit);
        else {
            result.push(node);
            if (includeContent) node.items.forEach(item => visit(item.content));
        }
    }
    visit(root);
    return result;
}
function replace(root, id, replacement) {
    if (!root || root.id === id) return root ? replacement : root;
    if (root.type === 'split') root.children = root.children.map(child => replace(child, id, replacement)).filter(Boolean);
    else root.items.forEach(item => { if (item.content) item.content = replace(item.content, id, replacement); });
    return root;
}
function weights(values, count) {
    const numbers = Array.from({ length: count }, (_, index) => {
        const value = Number(values?.[index]);
        return Number.isFinite(value) && value > 0 ? value : 1;
    });
    const sum = numbers.reduce((a, b) => a + b, 0);
    return numbers.map(value => value / sum);
}
function clean(root) {
    if (!root) return null;
    if (root.type === 'stack') {
        root.items.forEach(item => { if (item.content) item.content = clean(item.content); });
        root.items = root.items.filter(item => !Object.hasOwn(item, 'content') || item.content);
        if (!root.items.length) return null;
        if (!root.items.some(item => item.id === root.activeItemId)) root.activeItemId = root.items[0].id;
        return root;
    }
    const oldWeights = weights(root.weights, root.children.length);
    const children = root.children.map((node, index) => ({ node: clean(node), weight: oldWeights[index] }));
    // Empty space goes to a local sibling rather than being spread over all regions.
    children.forEach((entry, index) => {
        if (entry.node) return;
        const neighbor = children.slice(0, index).reverse().find(item => item.node)
            || children.slice(index + 1).find(item => item.node);
        if (neighbor) neighbor.weight += entry.weight;
    });
    const live = children.filter(entry => entry.node);
    if (!live.length) return null;
    if (live.length === 1) return live[0].node;
    root.children = live.map(entry => entry.node);
    const total = live.reduce((sum, entry) => sum + entry.weight, 0);
    root.weights = live.map(entry => entry.weight / total);
    return root;
}
function split(root, targetId, sibling, direction, allocateId) {
    const target = find(root, targetId)?.node;
    if (!target || !['left', 'right', 'top', 'bottom'].includes(direction)) throw new Error('分屏目标或方向无效');
    const before = direction === 'left' || direction === 'top';
    const branch = { id: allocateId(), type: 'split',
        orientation: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
        children: before ? [sibling, target] : [target, sibling], weights: [0.5, 0.5] };
    return replace(root, targetId, branch);
}
function releaseTo(root, sourceId, targetId) {
    const source = find(root, sourceId), target = find(root, targetId);
    if (!source || !target || source.node.type !== 'stack' || source.node.items.length || source.scope?.id !== target.scope?.id) return;
    const common = source.ancestors.filter(node => node.type === 'split' && target.ancestors.includes(node)).at(-1);
    if (!common) return;
    const expand = (node, weight) => {
        if (node.type === 'split' && node.orientation === common.orientation
            && (find(node, sourceId) || find(node, targetId))) {
            return node.children.flatMap((child, index) => expand(child, weight * node.weights[index]));
        }
        return [{ node, weight }];
    };
    const entries = common.children.flatMap((child, index) => expand(child, common.weights[index]));
    const from = entries.find(entry => entry.node.id === sourceId), to = entries.find(entry => entry.node.id === targetId);
    if (!from || !to) return;
    to.weight += from.weight;
    const live = entries.filter(entry => entry !== from);
    common.children = live.map(entry => entry.node); common.weights = live.map(entry => entry.weight);
}
function resize(root, splitId, beforeId, afterId, ratio) {
    const node = find(root, splitId)?.node;
    const value = Number(ratio);
    if (!node || node.type !== 'split' || !Number.isFinite(value) || value <= 0 || value >= 1) return false;
    const index = node.children.findIndex(child => child.id === beforeId);
    if (index < 0 || node.children[index + 1]?.id !== afterId) return false;
    const pair = node.weights[index] + node.weights[index + 1];
    node.weights[index] = pair * value;
    node.weights[index + 1] = pair * (1 - value);
    return true;
}
module.exports = { walk, find, stacks, replace, weights, clean, split, resize, releaseTo };
