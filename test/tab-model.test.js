'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const m = require('../src/workspace/tab-model');
const acceptance = require('./tab-model-acceptance');
const { importWorkspace, projectWorkspace } = require('../src/workspace/tabs-workspace-projection');
const codec = require('../src/workspace/workspace-layout-state');
function fresh(multi = false) {
    return importWorkspace({ groups: [{ id: 'default' }, ...(multi ? [{ id: 'b' }, { id: 'c' }] : [])],
        filterTabs: { default: [{ id: 'f1' }, { id: 'f2' }] }, chartTabs: { default: [{ id: 'c1' }] },
        shellTabs: [{ id: 's1' }, { id: 's2' }], focusedTabId: 'tab-main' });
}
function act(ws, action) { const r = m.applyWorkspaceAction(ws, action); assert.equal(r.ok, true, r.reason); return r.workspace; }
const hit = (ws, id) => m.locateTab(ws, id);
const split = (ws, id, direction = 'right') => act(ws, { type: 'split-tab', tabId: id, direction });
const stacks = ws => m.tree.stacks(ws.layout.root);
const invariant = ws => assert.deepEqual(acceptance.assertAll(m.withDiagnostics(ws)), []);
test('architecture retains ten documented invariant contracts', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', acceptance.DOC_PATH), 'utf8');
    for (const id of acceptance.INVARIANT_IDS) assert.ok(acceptance.ruleTextFromDoc(doc, id), id);
});
test('default workspace has one group, one main, independent region identity and valid focus', () => {
    const ws = m.createWorkspace(); invariant(ws);
    assert.equal(m.containerIds(ws).length, 1); assert.equal(Object.keys(ws.tabs).length, 2);
    assert.notEqual(ws.layout.root.id, ws.focusedTabId); assert.equal(ws.layout.root.items.length, 1);
});
test('business owner index is independent from layout and repairs parent cache only', () => {
    const ws = fresh(); const location = hit(ws, 'f1').stack.id; ws.tabs.f1.parentId = null; m.rebuildIndex(ws);
    assert.equal(ws.tabs.f1.parentId, 'default'); assert.equal(hit(ws, 'f1').stack.id, location); invariant(ws);
});
test('single group keeps main/filter/chart/Shell on one row without subRow duplication', () => {
    const ws = fresh(), plan = m.buildRenderPlan(ws);
    assert.equal(plan.root.type, 'stack'); assert.equal(plan.root.rowRole, 'root');
    assert.deepEqual(plan.root.members.map(item => item.tabId), ['tab-main', 'f1', 'f2', 'c1', 's1', 's2']);
    assert.equal(plan.rows.length, 1); invariant(ws);
});
for (const id of ['tab-main', 'f1', 'c1', 's1']) test(`flat focus ${id} changes only selected content, not row membership`, () => {
    const ws = act(fresh(), { type: 'activate', tabId: id }), plan = m.buildRenderPlan(ws);
    assert.deepEqual(plan.panelIds, [id]); assert.equal(plan.root.members.length, 6); invariant(ws);
});
test('adding groups does not implicitly split; explicit group split creates only requested region', () => {
    let ws = fresh(true); assert.equal(stacks(ws).length, 1);
    ws = act(ws, { type: 'split-group', groupId: 'b' });
    assert.equal(stacks(ws).length, 2); assert.deepEqual(stacks(ws)[1].items.map(x => x.tabId), ['b']);
    assert.deepEqual(stacks(ws)[0].items.map(x => x.tabId), ['default', 'c', 's1', 's2']); invariant(ws);
});
test('activating a group restores its last leaf without hiding other region selections', () => {
    let ws = split(fresh(true), 'f1'); ws = act(ws, { type: 'activate', tabId: 'tab-main-b' });
    ws = act(ws, { type: 'activate', tabId: 'default' });
    assert.equal(ws.focusedTabId, 'f1'); assert.ok(m.visiblePanels(ws).has('tab-main')); invariant(ws);
});
test('root Shell switches only its own Stack and never invents a group', () => {
    let ws = act(fresh(true), { type: 'split-group', groupId: 'b' });
    ws = act(ws, { type: 'activate', tabId: 's1' });
    assert.equal(stacks(ws).length, 2); assert.deepEqual(m.buildRenderPlan(ws).panelIds.sort(), ['s1', 'tab-main-b']);
    assert.equal(m.containerIds(ws).length, 3); invariant(ws);
});
test('closing a group sharing a Shell region preserves Shell identity and position', () => {
    let ws = act(fresh(true), { type: 'split-group', groupId: 'b' });
    ws = act(ws, { type: 'move', tabId: 's1', target: { nodeId: hit(ws, 'b').stack.id } });
    const region = hit(ws, 's1').stack.id; ws = act(ws, { type: 'remove-group', groupId: 'b' });
    assert.equal(hit(ws, 's1').stack.id, region); assert.equal(ws.tabs.s1.ownerGroupId, null); invariant(ws);
});
test('two Shells may share an existing region or explicitly split into independent regions', () => {
    let ws = split(fresh(true), 's1'); ws = act(ws, { type: 'move', tabId: 's2', target: { nodeId: hit(ws, 's1').stack.id } });
    assert.equal(hit(ws, 's1').stack.id, hit(ws, 's2').stack.id);
    ws = split(ws, 's2', 'left'); assert.notEqual(hit(ws, 's1').stack.id, hit(ws, 's2').stack.id);
    assert.equal(JSON.stringify(ws).includes('__shell__'), false); invariant(ws);
});
for (const id of ['s1', 'tab-main', 'f1']) test(`multi-group placement rejects ${id} entering a foreign group content`, () => {
    const ws = fresh(true), before = JSON.stringify(ws), target = hit(ws, 'tab-main-b').stack.id;
    const r = m.applyWorkspaceAction(ws, { type: 'move', tabId: id, target: { nodeId: target } });
    assert.equal(r.ok, false); assert.equal(r.workspace, ws); assert.equal(JSON.stringify(ws), before);
});
for (const direction of ['left', 'right', 'top', 'bottom']) test(`single-group ${direction} split preserves identities and creates nonempty subRows`, () => {
    const base = fresh(), ws = split(base, 's1', direction), plan = m.buildRenderPlan(ws);
    assert.deepEqual(Object.keys(ws.tabs), Object.keys(base.tabs)); assert.equal(stacks(ws).length, 2);
    assert.ok(plan.rows.every(row => row.members.length)); assert.ok(stacks(ws).every(node => node.items.length));
    assert.ok(plan.root.children.every(node => node.rowRole === 'sub')); invariant(ws);
});
test('single-group move supports every leaf and preserves owner', () => {
    let ws = split(fresh(), 's1'), target = hit(ws, 's1').stack.id;
    for (const id of ['f1', 'tab-main', 'c1']) ws = act(ws, { type: 'move', tabId: id, target: { nodeId: target } });
    for (const id of ['f1', 'tab-main', 'c1']) assert.equal(ws.tabs[id].ownerGroupId, 'default'); invariant(ws);
});
test('reorder uses final row index without changing local active or global focus', () => {
    let ws = act(fresh(), { type: 'activate', tabId: 's1' });
    for (const index of [0, 4, 1, 3]) {
        ws = act(ws, { type: 'move', tabId: 's1', target: { nodeId: hit(ws, 's1').stack.id, index } });
        assert.equal(hit(ws, 's1').index, index); assert.equal(ws.focusedTabId, 's1'); invariant(ws);
    }
});
test('close protects main/default group and never synthesizes a new terminal', () => {
    const ws = m.createWorkspace(), before = JSON.stringify(ws);
    for (const action of [{ type: 'close', tabId: ws.focusedTabId }, { type: 'remove-group', groupId: m.containerIds(ws)[0] }]) {
        const r = m.applyWorkspaceAction(ws, action); assert.equal(r.ok, false); assert.equal(r.workspace, ws);
    }
    assert.equal(JSON.stringify(ws), before);
});
test('closing last Shell in a Stack removes the region and keeps a visible existing focus', () => {
    let ws = split(fresh(), 's1'); const ids = Object.keys(ws.tabs);
    ws = act(ws, { type: 'close', tabId: 's1' }); assert.equal(stacks(ws).length, 1);
    assert.deepEqual(Object.keys(ws.tabs), ids.filter(id => id !== 's1')); invariant(ws);
});
for (const values of [{ a: 2, b: 1 }, { a: 0, b: -5 }, {}]) test(`weights normalize every participant: ${JSON.stringify(values)}`, () => {
    const out = m.normalizeSizes(values, ['a', 'b', 'c']);
    assert.ok(Object.values(out).every(x => Number.isFinite(x) && x > 0)); assert.ok(Math.abs(Object.values(out).reduce((a, b) => a + b) - 1) < 1e-12);
    assert.deepEqual(Object.keys(out), ['a', 'b', 'c']);
});
test('explicit collapse-all retains every leaf, local order and focused content', () => {
    let ws = split(split(fresh(), 's1'), 'f1', 'bottom'); const ids = Object.keys(ws.tabs);
    const expected = stacks(ws).flatMap(node => node.items.map(item => item.tabId));
    ws = act(ws, { type: 'collapse-all' }); assert.equal(ws.layout.root.type, 'stack');
    assert.deepEqual(ws.layout.root.items.map(item => item.tabId), expected); assert.deepEqual(Object.keys(ws.tabs), ids); invariant(ws);
});
test('sole leaf split is rejected atomically while a sole leaf may move to an existing Stack', () => {
    const only = m.createWorkspace(); assert.equal(m.applyWorkspaceAction(only, { type: 'split-tab', tabId: only.focusedTabId }).ok, false);
    let ws = split(fresh(), 's1'); const r = m.applyWorkspaceAction(ws, { type: 'move', tabId: 's1', target: { nodeId: hit(ws, 'tab-main').stack.id } });
    assert.equal(r.ok, true); assert.equal(stacks(r.workspace).length, 1); invariant(r.workspace);
});
test('missing source/target and invalid direction reject without partial writes', () => {
    const ws = fresh(), before = JSON.stringify(ws);
    for (const action of [{ type: 'activate', tabId: 'missing' }, { type: 'move', tabId: 'f1', target: { nodeId: 'missing' } },
        { type: 'split', source: { tabId: 'f1' }, target: { nodeId: ws.layout.root.id }, direction: 'diagonal' }]) {
        const r = m.applyWorkspaceAction(ws, action); assert.equal(r.ok, false); assert.equal(r.workspace, ws); assert.equal(JSON.stringify(ws), before);
    }
    const r = m.applyWorkspaceAction(ws, { type: 'activate', tabId: 'f1' }); assert.notEqual(r.workspace, ws); assert.equal(JSON.stringify(ws), before);
});
test('root drag preserves interleaved group/Shell order through merge and persistence', () => {
    let ws = act(fresh(true), { type: 'split-group', groupId: 'b' }); const origin = hit(ws, 'default').stack.id;
    ws = act(ws, { type: 'move', tabId: 's2', target: { nodeId: hit(ws, 'b').stack.id, index: 1 } });
    ws = act(ws, { type: 'move', tabId: 's2', target: { nodeId: origin, index: 1 } });
    assert.deepEqual(hit(ws, 's2').stack.items.map(item => item.tabId), ['default', 's2', 'c', 's1']);
    const snapshot = codec.serializeWorkspaceLayout(ws); assert.deepEqual(codec.serializeWorkspaceLayout(codec.restoreWorkspaceLayout(fresh(true), snapshot)), snapshot); invariant(ws);
});
test('four groups and independently split Shell regions remain unique and reachable', () => {
    let ws = act(fresh(true), { type: 'add-group', options: { id: 'd', mainId: 'md' } });
    for (const id of ['b', 'c', 'd']) ws = act(ws, { type: 'split-group', groupId: id });
    ws = split(split(ws, 's1'), 's2', 'bottom'); assert.equal(stacks(ws).length, 6);
    const panels = m.buildRenderPlan(ws).panelIdsAll; assert.equal(new Set(panels).size, panels.length); invariant(ws);
});
test('group-scoped collapse leaves outer Shell geometry and other groups unchanged', () => {
    let ws = split(split(fresh(true), 'f1', 'bottom'), 's1'); const shell = structuredClone(hit(ws, 's1').stack);
    const rootId = ws.layout.root.id; ws = act(ws, { type: 'collapse-all', scopeGroupId: 'default' });
    assert.deepEqual(hit(ws, 's1').stack, shell); assert.equal(ws.layout.root.id, rootId); assert.equal(m.groupStacks(ws, 'default').length, 1); invariant(ws);
});
for (const [rule, corrupt] of [
    ['I1', ws => { ws.tabs.f1.ownerGroupId = 'missing'; }],
    ['I2', ws => { const shell = hit(ws, 's1'); shell.stack.items.splice(shell.index, 1); hit(ws, 'f1').stack.items.push(shell.item); }],
    ['I3', ws => { ws.tabs.default.panel = { id: 'default' }; }],
    ['I4', ws => { hit(ws, 'f1').stack.items.push({ id: 'copy', tabId: 'f1' }); }],
    ['I5', ws => { hit(ws, 'f1').stack.items.length = 0; }],
    ['I6', ws => { hit(ws, 'f1').stack.activeItemId = 'missing'; }],
    ['I7', ws => { ws.focusedTabId = 'missing'; }],
    ['I8', ws => { ws.visiblePanels = () => new Set(['missing']); }],
    ['I9', ws => { ws.layout.root = { id: 'bad', type: 'split', orientation: 'horizontal', weights: [1], children: [ws.layout.root] }; }]
]) test(`independent oracle detects ${rule} corruption`, () => {
    const ws = m.withDiagnostics(fresh(true)); corrupt(ws); assert.ok(acceptance.checkInvariants(ws).some(error => error.startsWith(rule)));
});
test('single-group legal Shell member is not mistaken for a business owner violation', () => invariant(fresh()));
test('projection preserves declared main location and supplies missing main from actual business group', () => {
    for (const declared of [true, false]) {
        const ws = projectWorkspace({ groups: [{ id: 'default', panes: [{ id: 'a', tabIds: [] }, { id: 'b', tabIds: declared ? ['tab-main'] : [] }] }] });
        assert.equal(ws.tabs.default.panes.find(p => p.tabIds.includes('tab-main')).id, declared ? 'b' : 'a');
    }
});
function rng(seed) { let n = seed; return () => ((n = (n * 1664525 + 1013904223) >>> 0) / 0x100000000); }
function randomStep(ws, random, step) {
    const pick = list => list[Math.floor(random() * list.length)];
    const leaves = Object.values(ws.tabs).filter(tab => !m.isContainer(tab)), groups = m.containerIds(ws), leaf = pick(leaves);
    const target = pick(m.tree.stacks(ws.layout.root, true)); let action;
    switch (Math.floor(random() * 10)) {
        case 0: action = { type: 'add-leaf', groupId: pick(groups), options: { id: `new-${step}`, kind: pick(['filter', 'chart', 'shell']) }, activate: random() > .5 }; break;
        case 1: action = groups.length < 4 ? { type: 'add-group', options: { id: `g-${step}`, mainId: `main-${step}` } } : { type: 'remove-group', groupId: pick(groups) }; break;
        case 2: action = { type: 'activate', tabId: leaf.id }; break;
        case 3: action = { type: 'split-tab', tabId: leaf.id, direction: pick(['left', 'right', 'top', 'bottom']), activate: random() > .5 }; break;
        case 4: action = { type: 'move', tabId: leaf.id, target: { nodeId: target.id, index: Math.floor(random() * (target.items.length + 1)) }, activate: random() > .5 }; break;
        case 5: action = { type: 'merge', tabId: leaf.id }; break;
        case 6: action = { type: 'close', tabId: leaf.id }; break;
        case 7: action = { type: 'split-group', groupId: pick(groups), direction: pick(['right', 'bottom']) }; break;
        case 8: action = { type: 'collapse-all', ...(random() > .5 ? { scopeGroupId: pick(groups) } : {}) }; break;
        default: { const splits = []; m.tree.walk(ws.layout.root, node => { if (node.type === 'split') splits.push(node); }); const node = pick(splits);
            action = node ? { type: 'resize', splitNodeId: node.id, beforeId: node.children[0].id, afterId: node.children[1].id, ratio: .1 + random() * .8 } : { type: 'activate', tabId: leaf.id }; }
    }
    const before = JSON.stringify(ws), result = m.applyWorkspaceAction(ws, action);
    assert.equal(JSON.stringify(ws), before, 'transaction changed input');
    if (!result.ok) assert.equal(result.workspace, ws);
    return result.workspace;
}
test('120 fixed seeds × 120 mixed operations preserve independent geometry/owner/visibility invariants', () => {
    for (let seed = 1; seed <= 120; seed++) {
        let ws = fresh(); const random = rng(seed);
        for (let step = 0; step < 120; step++) {
            ws = randomStep(ws, random, step); assert.deepEqual(acceptance.assertAll(m.withDiagnostics(ws)), [], `seed=${seed} step=${step}`);
        }
        const snapshot = codec.serializeWorkspaceLayout(ws);
        assert.deepEqual(codec.serializeWorkspaceLayout(codec.restoreWorkspaceLayout(ws, snapshot)), snapshot, `seed=${seed} roundtrip`);
    }
});
test('forty randomized render plans never duplicate a business leaf panel', () => {
    for (let seed = 1; seed <= 40; seed++) {
        let ws = fresh(true); const random = rng(seed);
        for (let step = 0; step < 60; step++) ws = randomStep(ws, random, step);
        const ids = m.buildRenderPlan(ws).panelIdsAll; assert.equal(new Set(ids).size, ids.length); invariant(ws);
    }
});
