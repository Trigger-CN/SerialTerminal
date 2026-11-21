'use strict';

const model = require('./tab-model');
const { importLegacyLayout } = require('./layout-migration');
const VERSION = 2;
const WORKSPACE_CONFIG_VERSION = 17;
const copy = value => JSON.parse(JSON.stringify(value));
const list = value => Array.isArray(value) ? value : [];

function serializeWorkspaceLayout(ws) {
    const errors = model.validateLayout(ws);
    if (errors.length) throw new Error(`不能保存无效布局: ${errors.join('; ')}`);
    return { version: VERSION, focusedTabId: ws.focusedTabId, layout: copy(ws.layout),
        groups: Object.values(ws.tabs).filter(model.isContainer).map(group => ({ id: group.id, order: group.order, collapsed: group.collapsed === true,
            ...(group.focusedTabId ? { focusedTabId: group.focusedTabId } : {}) })) };
}
function restoreWorkspaceLayout(baseline, saved) {
    if (!saved) return baseline.layout ? copy(baseline) : importLegacyLayout(baseline);
    if (saved.version === 1) return importLegacyLayout(baseline, saved);
    if (saved.version !== VERSION) throw new Error(`不支持的工作区布局版本: ${saved.version}`);
    return require('./layout-recovery').recoverLayout(baseline, saved);
}
function migrateWorkspaceLayoutConfig(config) {
    const { importWorkspace } = require('./tabs-workspace-projection');
    const sourceGroups = list(config.serialGroups);
    const usedIds = new Set(sourceGroups.flatMap(group => [group.id, group.mainTabId
        || (group.id === 'default' ? 'tab-main' : `tab-main-${String(group.id).replace(/[^A-Za-z0-9_-]/g, '_')}`)]));
    const cleanTabs = entries => list(entries).filter(tab => {
        if (!tab || typeof tab.id !== 'string' || !tab.id.trim() || usedIds.has(tab.id)
            || Object.prototype.hasOwnProperty.call(Object.prototype, tab.id)) return false;
        usedIds.add(tab.id); return true;
    });
    const shellTabs = cleanTabs(config.shellTabs);
    const groups = sourceGroups.map(group => ({ ...group, filterTabs: cleanTabs(group.filterTabs), chartTabs: cleanTabs(group.chartTabs) }));
    const sections = { groups: groups.map(group => ({ ...group, activePaneId: group.paneSplit?.activePaneId,
        panes: group.panes || group.workspaceLayout?.panes })),
        filterTabs: Object.fromEntries(groups.map(group => [group.id, group.filterTabs || []])),
        chartTabs: Object.fromEntries(groups.map(group => [group.id, group.chartTabs || []])),
        shellTabs, focusedTabId: config.workspaceLayoutState?.focusedTabId || groups.find(group => group.focusedTabId)?.focusedTabId,
        split: { enabled: false, orientation: 'horizontal', sizes: {} } };
    const baseline = importWorkspace(sections);
    const restored = restoreWorkspaceLayout(baseline, config.workspaceLayoutState);
    const defaultGroup = groups.find(group => group.id === 'default');
    return { ...config, serialGroups: groups, shellTabs,
        ...(defaultGroup ? { filterTabs: defaultGroup.filterTabs, chartTabs: defaultGroup.chartTabs } : {}),
        configVersion: WORKSPACE_CONFIG_VERSION, workspaceLayoutState: serializeWorkspaceLayout(restored) };
}
module.exports = { VERSION, WORKSPACE_CONFIG_VERSION, serializeWorkspaceLayout, restoreWorkspaceLayout, migrateWorkspaceLayoutConfig };
