'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../tab-model');
const acceptance = require('./tab-model-acceptance');

const {
    createWorkspace,
    addShell,
    addContainerTab,
    addLeaf,
    addPane,
    activateTab,
    reorderInRow,
    setColumnSplit,
    setPaneSplit,
    setCollapsed,
    closeTab,
    rootFamilyOf,
    roots,
    layoutColumns,
    layoutRowsOf,
    resolveLeafColumnId,
    setLeafColumn,
    leafColumnMode,
    setLeafColumnMode,
    leafHostGroup,
    setLeafHostGroup,
    visiblePanels,
    buildRenderPlan,
    isContainer,
    resetIdSeq,
    normalizeSizes,
    validateAndRepair,
    withDiagnostics,
    OWN_COLUMN_ID
} = model;

function fresh() {
    resetIdSeq();
    return createWorkspace();
}

// 标签树里有几个串口组
function groupCount(ws) {
    return Object.values(ws.tabs).filter(isContainer).length;
}

// 便捷：在指定容器里找到一个指定 kind 的叶
function findLeaf(ws, kind) {
    return Object.values(ws.tabs).find(tab => tab.kind === kind && !isContainer(tab)) || null;
}

function rowIdsOf(plan) {
    const ids = [];
    for (const col of plan.columns) {
        for (const item of col.tabItems) ids.push(item.id);
        for (const row of col.rows) for (const item of row.tabs) ids.push(item.id);
    }
    return ids;
}

// ---------------------------------------------------------------------------
// 文档与断言的对应关系
// ---------------------------------------------------------------------------

test('acceptance rules exist in the architecture doc', () => {
    const docPath = path.join(__dirname, '..', acceptance.DOC_PATH);
    const doc = fs.readFileSync(docPath, 'utf8');
    for (const id of acceptance.INVARIANT_IDS) {
        const text = acceptance.ruleTextFromDoc(doc, id);
        assert.ok(text && text.length > 0, `文档里找不到 ${id}`);
    }
});

// ---------------------------------------------------------------------------
// 基础结构
// ---------------------------------------------------------------------------

test('default workspace has one container, one main leaf and passes invariants', () => {
    const ws = fresh();
    assert.equal(groupCount(ws), 1);
    const main = findLeaf(ws, 'main');
    assert.ok(main);
    assert.equal(ws.focusedTabId, main.id);
    assert.deepEqual(withDiagnostics(ws) && acceptance.assertAll(withDiagnostics(ws)), []);
});

test('parentId is derived from panes, never written by hand', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    const main = findLeaf(ws, 'main');
    assert.equal(main.parentId, container.id);

    // 直接把 parentId 改坏，rebuildIndex 之后必须恢复
    main.parentId = null;
    model.rebuildIndex(ws);
    assert.equal(main.parentId, container.id);
});

// ---------------------------------------------------------------------------
// §3.2 / §3.3 扁平模式与根族
// ---------------------------------------------------------------------------

test('flat mode without shell shows container children on the single TabRow', () => {
    const ws = fresh();
    const main = findLeaf(ws, 'main');
    addLeaf(ws, 'filter');
    addLeaf(ws, 'chart');

    const plan = buildRenderPlan(ws);
    assert.equal(plan.columns.length, 1);
    assert.equal(plan.columns[0].isFamily, true);
    const ids = plan.columns[0].tabItems.map(item => item.id);
    assert.ok(ids.includes(main.id));
    assert.equal(ids.length, 3);
    // 扁平且未开 pane 分屏：没有 subRow
    assert.equal(plan.columns[0].rows.length, 0);
});

test('flat mode with shells keeps both shells and all children on the same row', () => {
    const ws = fresh();
    addLeaf(ws, 'filter');
    const shellA = addShell(ws);
    const shellB = addShell(ws);

    const plan = buildRenderPlan(ws);
    assert.equal(plan.columns.length, 1);
    const ids = plan.columns[0].tabItems.map(item => item.id);
    assert.ok(ids.includes(shellA.id), 'shell A 必须出现在 TabRow');
    assert.ok(ids.includes(shellB.id), 'shell B 必须出现在 TabRow');
    assert.equal(ids.length, 4);            // main + filter + 2 shell
});

test('in flat mode, focusing a shell does not hide the container children', () => {
    const ws = fresh();
    const main = findLeaf(ws, 'main');
    const shell = addShell(ws);

    activateTab(ws, shell.id);
    const plan = buildRenderPlan(ws);
    const ids = plan.columns[0].tabItems.map(item => item.id);

    assert.ok(ids.includes(main.id), '焦点在 shell 上时 main 仍须在 TabRow 里');
    assert.ok(ids.includes(shell.id));
    assert.equal(ids.length, 2);
});

test('in flat mode the content area follows the focus, including a shell', () => {
    const ws = fresh();
    const main = findLeaf(ws, 'main');
    const filter = addLeaf(ws, 'filter');
    const shell = addShell(ws);

    activateTab(ws, filter.id);
    assert.deepEqual([...visiblePanels(ws)], [filter.id]);

    activateTab(ws, shell.id);
    assert.deepEqual([...visiblePanels(ws)], [shell.id]);

    activateTab(ws, main.id);
    assert.deepEqual([...visiblePanels(ws)], [main.id]);
});

// ---------------------------------------------------------------------------
// 多分组：subRow 才出现
// ---------------------------------------------------------------------------

test('two containers give one column per root when split is on', () => {
    const ws = fresh();
    addContainerTab(ws, { id: 'grp-2', groupId: 'g2' });
    setColumnSplit(ws, true);

    const plan = buildRenderPlan(ws);
    assert.equal(plan.columns.length, 2);
    assert.ok(plan.columns.every(col => col.isFamily === false));
    assert.ok(plan.columns.every(col => col.rows.length === 1));
});

test('split off shows only the column that contains the focus', () => {
    const ws = fresh();
    const second = addContainerTab(ws, { id: 'grp-2', groupId: 'g2' });
    const secondMain = second.panes[0].activeTabId;

    activateTab(ws, secondMain);
    const plan = buildRenderPlan(ws);
    assert.equal(plan.columns.length, 1);
    assert.equal(plan.columns[0].containerId, second.id);
});

// 分屏后一个未归属 Shell **不自成列**（用户裁决），它停在某一列的列首行；
// 点中它时，那一列的内容区显示它自己，而不是该容器的 activeTabId。
//
// 旧用例断言的是「shell 必须自成一根级列」，已随用户裁决失效：分屏只作用于被移动的
// 那一个串口组，Shell 维持原位不动。它不是被删掉，而是被改成了下面这个更准的判据。
// 反向对照：删掉 visiblePanelIdsOfColumn 里「焦点是该列的根级叶」那一文，
// panelIds 会退回容器 activeTabId，下面两条断言立刻失败。
test('a root leaf sitting on a column shows its own panel when focused', () => {
    const ws = fresh();
    addContainerTab(ws, { id: 'grp-2', groupId: 'g2' });
    const shell = addShell(ws);
    setColumnSplit(ws, true);

    const plan = buildRenderPlan(ws);
    // 列集合只由容器决定：两个容器两列，Shell 不占列。
    assert.equal(plan.columns.length, 2, '分屏列数等于容器数');
    assert.ok(!plan.columns.some(col => col.columnId === shell.id), 'Shell 不得自成列');

    // Shell 坐在某列的列首行：col.tabItems 里能找到它（与分组标签同级）。
    const home = plan.columns.find(col => col.tabItems.some(t => t.id === shell.id));
    assert.ok(home, 'Shell 必须出现在某一列的列首行');
    assert.equal(home.containerId, resolveLeafColumnId(ws, shell));

    // 未点时那一列显示容器自己的激活叶，不显示 Shell。
    assert.ok(!plan.panelIds.includes(shell.id), '未点中时 Shell 不占面板');

    // 点中后那一列显示 Shell，而不是容器的 activeTabId。
    activateTab(ws, shell.id);
    const after = buildRenderPlan(ws);
    const sameColumn = after.columns.find(col => col.columnId === home.columnId);
    assert.deepEqual(sameColumn.panelIds, [shell.id]);
    assert.ok(after.panelIds.includes(shell.id), '全局可见面板必须包含 shell');
    assert.deepEqual(sameColumn.rows.length, 1, '容器列仍保留自己那条 subRow');
});

// 根级叶的 columnId 是「它停在哪一列」的唯一真源：拖到哪列就跟到哪列，
// 而那一列的删除会把它自愈回现存的第一列。
test('a root leaf follows its columnId and survives that column being deleted', () => {
    const ws = fresh();
    const other = addContainerTab(ws, { id: 'grp-2', groupId: 'g2' });
    const shell = addShell(ws);
    setColumnSplit(ws, true);

    assert.equal(setLeafColumn(ws, shell.id, other.id), true);
    assert.equal(resolveLeafColumnId(ws, shell), other.id);
    const moved = buildRenderPlan(ws).columns.find(col => col.columnId === other.id);
    assert.ok(moved.tabItems.some(t => t.id === shell.id), '改列后必须挂在新的那一列');

    // 删掉它那一列 → columnId 悬空，validateAndRepair 写回现存的第一列。
    closeTab(ws, other.id);
    const repaired = validateAndRepair(ws);
    assert.ok(repaired.ok);
    assert.ok(repaired.repairs.some(text => text.includes('columnId')), repaired.repairs);
    assert.notEqual(shell.columnId, other.id);
    assert.ok(roots(ws).filter(isContainer).some(c => c.id === shell.columnId));
});

// `columnMode` 是「这个根级叶自不自成独立列」的唯一真源，承接历史上
// `tabState.detachedColumn` 的职责。独立列只有一条，住着全部 `ownColumn` 叶。
//
// **断言为何从「columnId === shell.id」改为固定列 key**：旧实现按叶派生生列，
// 每个 ownColumn 叶一列、列 id 就是叶 id；但渲染层只有一个 Shell 列容器
// （`serial-group-workspace-__shell__`），用户原话也是「shell 标签页如果独立一组，
// 则该组只显示一行标签栏」——独立列描述的是一**组**而不是一个标签。旧断言把
// “一个叶 = 一列”固化了，它验证的是实现细节而不是用户可见行为，因此更新为列 key。
test('a root leaf with columnMode ownColumn gets the shared own column while split is on', () => {
    const ws = fresh();
    addContainerTab(ws, { id: 'grp-2', groupId: 'g2' });
    const shell = addShell(ws);
    setColumnSplit(ws, true);

    // 默认是 row：不占列，仅停在某一列的列首行上。
    assert.equal(leafColumnMode(shell), 'row');
    assert.equal(buildRenderPlan(ws).columns.length, 2, '默认形态：列数等于容器数');

    assert.equal(setLeafColumnMode(ws, shell.id, 'ownColumn'), true);
    assert.equal(leafColumnMode(shell), 'ownColumn');

    const plan = buildRenderPlan(ws);
    assert.equal(plan.columns.length, 3, 'ownColumn 必须多出一列');
    const own = plan.columns.find(col => col.columnId === OWN_COLUMN_ID);
    assert.ok(own, '独立列对全部分组共用一个固定 key');
    assert.equal(own.containerId, null, '独立列没有容器');
    assert.deepEqual(own.tabItems.map(t => t.id), [shell.id]);
    assert.deepEqual(own.rows, [], '独立列没有 subRow');
    assert.deepEqual(own.panelIds, [shell.id], '独立列显示它里面的叶');
    // 它不能同时出现在别的容器的列首行里（否则同一个按钮会在两处可见）。
    assert.ok(!plan.columns.some(col => col.containerId && col.tabItems.some(t => t.id === shell.id)));
    // 反向对照：把 columnMode 改回 row，上面的三列与独立面板必须消失。
    setLeafColumnMode(ws, shell.id, 'row');
    const back = buildRenderPlan(ws);
    assert.equal(back.columns.length, 2);
    assert.ok(!back.columns.some(col => col.columnId === OWN_COLUMN_ID));
});

// 多个 `ownColumn` 叶必须共享**同一列**，而不是每叶一列。
// 渲染层只有一个 Shell 列容器；若模型派生多列，翻转后必然出现没有对应 DOM 的空列。
test('multiple ownColumn leaves share one own column ordered by root order', () => {
    const ws = fresh();
    addContainerTab(ws, { id: 'grp-2', groupId: 'g2' });
    const first = addShell(ws);
    const second = addShell(ws);
    setColumnSplit(ws, true);
    setLeafColumnMode(ws, first.id, 'ownColumn');
    setLeafColumnMode(ws, second.id, 'ownColumn');

    const plan = buildRenderPlan(ws);
    assert.equal(plan.columns.length, 3, '两个独立叶仍然只多出一列');
    const ownColumns = plan.columns.filter(col => col.containerId === null);
    assert.equal(ownColumns.length, 1);
    assert.equal(ownColumns[0].columnId, OWN_COLUMN_ID);
    assert.deepEqual(ownColumns[0].tabItems.map(t => t.id), [first.id, second.id], '按根级 order 排列');
    assert.deepEqual(ownColumns[0].panelIdsAll, [first.id, second.id], '两个面板都住这一列');

    // 反向对照：只把第二个改回 row，列数不变但列内只剩第一个。
    setLeafColumnMode(ws, second.id, 'row');
    const one = buildRenderPlan(ws);
    assert.equal(one.columns.length, 3);
    assert.deepEqual(one.columns.find(c => c.columnId === OWN_COLUMN_ID).tabItems.map(t => t.id), [first.id]);

    // 两个都回 row：独立列必须整体消失。
    setLeafColumnMode(ws, first.id, 'row');
    assert.equal(buildRenderPlan(ws).columns.length, 2);
});


// `hostGroupId` 是「Shell 归属某个分组」的唯一真源，承接历史 `ownerGroupId`。
// 归属的叶必须落在该列的下层行（rows）里，而不是列首行（tabItems）——
// 那是它和「停在此列列首行」的根本区别。
test('a hosted root leaf sits on the column subRow instead of its tab row', () => {
    const ws = fresh();
    const other = addContainerTab(ws, { id: 'grp-2', groupId: 'g2' });
    const shell = addShell(ws);
    setColumnSplit(ws, true);

    assert.equal(setLeafHostGroup(ws, shell.id, other.id), true);
    assert.equal(leafHostGroup(ws, shell), other.id);
    assert.equal(resolveLeafColumnId(ws, shell), other.id, '归属决定它算哪一列');

    const plan = buildRenderPlan(ws);
    const hosted = plan.columns.find(col => col.columnId === other.id);
    assert.ok(hosted, '归属列必须存在');
    assert.equal(hosted.tabItems.some(t => t.id === shell.id), false, '不能同时占列首行');
    assert.ok(hosted.rows.length > 0, '归属列必须有下层行');
    assert.ok(hosted.rows[0].tabs.some(t => t.id === shell.id), '必须出现在第一行的 tabs 里');
    assert.ok(hosted.panelIdsAll.includes(shell.id), '面板必须赖在这一列的内容区');
    // 它不能同时算作别的列的叶。
    assert.equal(plan.columns.filter(col => col.containerId && col.columnId !== other.id)
        .some(col => col.rows.some(row => row.tabs.some(t => t.id === shell.id))), false);

    // 反向对照：解除归属后它回到列首行，不再进任何 rows。
    assert.equal(setLeafHostGroup(ws, shell.id, null), true);
    assert.equal(leafHostGroup(ws, shell), null);
    const back = buildRenderPlan(ws);
    assert.equal(back.columns.some(col => col.rows.some(
        row => row.tabs.some(t => t.id === shell.id))), false);
    assert.ok(back.columns.some(col => col.tabItems.some(t => t.id === shell.id)));
});

// 归属与「自成独立列」是两件互斥的事：同时成立会让同一个标签在两处可见。
// 关闭分组后 hostGroupId 悬空，必须被自愈清掉。
test('hosting a leaf clears ownColumn and is repaired when the group is gone', () => {
    const ws = fresh();
    const other = addContainerTab(ws, { id: 'grp-2', groupId: 'g2' });
    const shell = addShell(ws);
    setColumnSplit(ws, true);
    setLeafColumnMode(ws, shell.id, 'ownColumn');
    assert.equal(buildRenderPlan(ws).columns.length, 3);

    assert.equal(setLeafHostGroup(ws, shell.id, other.id), true);
    assert.equal(leafColumnMode(shell), 'row', '挂进分组就不再是独立列');
    assert.equal(buildRenderPlan(ws).columns.length, 2);

    // 传入不存在的分组：拒绝写入，不静默落一个悬空 id。
    assert.equal(setLeafHostGroup(ws, shell.id, 'no-such-group'), false);
    assert.equal(leafHostGroup(ws, shell), other.id);

    closeTab(ws, other.id);
    const repaired = validateAndRepair(ws);
    assert.ok(repaired.ok);
    assert.ok(repaired.repairs.some(text => text.includes('hostGroupId')), repaired.repairs);
    assert.equal(leafHostGroup(ws, shell), null);
});

// 未分屏时不能套用上面那一支：那时 column.id 与焦点所在的叶无关，
test('a root leaf column does not hijack the panel while split is off', () => {
    const ws = fresh();
    const main = findLeaf(ws, 'main');
    const shell = addShell(ws);
    setColumnSplit(ws, false);
    activateTab(ws, main.id);

    const plan = buildRenderPlan(ws);
    assert.deepEqual(plan.panelIds, [main.id]);
    assert.ok(!plan.panelIds.includes(shell.id), '未分屏时 shell 不得顶替焦点面板');
});

// ---------------------------------------------------------------------------
// §4.2 pane 分屏
// ---------------------------------------------------------------------------

test('pane split creates a second pane and one subRow per pane', () => {
    const ws = fresh();
    setColumnSplit(ws, true);                // 分屏让容器不再走族列，便于观察 subRow
    addContainerTab(ws, { id: 'grp-2', groupId: 'g2' });

    const container = Object.values(ws.tabs).find(isContainer);
    assert.equal(setPaneSplit(ws, container.id, true), true);
    assert.equal(container.paneSplit.enabled, true);
    assert.ok(container.panes.length >= 2);

    const col = layoutColumns(ws).find(c => c.containerId === container.id);
    assert.equal(layoutRowsOf(ws, col).length, container.panes.length);
});

test('flat mode with pane split still renders the subRows required by I9', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    setPaneSplit(ws, container.id, true);

    const plan = buildRenderPlan(ws);
    // 扁平时容器不占独立列，行数必须落在它所在的那一列上
    const col = plan.columns[0];
    assert.equal(col.rows.length, 2);
    assert.deepEqual(validateAndRepair(ws).repairs, []);
});

// 方案 A 的扁平 + pane 分屏：子项全部落到各自 subRow，一级行不得再重复列一遍。
// 反向对照：把一级行改成「容器全部子项」后，下面的 disjoint 断言必须失败。
test('flat mode with pane split keeps the top row free of duplicated pane children', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    const main = findLeaf(ws, 'main');
    addLeaf(ws, 'filter');
    setPaneSplit(ws, container.id, true);

    const plan = buildRenderPlan(ws);
    const col = plan.columns[0];
    const topIds = col.tabItems.map(item => item.id);
    const subIds = col.rows.flatMap(row => row.tabs.map(item => item.id));

    assert.equal(subIds.includes(main.id), true, 'main 必须在自己那条 subRow 里');
    assert.equal(topIds.includes(main.id), false, '一级行不能再列一遍 main');
    assert.equal(new Set([...topIds, ...subIds]).size, topIds.length + subIds.length,
        '一级行与 subRow 的标签不得重叠');
});

test('flat mode with pane split still puts unowned shells on the top row', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    setPaneSplit(ws, container.id, true);
    const shell = addShell(ws);

    const plan = buildRenderPlan(ws);
    const topIds = plan.columns[0].tabItems.map(item => item.id);
    const subIds = plan.columns[0].rows.flatMap(row => row.tabs.map(item => item.id));

    assert.deepEqual(topIds, [shell.id], '一级行只应剩未归属 Shell');
    assert.equal(subIds.includes(shell.id), false, 'Shell 绝不能进 subRow（I1/I2）');
});

// ---------------------------------------------------------------------------
// §8.1 激活
// ---------------------------------------------------------------------------

test('activating a leaf updates the focus and its pane active tab', () => {
    const ws = fresh();
    const filter = addLeaf(ws, 'filter');
    const main = findLeaf(ws, 'main');
    activateTab(ws, main.id);
    activateTab(ws, filter.id);

    const hit = model.paneOfTab(ws, filter);
    assert.equal(ws.focusedTabId, filter.id);
    assert.equal(hit.pane.activeTabId, filter.id);
});

test('activating a container does not steal the focus of its active leaf', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    const filter = addLeaf(ws, 'filter');
    activateTab(ws, container.id);
    assert.equal(ws.focusedTabId, container.id);
    assert.equal(container.panes[0].activeTabId, filter.id);
});

// ---------------------------------------------------------------------------
// §8.2 拖拽只允许同栏重排
// ---------------------------------------------------------------------------

test('root reorder rewrites order contiguously and rejects non-root tabs', () => {
    const ws = fresh();
    const shell = addShell(ws);
    assert.equal(reorderInRow(ws, { kind: 'roots' }, shell.id, 0), true);

    const order = model.roots(ws).map(tab => tab.id);
    assert.equal(order[0], shell.id);
    assert.deepEqual(model.roots(ws).map(tab => tab.order), [0, 1]);

    const main = findLeaf(ws, 'main');
    assert.equal(reorderInRow(ws, { kind: 'roots' }, main.id, 0), false);
});

test('pane reorder refuses cross-pane moves', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    setPaneSplit(ws, container.id, true);
    const pane2 = container.panes[1];

    // pane2 的叶不可能通过 pane1 的重排接口挪过去
    assert.equal(reorderInRow(ws, { kind: 'pane', containerId: container.id, paneId: container.panes[0].id },
        pane2.tabIds[0], 0), false);
});

// ---------------------------------------------------------------------------
// §8.3 收起
// ---------------------------------------------------------------------------

test('collapsing is only allowed when there is a second row', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    assert.equal(setCollapsed(ws, container.id, true), false);   // 只有一行

    setPaneSplit(ws, container.id, true);
    assert.equal(setCollapsed(ws, container.id, true), true);
    assert.equal(container.collapsed, true);
});

// ---------------------------------------------------------------------------
// 关闭
// ---------------------------------------------------------------------------

test('closing the last leaf of a pane backfills a main leaf (I5)', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    const pane = container.panes[0];
    const onlyLeaf = pane.tabIds[0];

    assert.equal(closeTab(ws, onlyLeaf), true);
    assert.equal(pane.tabIds.length, 1);
    assert.notEqual(pane.tabIds[0], onlyLeaf);
    assert.equal(ws.tabs[pane.tabIds[0]].kind, 'main');
});

test('closing a shell keeps focus valid (I7)', () => {
    const ws = fresh();
    const shell = addShell(ws);
    activateTab(ws, shell.id);
    assert.equal(closeTab(ws, shell.id), true);
    assert.ok(model.tabOf(ws, ws.focusedTabId));
    assert.deepEqual(acceptance.assertAll(withDiagnostics(ws)), []);
});

// ---------------------------------------------------------------------------
// §4.5 normalizeSizes
// ---------------------------------------------------------------------------

test('normalizeSizes always returns weights summing to one', () => {
    const out = normalizeSizes({ a: 2, b: 1, gone: 9 }, ['a', 'b', 'c']);
    assert.deepEqual(Object.keys(out).sort(), ['a', 'b', 'c']);
    const sum = out.a + out.b + out.c;
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.equal(out.a / out.b, 2);
});

test('normalizeSizes falls back to equal shares for broken input', () => {
    const out = normalizeSizes({ a: 0, b: -5 }, ['a', 'b']);
    assert.ok(Math.abs(out.a - 0.5) < 1e-9);
    assert.ok(Math.abs(out.b - 0.5) < 1e-9);
});

// ---------------------------------------------------------------------------
// §6.2 自愈
// ---------------------------------------------------------------------------

test('validateAndRepair pulls a shell out of a pane (I1/I2)', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    const shell = addShell(ws);
    dropShellIntoPane(ws, container, shell);
    assert.notDeepEqual(acceptance.assertAll(withDiagnostics(ws)), []);

    const result = validateAndRepair(ws);
    assert.equal(result.fatal, false);
    assert.deepEqual(acceptance.assertAll(withDiagnostics(ws)), []);
    assert.equal(shell.parentId, null);
});

function dropShellIntoPane(ws, container, shell) {
    // 模拟一次非法写入：shell 被塞进 pane
    shell.parentId = container.id;
    container.panes[0].tabIds.push(shell.id);
}

// ---------------------------------------------------------------------------
// 验收器必须真的会失败（反向对照，防止断言恒真）
// ---------------------------------------------------------------------------

test('acceptance catches a broken tree instead of always passing', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    container.panes[0].tabIds.push('ghost-tab');
    assert.notDeepEqual(acceptance.assertAll(withDiagnostics(ws)), []);

    const ws2 = fresh();
    ws2.focusedTabId = 'nope';
    assert.ok(acceptance.assertAll(withDiagnostics(ws2)).some(e => e.startsWith('I7')));
});

// ---------------------------------------------------------------------------
// 固定种子随机性质测试
// ---------------------------------------------------------------------------

function makeRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function pick(rand, list) {
    return list[Math.floor(rand() * list.length)];
}

function applyRandomOperation(ws, rand) {
    const leaves = Object.values(ws.tabs).filter(tab => !isContainer(tab));
    const containers = Object.values(ws.tabs).filter(isContainer);
    const container = containers.length ? pick(rand, containers) : null;

    switch (Math.floor(rand() * 9)) {
        case 0:
            if (container) addLeaf(ws, pick(rand, ['filter', 'chart']), container.id);
            break;
        case 1:
            if (groupCount(ws) < 3) addContainerTab(ws, {});
            break;
        case 2:
            if (groupCount(ws) < 3) addShell(ws);
            break;
        case 3:
            if (leaves.length) activateTab(ws, pick(rand, leaves).id);
            break;
        case 4:
            if (container) setPaneSplit(ws, container.id, !container.paneSplit.enabled);
            break;
        case 5:
            setColumnSplit(ws, !ws.split.enabled);
            break;
        case 6:
            if (container && container.paneSplit.enabled) setCollapsed(ws, container.id, !container.collapsed);
            break;
        case 7: {
            // 关闭一个叶，但保留最后一个容器里的 main，避免工作区被关空
            const closable = leaves.filter(tab => tab.kind !== 'main');
            if (closable.length) closeTab(ws, pick(rand, closable).id);
            break;
        }
        case 8: {
            if (!container) break;
            const pane = pick(rand, container.panes);
            if (pane.tabIds.length > 1) {
                reorderInRow(ws, { kind: 'pane', containerId: container.id, paneId: pane.id },
                    pane.tabIds[0], 1);
            }
            break;
        }
        default:
            break;
    }
}

test('random operation sequences preserve every invariant', () => {
    for (let seed = 1; seed <= 120; seed++) {
        resetIdSeq();
        const ws = createWorkspace();
        const rand = makeRandom(seed);

        for (let step = 0; step < 120; step++) {
            applyRandomOperation(ws, rand);
            const errors = acceptance.assertAll(withDiagnostics(ws));
            assert.deepEqual(errors, [], `seed=${seed} step=${step}`);
        }

        // 每个随机序列结束后，自愈必须是幂等的
        validateAndRepair(ws);
        assert.deepEqual(acceptance.assertAll(withDiagnostics(ws)), [], `seed=${seed} after repair`);
    }
});

test('render plan never shows the same tab in two places', () => {
    for (let seed = 1; seed <= 40; seed++) {
        resetIdSeq();
        const ws = createWorkspace();
        const rand = makeRandom(seed);
        for (let step = 0; step < 60; step++) applyRandomOperation(ws, rand);

        const plan = buildRenderPlan(ws);
        const ids = rowIdsOf(plan);
        // shell / 容器 可能同时作为 tabItems 与 panelIds 出现，这里只看定位信息
        const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
        assert.deepEqual(dupes, [], `seed=${seed} 重复定位 ${dupes.join(',')}`);
    }
});
// ---------------------------------------------------------------------------
// 逐条反向对照：每条不变式被破坏时，验收器必须报出来
// ---------------------------------------------------------------------------
//
// 只测「合法数据能通过」是不够的——断言可能根本没在检查。
// 这里为 I1–I10 各造一个最小违规，确认对应条目会被点名。

function expectRule(ws, ruleId) {
    const errors = acceptance.assertAll(withDiagnostics(ws));
    assert.ok(
        errors.some(message => message.startsWith(ruleId)),
        `${ruleId} 未被检出，实际错误：${errors.join(' | ') || '（无）'}`
    );
}

test('I1 is really checked: a shell under a container is reported', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    const shell = addShell(ws);
    shell.parentId = container.id;
    expectRule(ws, 'I1');
});

test('I2 is really checked: a shell listed in a pane is reported', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    const shell = addShell(ws);
    container.panes[0].tabIds.push(shell.id);
    model.rebuildIndex(ws);
    expectRule(ws, 'I2');
});

test('I3 is really checked: a container holding a panel is reported', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    container.panel = { id: container.id };
    expectRule(ws, 'I3');
});

test('I4 is really checked: a tab listed in two panes is reported', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    setPaneSplit(ws, container.id, true);
    const leaf = container.panes[0].tabIds[0];
    container.panes[1].tabIds.push(leaf);
    expectRule(ws, 'I4');
});

test('I5 is really checked: an empty pane is reported', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    setPaneSplit(ws, container.id, true);
    container.panes[1].tabIds = [];
    container.panes[1].activeTabId = null;
    expectRule(ws, 'I5');
});

test('I6 is really checked: an activeTabId outside its pane is reported', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    const shell = addShell(ws);
    container.panes[0].activeTabId = shell.id;
    expectRule(ws, 'I6');
});

test('I7 is really checked: a dangling focus is reported', () => {
    const ws = fresh();
    ws.focusedTabId = 'does-not-exist';
    expectRule(ws, 'I7');
});

test('I8 is really checked: missing judgement hook is reported', () => {
    const ws = fresh();
    const bare = Object.assign({}, ws);          // 不带 visiblePanels
    const errors = acceptance.assertAll(bare);
    assert.ok(errors.some(message => message.startsWith('I8')));
});

test('I9 is really checked: flat + split with a single pane is reported', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    container.paneSplit.enabled = true;          // 只置位，不真的加 pane
    expectRule(ws, 'I9');
});

test('I10 is really checked: collapsing a single-row container is reported', () => {
    const ws = fresh();
    const container = Object.values(ws.tabs).find(isContainer);
    container.collapsed = true;                  // 绕过 setCollapsed 的保护
    expectRule(ws, 'I10');
});
