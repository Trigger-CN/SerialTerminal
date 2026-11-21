'use strict';
// Independent structural oracle. Never call production validation or geometry queries here.
const DOC_PATH = 'docs/TAB_ARCHITECTURE.md';
const INVARIANT_IDS = Array.from({ length: 10 }, (_, i) => `I${i + 1}`);
function ruleTextFromDoc(text, id) {
    return text.match(new RegExp(`\\|\\s*\\*\\*${id}\\*\\*\\s*\\|([^|]*)\\|`))?.[1]?.trim() || null;
}
function checkInvariants(ws) {
    const errors = [], tabs = ws.tabs || {}, groups = Object.values(tabs).filter(tab => tab.kind === 'group');
    const multiple = groups.length > 1, nodes = new Set(), members = new Set(), leaves = new Set(), anchors = new Set(), visible = [];
    const stackCounts = new Map();
    const report = (id, message) => errors.push(`${id} ${message}`);
    function visit(node, owner = null, shown = true, depth = 0) {
        if (!node || depth > 64 || nodes.has(node.id) || typeof node.id !== 'string') { report('I4', 'invalid node identity'); return; }
        nodes.add(node.id);
        if (node.type === 'split') {
            if (!Array.isArray(node.children) || node.children.length < 2 || !['horizontal', 'vertical'].includes(node.orientation)) { report('I9', 'invalid split'); return; }
            if (node.weights?.length !== node.children.length || node.weights.some(x => !Number.isFinite(x) || x <= 0)
                || Math.abs(node.weights.reduce((a, b) => a + b, 0) - 1) > 1e-9) report('I9', 'invalid weights');
            node.children.forEach(child => visit(child, owner, shown, depth + 1));
            return;
        }
        if (node.type !== 'stack' || !Array.isArray(node.items) || !node.items.length) { report('I5', 'empty Stack'); return; }
        if (owner || !multiple) {
            const group = owner || groups[0]?.id; stackCounts.set(group, (stackCounts.get(group) || 0) + 1);
        }
        if (!node.items.some(item => item?.id === node.activeItemId)) report('I6', 'invalid local selection');
        for (const item of node.items) {
            if (!item || members.has(item.id) || !tabs[item.tabId]) { report('I4', 'duplicate or missing member'); continue; }
            members.add(item.id); const tab = tabs[item.tabId], selected = shown && item.id === node.activeItemId;
            if (item.content) {
                if (!multiple || owner || tab.kind !== 'group') report('I2', 'invalid group anchor');
                anchors.add(tab.id); visit(item.content, tab.id, selected, depth + 1);
            } else {
                if (tab.kind === 'group') report('I2', 'group without content');
                if (leaves.has(tab.id)) report('I4', 'duplicate leaf'); leaves.add(tab.id);
                if (multiple && (owner ? tab.kind === 'shell' || tab.ownerGroupId !== owner : tab.kind !== 'shell')) report('I2', 'owner boundary');
                if (selected) visible.push(tab.id);
            }
        }
    }
    visit(ws.layout?.root);
    for (const tab of Object.values(tabs)) {
        if (tab.kind === 'group') {
            if (tab.panel) report('I3', 'group owns a terminal panel');
            if (multiple && !anchors.has(tab.id)) report('I4', 'group missing anchor');
            if (tab.collapsed && (stackCounts.get(tab.id) || 0) < 2) report('I10', 'collapsed group lacks another row');
        } else {
            if (!tab.panel || tab.panel.id !== tab.id) report('I3', 'leaf panel identity');
            if (!leaves.has(tab.id)) report('I4', 'leaf missing position');
            if (tab.kind === 'shell') { if (tab.parentId !== null || tab.ownerGroupId) report('I1', 'Shell has business owner'); }
            else if (!groups.some(group => group.id === tab.ownerGroupId) || tab.parentId !== tab.ownerGroupId) report('I1', 'serial owner');
        }
    }
    if (!leaves.has(ws.focusedTabId)) report('I7', 'missing focus');
    if (typeof ws.visiblePanels !== 'function') report('I8', 'missing visibility query');
    else {
        const first = [...ws.visiblePanels()].sort(), second = [...ws.visiblePanels()].sort();
        if (JSON.stringify(first) !== JSON.stringify(second) || JSON.stringify(first) !== JSON.stringify(visible.sort())) report('I8', 'visibility differs from local selections');
    }
    if (!visible.includes(ws.focusedTabId)) report('I7', 'hidden focus');
    return errors;
}
module.exports = { DOC_PATH, INVARIANT_IDS, ruleTextFromDoc, checkInvariants, assertAll: checkInvariants };
