'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWorkspaceManager } = require('../src/workspace/workspace-manager');
const { createDefaultLayoutFor, normalizeLayoutShape } = require('../src/workspace/workspace-layout-shape');
const { groupPaneId, groupWorkspaceRootId } = require('../src/serial/serial-group-layout-dom');
const { mainTabId } = require('../src/serial/serial-group-dom');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const section = (start,end) => {
  const offset=source.indexOf(start);const limit=source.indexOf(end,offset);
  assert.ok(offset>=0 && limit>offset, `Missing source section: ${start}`);
  return source.slice(offset,limit);
};

function fixture() {
  const groups=[{id:'default'},{id:'g-1'}];
  const layouts=new Map(groups.map(g=>[g.id,createDefaultLayoutFor({paneIds:[groupPaneId(g.id,1),groupPaneId(g.id,2)],mainTabId:mainTabId(g.id)})]));
  const filters=new Map(groups.map(g=>[g.id,[]]));const charts=new Map(groups.map(g=>[g.id,[]]));
  const messages=[];const events=[];const timers=new Map();let timerId=0;
  const context=vm.createContext({
    workspaceModel:null,
    serialGroups:groups,groupWorkspaceLayouts:layouts,groupLayoutSnapshots:new Map(),
    groupWorkspaceManagers:new Map(),REGISTRY_DEFAULT_GROUP_ID:'default',activeGroupId:'default',
    workspaceLayout:layouts.get('default'),focusedWorkspaceTabId:null,currentConfig:{workspaceLayout:{defaultMirror:true}},
    normalizeGroupId:v=>v||'default',groupPaneId,groupWorkspaceRootId,mainTabId,
    cloneWorkspaceLayout:layout=>JSON.parse(JSON.stringify(layout)),createWorkspaceManager,createDefaultLayoutForGroup:id=>layouts.get(id),normalizeLayoutShape,
    filterTabsStore:{getList:id=>filters.get(id)||[]},chartTabsStore:{getList:id=>charts.get(id)||[]},
    getPaneDom:()=>({}),getPaneTabsList:()=>null,getPaneTabsContent:()=>null,
    getShellTabState:()=>null,isShellTabId:id=>id?.startsWith('tab-shell-'),persistShellTabs:()=>{},
    serializeChartTab:tab=>({...tab}),isApplyingConfig:false,isRestoringWorkspaceSession:false,
    createPaneElement:()=>{},fitWorkspaceTerminals:()=>{},renderWorkspaceNow:()=>{},
    ipcRenderer:{send:(_,payload)=>messages.push(JSON.parse(JSON.stringify(payload)))},
    window:{dispatchEvent:event=>events.push(event)},CustomEvent:class { constructor(type, options) { this.type=type;this.detail=options.detail; } },
    setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id),
    isMultiGroupLayer:()=>true,resolveSerialGroupId:v=>v||'default'
    ,updateTabTitles:()=>{},closeRenameTabDialog:()=>{},shellTabs:[],renameTabInput:{value:'Changed'},
    // 分组重命名分支会读「跟随端口」开关；本用例只验证非分组标签的持久化路径。
    renameTabFollowPortInput:{checked:false},persistSerialGroups:()=>{},syncGroupTitlesForPortChange:()=>{}
  });
  const run=code=>vm.runInContext(code,context);
  run(section('function groupIdFromPaneId(', 'function moveWorkspaceTabToOtherPane('));
  run(section('function persistGroupWorkspaceLayout(', '// 把模块级别名切到目标分组。'));
  run(section('function resolvePaneId(paneId, tabId, fallbackTabId', 'function isTabActive('));
  run(section('function resolveWorkspaceManagerForPane(', 'window.__switchWorkspaceTab'));
  run(section('function moveTabToGroupPane(', 'function bindWorkspaceTabDragging('));
  run(section('const persistFilterTabsTimers', 'function updateShellTextMode('));
  run(section('function persistChartTabs(', 'function getChartParserConfig('));
  run(section('function saveRenamedTab(', "document.getElementById('rename-tab-dialog-close')"));
  context.getGroupWorkspaceLayout=id=>layouts.get(id);
  context.workspaceManager=run("getGroupWorkspaceManager('default')");
  return {context,layouts,filters,charts,messages,events,timers,run};
}

test('pane owner is exact for default, other groups and not-yet-created generated panes',()=>{
  const f=fixture();
  assert.equal(f.run("groupIdFromPaneId('pane-1-g-1')"),'g-1');
  assert.equal(f.run("groupIdFromPaneId('pane-3-g-1')"),'g-1');
  assert.equal(f.run("groupIdFromPaneId('pane-2')"),'default');
  assert.equal(f.run("groupIdFromPaneId('pane-1-missing')"),null);
  assert.equal(f.run("resolvePaneId('pane-2-g-1','tab-main-g-1')"),'pane-2-g-1');
});

test('non-control group activation and moves keep aliases and default config unchanged',()=>{
  const f=fixture();const layout=f.layouts.get('g-1');
  layout.panes[0].tabIds.push('tab-filter-b');
  f.filters.get('g-1').push({id:'tab-filter-b',paneId:'pane-1-g-1'});
  const defaultSnapshot=JSON.stringify(f.layouts.get('default'));
  const alias=f.context.workspaceManager;
  f.run("switchPaneTab('pane-1-g-1','tab-filter-b')");
  assert.equal(layout.panes[0].activeTabId,'tab-filter-b');
  assert.equal(f.events.at(-1).type,'main-tab-changed');
  assert.equal(f.events.at(-1).detail.tabId,'tab-filter-b');
  assert.equal(f.events.at(-1).detail.paneId,'pane-1-g-1');
  assert.equal(f.context.workspaceManager,alias);assert.equal(f.context.activeGroupId,'default');
  assert.equal(f.context.currentConfig.workspaceLayout.defaultMirror,true);
  assert.equal(f.messages.at(-1).workspaceLayout,undefined);
  f.run("moveTabToGroupPane('tab-filter-b','pane-2-g-1','g-1')");
  assert.equal(f.filters.get('g-1')[0].paneId,'pane-2-g-1');
  assert.equal(JSON.stringify(f.layouts.get('default')),defaultSnapshot);
  assert.equal(f.messages.some(m=>m.filterTabs!==undefined),false);
  assert.equal(f.run("moveTabToGroupPane('tab-main','pane-2-g-1','g-1')"),false);
});

test('filter debounce captures its group and independent pending groups do not cancel each other',()=>{
  const f=fixture();f.filters.get('default').push({id:'a'});f.filters.get('g-1').push({id:'b'});
  f.run("persistFilterTabs({debounce:true});activeGroupId='g-1';persistFilterTabs({debounce:true})");
  assert.equal(f.timers.size,2);
  [...f.timers.values()].forEach(callback=>callback());
  assert.equal(f.context.serialGroups[0].filterTabs[0].id,'a');
  assert.equal(f.context.serialGroups[1].filterTabs[0].id,'b');
  assert.equal(f.context.currentConfig.filterTabs[0].id,'a');
});

test('chart move callback and layout restore use their bound group main id',()=>{
  const f=fixture();const layout=f.layouts.get('g-1');
  layout.panes[0].tabIds.push('chart-b');f.charts.get('g-1').push({id:'chart-b',paneId:'pane-1-g-1'});
  f.run("getGroupWorkspaceManager('g-1').moveTabToPane('chart-b','pane-2-g-1')");
  assert.equal(f.charts.get('g-1')[0].paneId,'pane-2-g-1');
  assert.equal(f.context.serialGroups[1].chartTabs[0].paneId,'pane-2-g-1');
  assert.equal(f.context.currentConfig.chartTabs,undefined);
  f.run("getGroupWorkspaceManager('g-1').replaceLayout({panes:[{id:'pane-1-g-1',tabIds:[]}]},{apply:false})");
  assert.deepEqual([...f.layouts.get('g-1').panes[0].tabIds],['tab-main-g-1']);
});

test('renaming a non-control group filter persists its own list',()=>{
  const f=fixture();const tab={id:'filter-b',title:'Old'};f.filters.get('g-1').push(tab);
  f.context.renameTabState=tab;f.run('saveRenamedTab()');
  assert.equal(tab.title,'Changed');assert.equal(f.context.serialGroups[1].filterTabs[0].title,'Changed');
  assert.equal(f.context.currentConfig.filterTabs,undefined);
});

test('closing non-control group filter and chart removes only their owner entries',()=>{
  for (const kind of ['Filter','Chart']) {
    const f=fixture();const id=`tab-${kind.toLowerCase()}-b`;const store=kind==='Filter'?f.filters:f.charts;
    const disposed=[];
    store.get('g-1').push({id,paneId:'pane-1-g-1',renderFrame:null,term:{dispose:()=>disposed.push(id)},element:{remove(){}},btn:{remove(){}}});
    f.layouts.get('g-1').panes[0].tabIds.push(id);
    const before=JSON.stringify(f.layouts.get('default'));
    Object.assign(f.context,{unobserveTerminalSearchChanges:()=>{},setActionStatus:()=>{}});
    const end=kind==='Filter'?'const persistFilterTabsTimers':'function renderChartFieldCandidates(';
    const destroyName = `destroy${kind}Tab`;
    f.run(section(`function ${destroyName}(`, `function close${kind}Tab(`));
    Object.assign(f.context, {chartSettingsState:null, chartExportState:null});
    f.run(section(`function close${kind}Tab(`,end));
    f.run(`close${kind}Tab('${id}')`);
    assert.equal(store.get('g-1').length,0);
    assert.equal(JSON.stringify(f.layouts.get('default')),before);
    assert.equal(f.context.activeGroupId,'default');
    assert.equal(f.layouts.get('g-1').panes[0].activeTabId,'tab-main-g-1');
    assert.equal(f.messages.some(m=>m.workspaceLayout!==undefined),false);
    if(kind==='Filter')assert.deepEqual(disposed,[id]);
  }
});

test('terminal context menu captures the visible tab group rather than the control group',()=>{
  const f=fixture();let listener;let menu;
  const term={hasSelection:()=>false};
  const tab={id:'tab-main-g-1',paneId:'pane-1-g-1'};
  Object.assign(f.context,{requestTerminalContextMenu:value=>{menu=value;},isGroupConnected:id=>id==='g-1',getGroupDisplay:id=>({receiveDisplayMode:id==='g-1'?'hex':'text'}),element:{addEventListener:(_,callback)=>{listener=callback;}},term,tab});
  f.layouts.get('g-1').splitEnabled=true;
  f.run(section('function bindTerminalContextMenu(', 'function bindTerminalWheel('));
  f.run("bindTerminalContextMenu({terminalType:'main',term,element,getTabState:()=>tab})");
  listener({preventDefault(){}});
  assert.equal(menu.groupId,'g-1');assert.equal(menu.tabId,'tab-main-g-1');
  assert.equal(menu.paneId,'pane-1-g-1');assert.equal(menu.isConnected,true);
  assert.equal(menu.splitEnabled,true);assert.equal(menu.receiveDisplayMode,'hex');
});
