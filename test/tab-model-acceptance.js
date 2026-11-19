'use strict';

// 标签树模型的独立验收器。
//
// 它刻意不 require 模型内部的任何实现：判据全部按数据结构本身的形状与关系
// 重算，因此模型改实现、改函数名都不会让验收跟着失效；反过来，模型里真实的
// 结构违规也没法借它自己的派生量把验收带偏。
//
// 校验的是 TAB_ARCHITECTURE.md §6 定义的 I1–I10，一条不多、一条不少。

const DOC_PATH = 'docs/TAB_ARCHITECTURE.md';

const INVARIANT_IDS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10'];

// 从文档表格里取某条不变式那句话。
// 返回 null 表示文档里没有这一条——调用方应因此判失败，防止文档条目被悄悄删掉。
function ruleTextFromDoc(docText, id) {
    const re = new RegExp(`\\|\\s*\\*\\*${id}\\*\\*\\s*\\|([^|]*)\\|`);
    const m = docText.match(re);
    return m ? m[1].trim() : null;
}

function isObj(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isContainerTab(tab) {
    return isObj(tab) && Array.isArray(tab.panes);
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

// 独立重算「每个 Tab 出现在哪些 pane 里」，不信任 parentId。
function collectPaneMembership(ws, errors) {
    const seen = new Map();
    for (const tab of Object.values(ws.tabs)) {
        if (!isContainerTab(tab)) continue;
        for (const pane of tab.panes) {
            if (!isObj(pane) || !Array.isArray(pane.tabIds)) {
                errors.push(`I4 容器 ${tab.id} 的 panes 项结构非法`);
                continue;
            }
            const local = new Set();
            for (const id of pane.tabIds) {
                if (local.has(id)) errors.push(`I4 pane ${pane.id} 内重复 id ${id}`);
                local.add(id);
                const owner = seen.get(id);
                if (owner) errors.push(`I4 ${id} 同时属于 ${owner} 与 ${tab.id}`);
                seen.set(id, tab.id);
                if (!hasOwn(ws.tabs, id)) {
                    errors.push(`I4 pane ${pane.id} 引用了不存在的 Tab ${id}`);
                }
            }
        }
    }
    return seen;
}

function checkInvariants(ws) {
    const errors = [];
    const tabIds = Object.keys(ws.tabs || {});
    const containerIds = tabIds.filter(id => isContainerTab(ws.tabs[id]));

    // 多组模式中 Shell 保持根级；单组模式下允许同样的 pane 成员结构。
    if (containerIds.length > 1) {
        for (const id of tabIds) {
            const tab = ws.tabs[id];
            if (tab.kind === 'shell' && tab.parentId !== null) {
                errors.push(`I1 shell ${id} 在多组模式下的 parentId 不是 null`);
            }
        }
        for (const id of containerIds) {
            for (const pane of ws.tabs[id].panes) {
                for (const childId of pane.tabIds || []) {
                    const child = ws.tabs[childId];
                    if (child && child.kind === 'shell') {
                        errors.push(`I2 多组模式的 pane ${pane.id} 里出现了 shell ${childId}`);
                    }
                }
            }
        }
    }

    // I3：叶有且只有一个 panel 且 panel.id === tab.id；容器没有 panel
    for (const id of tabIds) {
        const tab = ws.tabs[id];
        const hasPanel = tab.panel !== undefined && tab.panel !== null;
        if (isContainerTab(tab)) {
            if (hasPanel) errors.push(`I3 容器 ${id} 不应有 panel`);
        } else if (!hasPanel) {
            errors.push(`I3 叶 ${id} 缺少 panel`);
        } else if (tab.panel.id !== id) {
            errors.push(`I3 ${id} 的 panel.id 与自身不一致`);
        }
    }
    const panelIds = tabIds.filter(id => ws.tabs[id].panel).map(id => ws.tabs[id].panel.id);
    if (new Set(panelIds).size !== panelIds.length) errors.push('I3 panel.id 有重复');

    // I4：非根级恰属一个 pane；根级不属于任何 pane
    const membership = collectPaneMembership(ws, errors);
    for (const id of tabIds) {
        const inPane = membership.has(id);
        if (ws.tabs[id].parentId === null && inPane) {
            errors.push(`I4 根级 ${id} 不应出现在任何 pane 中`);
        }
        if (ws.tabs[id].parentId !== null && !inPane) {
            errors.push(`I4 非根级 ${id} 不在任何 pane 中`);
        }
    }

    // I5：容器至少有一个 pane；每个 pane 的 tabIds 非空
    for (const id of containerIds) {
        const tab = ws.tabs[id];
        if (tab.panes.length === 0) errors.push(`I5 容器 ${id} 没有 pane`);
        for (const pane of tab.panes) {
            if (!pane.tabIds || pane.tabIds.length === 0) {
                errors.push(`I5 pane ${pane.id} 的 tabIds 为空`);
            }
        }
    }

    // I6：activeTabId 必须是本 pane 的 tabIds 成员
    for (const id of containerIds) {
        for (const pane of ws.tabs[id].panes) {
            if (pane.activeTabId === null || pane.activeTabId === undefined) continue;
            if (!pane.tabIds.includes(pane.activeTabId)) {
                errors.push(`I6 pane ${pane.id} 的 activeTabId 不在自身 tabIds 中`);
            }
        }
    }

    // I7：focusedTabId 必须指向真实节点
    if (!hasOwn(ws.tabs, ws.focusedTabId)) {
        errors.push(`I7 focusedTabId ${ws.focusedTabId} 不存在`);
    }

    // I8：显隐只由 visiblePanels() 决定
    // 模型必须导出这套判据；这里还核验它是纯读（调用两次结果一致）。
    if (typeof ws.visiblePanels !== 'function') {
        errors.push('I8 缺少 visiblePanels 判据');
    } else {
        const a = [...ws.visiblePanels()].sort().join('|');
        const b = [...ws.visiblePanels()].sort().join('|');
        if (a !== b) errors.push('I8 visiblePanels() 两次调用结果不一致');
    }

    // I9：扁平且开了 pane 分屏时，必须真有可显示的 subRow
    const flat = containerIds.length <= 1;
    if (flat) {
        for (const id of containerIds) {
            const tab = ws.tabs[id];
            const splitEnabled = Boolean(tab.paneSplit && tab.paneSplit.enabled);
            if (!splitEnabled) continue;
            const rows = tab.panes.length;
            if (rows < 2) errors.push(`I9 ${id} 扁平且开了 pane 分屏，但只有 ${rows} 条行`);
        }
    }

    // I10：只有 subRow 数 ≥ 2 时才允许 collapsed
    for (const id of tabIds) {
        const tab = ws.tabs[id];
        if (!tab.collapsed) continue;
        if (!isContainerTab(tab)) {
            errors.push(`I10 非容器 ${id} 不能 collapsed`);
            continue;
        }
        const rows = tab.paneSplit && tab.paneSplit.enabled ? tab.panes.length : 1;
        if (rows < 2) errors.push(`I10 ${id} 只有 ${rows} 条行却处于 collapsed`);
    }

    return errors;
}

function assertAll(ws) {
    return checkInvariants(ws);
}

module.exports = {
    DOC_PATH,
    INVARIANT_IDS,
    ruleTextFromDoc,
    checkInvariants,
    assertAll
};
