'use strict';

// 把渲染层现有的三份标签状态投影成 tab-model 认识的标签树。
//
// 为什么需要这一层：S2 要让渲染读 buildRenderPlan()，但真正的「换真源」要等
// S5 的配置迁移。在迁移之前，数据仍分散在 serialGroups / filter+chart store /
// shellTabs 里。这个函数把那份现状**只读**投影成一棵树，用来做两件事：
//
//   1. 影子校验：拿模型算出的渲染计划与真实 DOM 对比，用证据证明模型与现状一致；
//   2. 后续翻转：renderWorkspace() 之后可以直接消费这份投影。
//
// 它不修改任何输入，也不持有引用；每次调用返回全新对象。

const { createLeaf, isContainer, rebuildIndex } = require('./tab-model');

function pickTitle(source, fallback) {
    if (!source) return fallback;
    const title = source.title ?? source.name ?? source.label;
    return typeof title === 'string' && title.trim() ? title : fallback;
}

function normalizeTabIds(list, kind) {
    if (!Array.isArray(list)) return [];
    return list
        .filter(tab => tab && typeof tab.id === 'string')
        .map(tab => ({ id: tab.id, kind: tab.kind || kind, title: pickTitle(tab, tab.id) }));
}

// 与 serial-group-dom.js 的 mainTabId() 逐字一致：默认分组无后缀。
// 必须对齐真实 DOM id，否则影子校验比对的就不是同一个节点。
function defaultMainTabId(groupId) {
    return groupId === 'default' ? 'tab-main' : `tab-main-${String(groupId).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

// 与 renderer.js 的 isShellTabId() 同一条规则。
function isShellId(id) {
    return typeof id === 'string' && /^tab-shell-\d+$/.test(id);
}


// sections: {
//   groups: [{ id, title, panes: [{ id, tabIds, activeTabId }], paneSplit,
//              collapsed, order }],
//   filterTabs: { [groupId]: [{ id, title }] },
//   chartTabs:  { [groupId]: [{ id, title }] },
//   shellTabs:  [{ id, title }],
//   activeGroupId,
//   focusedTabId,
//   split: { enabled, orientation, sizes }
// }
//
// 「一个串口组的一个 pane」在现状里同时承载 main / filter / chart 三类标签：
//   pane 行的固定主标签（main-<groupId>-<paneIndex>）
//   该组该 pane 的 filter 标签
//   该组该 pane 的 chart 标签
// 投影时按这个顺序拼接，与 pane 行里实际的排列一致。
function projectWorkspace(sections) {
    const src = sections || {};
    const groups = Array.isArray(src.groups) ? src.groups : [];
    const tabs = {};

    for (const group of groups) {
        if (!group || typeof group.id !== 'string') continue;
        const panes = Array.isArray(group.panes) && group.panes.length
            ? group.panes
            : [{ id: `${group.id}-pane-1`, tabIds: [], activeTabId: null }];

        // 主标签：每个分组只有一个（serial-group-dom 的 mainTabId(groupId)），
        // 且必须落在 panes[0]——workspace-layout-shape 就是 unshift 进第一个 pane。
        // 按 pane 各造一个 main 会把 pane 数与 id 同时写错。
        const mainId = typeof group.mainTabId === 'string'
            ? group.mainTabId
            : defaultMainTabId(group.id);
        const mainLeaf = createLeaf('main', { id: mainId });
        tabs[mainLeaf.id] = mainLeaf;

        // store 里**任何 pane 都没认领**的 filter/chart，才是候补。
        // 漏掉「已被别的 pane 认领」的排除会引发一串错位：pane-1 先拿到 filter，
        // 轮到 pane-2 时它已存在，pane-2 就变空；随后 pane-2 的 activeTabId 被回退，
        // 模型算出的面板集与真实显示彻底脱钐。
        const claimed = new Set();
        panes.forEach(pane => {
            (pane && Array.isArray(pane.tabIds) ? pane.tabIds : []).forEach(id => claimed.add(id));
        });
        const unassigned = [
            ...normalizeTabIds((src.filterTabs || {})[group.id], 'filter'),
            ...normalizeTabIds((src.chartTabs || {})[group.id], 'chart')
        ].filter(item => !tabs[item.id] && !claimed.has(item.id));

        const projectedPanes = panes.map((pane, index) => {
            const paneId = pane && typeof pane.id === 'string'
                ? pane.id
                : `${group.id}-pane-${index + 1}`;
            const ids = [];

            // 真实 pane.tabIds 只决定**归属与顺序**；store 里的标签即使暂时不在 pane 里
            // 也必须投影出来——漏掉它们会让影子校验把现存的标签当成多余。shell 不进
            // pane（I1/I2），无论真实 tabIds 里有没有它。
            const declared = pane && Array.isArray(pane.tabIds) ? pane.tabIds : [];
            const push = (id, kind) => {
                if (typeof id !== 'string' || tabs[id]) return;
                const leaf = createLeaf(kind, { id });
                tabs[leaf.id] = leaf;
                ids.push(leaf.id);
            };
            for (const id of declared) {
                if (tabs[id] || isShellId(id)) continue;
                push(id, id === mainId ? 'main' : 'tab');
            }

            // 主标签只属于 panes[0]（与 workspace-layout-shape 的 unshift 一致）。
            // 不能“哪个 pane 空了就补一个 main”：每个分组只有一个 main 叶，
            // 补到第二个 pane 就是同一个标签同时属于两个 pane。
            if (index === 0 && !ids.includes(mainId)) ids.unshift(mainId);

            // store 里尚未被任何 pane 认领的标签，只补给**真实布局里为空**的 pane（或主 pane）。
            // 不能补给已经有真实标签的 pane：那会把 pane-2 自己的标签拽进 pane-1，
            // 造成模型与真实布局错位（影子校验曾在实机上抓到这一点）。
            const wantsTopUp = index === 0 || ids.length === 0;
            while (wantsTopUp && unassigned.length && ids.length) {
                const item = unassigned.shift();
                push(item.id, item.kind);
            }

            // activeTabId 可能是被过滤掉的 shell，不能因此把 pane 判成空的。
            let activeTabId = pane && typeof pane.activeTabId === 'string'
                ? pane.activeTabId
                : null;
            if (!ids.includes(activeTabId)) activeTabId = ids[0] || null;

            return { id: paneId, tabIds: ids, activeTabId };
        });

        const container = {
            id: group.id,
            kind: 'group',
            groupId: group.id,
            parentId: null,
            order: typeof group.order === 'number' ? group.order : groups.indexOf(group),
            title: pickTitle(group, group.id),
            collapsed: group.collapsed === true,
            paneSplit: {
                enabled: Boolean(group.paneSplit && group.paneSplit.enabled),
                orientation: (group.paneSplit && group.paneSplit.orientation) || 'horizontal',
                sizes: (group.paneSplit && group.paneSplit.sizes) || {}
            },
            panes: projectedPanes
        };
        tabs[container.id] = container;
    }

    // shell 永远在根级（I1 / I2）
    const shellStart = groups.length;
    normalizeTabIds(src.shellTabs, 'shell').forEach((item, index) => {
        const leaf = createLeaf('shell', { id: item.id });
        leaf.parentId = null;
        leaf.order = shellStart + index;
        tabs[leaf.id] = leaf;
    });

    const ws = {
        tabs,
        focusedTabId: typeof src.focusedTabId === 'string' ? src.focusedTabId : null,
        split: {
            enabled: Boolean(src.split && src.split.enabled),
            orientation: (src.split && src.split.orientation) || 'horizontal',
            sizes: (src.split && src.split.sizes) || {}
        }
    };

    rebuildIndex(ws);

    // 焦点失效时回落到第一个容器的激活叶，保证 I7 成立
    if (!ws.tabs[ws.focusedTabId]) {
        const first = Object.values(ws.tabs).find(isContainer);
        ws.focusedTabId = first && first.panes[0] ? first.panes[0].activeTabId : null;
    }

    return ws;
}

module.exports = { projectWorkspace };
