'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_GROUP_PANE_COUNT,
  GROUP_WORKSPACE_CONTAINER_ID,
  GROUP_WORKSPACE_SPLITTER_ID,
  groupWorkspaceSuffix,
  groupWorkspaceRootId,
  groupPaneId,
  groupSplitterId,
  groupWorkspaceContainerId,
  groupWorkspaceEntryId,
  groupTabRowId,
  groupTabListId,
  SHELL_COLUMN_GROUP_ID,
  shellColumnId,
  shellTabRowId,
  shellTabListId,
  shellWorkspaceRootId,
  shellPaneId,
  shellPaneTabsContentId,
  resolveGroupWorkspaceEntries,
  describeGroupPanes,
  describeGroupWorkspace,
  findMissingGroupPaneIds
} = require('../serial-group-layout-dom');

const root = path.join(__dirname, '..');

test('the default group reuses the exact static workspace ids', () => {
  // 这是整份契约最重要的一条，理由不是「省事」而是**启动时序**：
  // 默认分组的 xterm 在 renderer.js 模块加载期就 open(#serial-container) 了，
  // 而 #serial-container 位于静态 pane-1 内。默认分组的三个 id 只要与静态标记
  // 逐字一致，这条启动路径就完全不受两级分屏重构影响。
  assert.equal(groupWorkspaceSuffix('default'), '');
  assert.equal(groupWorkspaceRootId('default'), 'workspace-root');
  assert.equal(groupPaneId('default', 1), 'pane-1');
  assert.equal(groupPaneId('default', 2), 'pane-2');
  assert.equal(groupSplitterId('default'), 'workspace-splitter');
});

test('default group pane ids match the real static markup in index.html', () => {
  // 防止契约与静态标记漂移。前一条只证明函数返回字符串，这条证明那些字符串
  // 真的存在于页面里——否则整套 id 计算就是自说自话。
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /id="workspace-root"/);
  assert.match(html, /id="pane-1"/);
  assert.match(html, /id="workspace-splitter"/);
});

test('non-default groups get suffixed ids that cannot collide with the default ones', () => {
  const ids = ['default', 'g-1', 'g-2', 'g-10'].map(id => groupPaneId(id, 1));
  assert.deepEqual(new Set(ids).size, ids.length);
  assert.equal(groupPaneId('g-1', 1), 'pane-1-g-1');
  assert.equal(groupPaneId('g-1', 2), 'pane-2-g-1');
  assert.equal(groupWorkspaceRootId('g-1'), 'workspace-root-g-1');
  assert.equal(groupSplitterId('g-1'), 'workspace-splitter-g-1');
});

test('the suffix sits at the tail so prefix lookups still work', () => {
  // 与 serial-container-<g> 同一取舍：保持 'pane-<n>' 前缀，
  // [id^="pane-"] 这类批量查找才可能生效。
  assert.ok(groupPaneId('g-1', 1).startsWith('pane-'));
  assert.ok(groupPaneId('g-1', 1).endsWith('-g-1'));
});

test('dirty group ids are sanitized instead of producing invalid selectors', () => {
  // 配置是用户可编辑的文本文件；含空格或冒号的 id 直接进 querySelector 会抛 SyntaxError。
  const id = groupPaneId('my port:1', 1);
  assert.equal(id, 'pane-1-my_port_1');
  assert.doesNotThrow(() => new Function(`return document.querySelector('[id="${id}"]')`));
});

test('pane index is clamped to a positive integer', () => {
  assert.equal(groupPaneId('default', 0), 'pane-1');
  assert.equal(groupPaneId('default', -3), 'pane-1');
  assert.equal(groupPaneId('default', 2.7), 'pane-2');
  assert.equal(groupPaneId('default', 'x'), 'pane-1');
});

test('empty or missing group ids fall back to the default group', () => {
  // normalizeGroupId 空串回落到 'default'，否则会得到永不存在的 'pane-1-'
  assert.equal(groupPaneId('', 1), 'pane-1');
  assert.equal(groupPaneId(null, 1), 'pane-1');
  assert.equal(groupWorkspaceSuffix(undefined), '');
});

test('describeGroupPanes yields the requested count and marks the primary one', () => {
  const panes = describeGroupPanes('g-2', { paneCount: 3 });
  assert.deepEqual(panes.map(pane => pane.paneId), ['pane-1-g-2', 'pane-2-g-2', 'pane-3-g-2']);
  assert.equal(panes[0].isPrimary, true);
  assert.equal(panes[1].isPrimary, false);
  assert.equal(panes[0].index, 1);
});

test('describeGroupPanes defaults to a single pane', () => {
  // 首版每个分组默认不分屏；分屏由布局层按需追加 pane。
  const panes = describeGroupPanes('g-1');
  assert.equal(panes.length, DEFAULT_GROUP_PANE_COUNT);
  assert.deepEqual(panes.map(pane => pane.paneId), ['pane-1-g-1']);
  assert.equal(describeGroupPanes('g-1', { paneCount: 0 }).length, 1);
});

test('describeGroupWorkspace bundles every id a group needs', () => {
  const workspace = describeGroupWorkspace('g-1', { paneCount: 2 });
  assert.equal(workspace.groupId, 'g-1');
  assert.equal(workspace.containerId, 'serial-group-workspace-g-1');
  assert.equal(workspace.rootId, 'workspace-root-g-1');
  assert.equal(workspace.splitterId, 'workspace-splitter-g-1');
  assert.deepEqual(workspace.paneIds, ['pane-1-g-1', 'pane-2-g-1']);
});

test('the outer container id is suffixed even for the default group', () => {
  // 与 pane/root/splitter 不同：外层容器是**新增**元素，没有静态标记依赖，
  // 统一带后缀可避免「默认分组的容器到底叫什么」这类特例记忆负担。
  assert.equal(groupWorkspaceContainerId('default'), 'serial-group-workspace-default');
  assert.equal(groupWorkspaceContainerId('g-1'), 'serial-group-workspace-g-1');
});

test('findMissingGroupPaneIds reports only panes absent from the DOM', () => {
  const workspace = describeGroupWorkspace('g-1', { paneCount: 3 });
  const missing = findMissingGroupPaneIds(workspace, paneId => paneId !== 'pane-2-g-1');
  assert.deepEqual(missing, ['pane-2-g-1']);
  assert.deepEqual(findMissingGroupPaneIds(workspace, () => true), []);
});

test('findMissingGroupPaneIds degrades safely without a predicate', () => {
  // 没有判据时返回全部 id —— 让调用方暴露出「忘了传」的问题，
  // 而不是静默认为「一个都不缺」。
  const workspace = describeGroupWorkspace('g-1', { paneCount: 2 });
  assert.deepEqual(findMissingGroupPaneIds(workspace), ['pane-1-g-1', 'pane-2-g-1']);
  assert.deepEqual(findMissingGroupPaneIds(null), []);
});

test('every group, including the default one, occupies its own column container', () => {
  // 外层条目就是「一个分组在分组级容器里占的那一列」。列内自上而下是
  // 「本组的分组标签行 → 本组的工作区（.workspace-root）」。
  //
  // 默认分组也要有自己的列（静态 #serial-group-workspace-default），否则它的分组
  // 标签只能挤在容器顶部的一条共享行里，与它自己那一列脱开。
  //
  // 「默认分组的 root/pane/splitter id 逐字不变」这条约束仍然成立：祖先链多一层
  // div 不会让 xterm 重新 open()，改 id 才会。
  assert.equal(groupWorkspaceEntryId('default'), 'serial-group-workspace-default');
  assert.equal(groupWorkspaceEntryId('g-1'), 'serial-group-workspace-g-1');
  assert.notEqual(groupWorkspaceEntryId('default'), groupWorkspaceRootId('default'));
});

test('resolveGroupWorkspaceEntries maps every group to its own outer entry', () => {
  // paneIds 必须跟着分组走：把默认分组的 pane-1 给 g-1 用，会两个分组抢同一个 DOM 节点，
  // 表现为「切了分组但界面没变」，且没有任何报错。
  const entries = resolveGroupWorkspaceEntries(['default', 'g-1']);
  assert.deepEqual(entries, [
    { groupId: 'default', entryId: 'serial-group-workspace-default', paneIds: ['pane-1'] },
    { groupId: 'g-1', entryId: 'serial-group-workspace-g-1', paneIds: ['pane-1-g-1'] }
  ]);
  assert.deepEqual(resolveGroupWorkspaceEntries(null), []);
  assert.deepEqual(resolveGroupWorkspaceEntries(['default', '']), [
    { groupId: 'default', entryId: 'serial-group-workspace-default', paneIds: ['pane-1'] }
  ]);
});

test('outer splitter ids match the real static markup in index.html', () => {
  // 与默认分组 pane 的那条同理：只断言函数返回字符串不够，必须证明这些 id 真的在页面里。
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(GROUP_WORKSPACE_CONTAINER_ID, 'group-workspace');
  assert.equal(GROUP_WORKSPACE_SPLITTER_ID, 'group-workspace-splitter');
  assert.match(html, /id="group-workspace"/);
  assert.match(html, /id="group-workspace"/);
  assert.match(html, /id="group-workspace-splitter"/);
});

test('the static column container and its in-column tab rows exist in index.html', () => {
  // 第 9 项（分组标签位于自己分组页上方）的静态前提。
  //
  // 默认分组必须真的有一层列容器，且它里面真的有分组标签行 —— 否则标签只能
  // 回落成容器顶部的一条共享行，与「在自己分组页上方」相背。
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(groupWorkspaceContainerId('default'), 'serial-group-workspace-default');
  assert.match(html, /id="serial-group-workspace-default"/);
  assert.match(html, /class="group-column serial-group-workspace" id="serial-group-workspace-default"/);
  // 静态分组标签行沿用改造前的两个 id，只是从容器顶层挪进了默认分组列的列首。
  assert.equal(groupTabRowId('default'), 'serial-group-tab-bar');
  assert.equal(groupTabListId('default'), 'serial-group-tab-list');
  assert.match(html, /class="group-tab-row serial-group-tab-bar" id="serial-group-tab-bar"/);
  // 非默认分组的行/列表 id 必须带后缀，否则两个分组会抢同一节点。
  assert.equal(groupTabRowId('g-1'), 'serial-group-tab-bar-g-1');
  assert.equal(groupTabListId('g-1'), 'serial-group-tab-list-g-1');
  assert.notEqual(groupTabRowId('default'), groupTabRowId('g-1'));
  assert.notEqual(groupTabListId('default'), groupTabListId('g-1'));
});

test('every group workspace id is unique across a realistic group set', () => {
  // 同一套规则作用在一组分组上时不得产生任何碰撞——碰撞的失败方式是两个分组
  // 抢同一个 DOM 节点，表现为「切了分组但界面没变」，没有报错。
  const groups = ['default', 'g-1', 'g-2', 'g-3'];
  const all = [];
  groups.forEach(groupId => {
    const workspace = describeGroupWorkspace(groupId, { paneCount: 2 });
    all.push(workspace.containerId, workspace.rootId, workspace.splitterId, ...workspace.paneIds);
  });
  assert.deepEqual(new Set(all).size, all.length);
});

test('the shell column ids reuse the group naming rules without colliding', () => {
  // Shell 独立列不是串口分组，但它必须能和真实分组共用同一套可见性遍历、
  // 分屏比例与 pane 布局运算 —— 否则就会在二十多处出现「这是不是 shell」的分支。
  // 前提是它算出来的 id 属于同一形态且与任何真实分组都不碰撞。
  const groups = ['default', 'g-1', 'g-2', 'g-3'];

  assert.equal(SHELL_COLUMN_GROUP_ID, '__shell__');
  assert.equal(shellColumnId(), groupWorkspaceContainerId(SHELL_COLUMN_GROUP_ID));
  assert.equal(shellTabRowId(), groupTabRowId(SHELL_COLUMN_GROUP_ID));
  assert.equal(shellTabListId(), groupTabListId(SHELL_COLUMN_GROUP_ID));
  assert.equal(shellPaneId(), groupPaneId(SHELL_COLUMN_GROUP_ID, 1));
  assert.equal(shellPaneTabsContentId(), `${shellPaneId()}-tabs-content`);

  const shellIds = [
    shellColumnId(), shellTabRowId(), shellTabListId(),
    shellWorkspaceRootId(), shellPaneId(), shellPaneTabsContentId()
  ];
  // 六个自身 id 必须互不相同：重复意味着列首行与 pane 行抢同一个节点。
  assert.deepEqual(new Set(shellIds).size, shellIds.length);

  // 也不能与任何真实分组的对应 id 碰撞。
  groups.forEach(groupId => {
    assert.notEqual(shellColumnId(), groupWorkspaceContainerId(groupId));
    assert.notEqual(shellTabRowId(), groupTabRowId(groupId));
    assert.notEqual(shellTabListId(), groupTabListId(groupId));
    assert.notEqual(shellWorkspaceRootId(), groupWorkspaceRootId(groupId));
    assert.notEqual(shellPaneId(), groupPaneId(groupId, 1));
  });
});
