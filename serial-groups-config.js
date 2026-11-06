'use strict';

// 配置 v14 → v15：把「全局唯一一份串口状态」迁移成 serialGroups 数组（P3 数据前置）。
//
// 背景：v14 及以前，lastSerialOptions / filterTabs / chartTabs / workspaceLayout 都是
// 全页唯一一份。多串口之后它们必须变成每个分组一份。迁移的目标是**无损**：
// 现有用户看到的东西一件不少，只是被搬进了第一个分组。
//
// 三条硬性约束（来自设计文档第 9 节，改动前必须先读）：
//   1. 旧字段一律保留不删。用户回退到 v14 时，旧版本仍要能读到完整配置。
//   2. 必须幂等。normalizeConfig() 可能被反复调用，第二次及以后结果必须完全一致。
//   3. 默认分组的 id 必须是确定值，不能随机生成——否则每次归一化都会产生新 id，
//      幂等性直接失效，且日志目录归属会跟着漂移。
//
// 本模块不碰文件系统、不碰 Electron，因此可以直接在 Node 里断言。

const SERIAL_GROUPS_CONFIG_VERSION = 15;
// 与 main.js 的 DEFAULT_SERIAL_GROUP_ID 必须一致：日志目录与 IPC 都用这个值。
const MIGRATED_DEFAULT_GROUP_ID = 'default';

const SERIAL_MODES = new Set(['text', 'hex']);
const SERIAL_ENCODINGS = new Set(['utf8', 'ascii', 'gbk']);
const NEWLINE_MODES = new Set(['crlf', 'lf', 'cr']);
const SERIAL_STATUSES = new Set(['disconnected', 'connecting', 'connected', 'error']);
const DATA_BITS = new Set(['5', '6', '7', '8']);
const STOP_BITS = new Set(['1', '1.5', '2']);
const PARITIES = new Set(['none', 'even', 'odd', 'mark', 'space']);

function oneOf(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 分组级的五项显示偏好（时间戳/行号/发送回显/双格式/过滤页回显）。
//
// 只有「设置里把作用域改成每组独立、且用户在该组动过开关」时才会存在这个字段。
// 缺失必须保持缺失：补一份默认值会让「组内没存过」与「组内显式设成默认值」不可区分，
// 而前者应当继续继承全局值。
const DISPLAY_PREF_FIELDS = ['showTimestamp', 'showLineNumbers', 'echoSentData', 'echoSentDataBothFormats', 'echoSentDataInFilterTabs'];

function normalizeGroupUiPrefs(source) {
  if (!isPlainObject(source)) return null;
  const prefs = {};
  let recognized = false;
  for (const field of DISPLAY_PREF_FIELDS) {
    if (typeof source[field] === 'boolean') {
      prefs[field] = source[field];
      recognized = true;
    }
  }
  return recognized ? prefs : null;
}

// 校验一份串口参数。缺失项一律回落到 fallback，而不是留 undefined——
// 渲染层会直接把这些值塞进 <select>.value，undefined 会让控件看起来「没选中」。
function normalizeGroupSerialOptions(source, fallback = {}) {
  const input = isPlainObject(source) ? source : {};
  const base = isPlainObject(fallback) ? fallback : {};

  return {
    baudRate: typeof input.baudRate === 'string' && input.baudRate.trim()
      ? input.baudRate.trim()
      : (typeof base.baudRate === 'string' && base.baudRate.trim() ? base.baudRate.trim() : '9600'),
    dataBits: oneOf(String(input.dataBits), DATA_BITS, oneOf(String(base.dataBits), DATA_BITS, '8')),
    stopBits: oneOf(String(input.stopBits), STOP_BITS, oneOf(String(base.stopBits), STOP_BITS, '1')),
    parity: oneOf(input.parity, PARITIES, oneOf(base.parity, PARITIES, 'none')),
    receiveDisplayMode: oneOf(input.receiveDisplayMode, SERIAL_MODES, oneOf(base.receiveDisplayMode, SERIAL_MODES, 'text')),
    receiveEncoding: oneOf(input.receiveEncoding, SERIAL_ENCODINGS, oneOf(base.receiveEncoding, SERIAL_ENCODINGS, 'utf8')),
    sendEncoding: oneOf(input.sendEncoding, SERIAL_ENCODINGS, oneOf(base.sendEncoding, SERIAL_ENCODINGS, 'utf8')),
    newlineMode: oneOf(input.newlineMode, NEWLINE_MODES, oneOf(base.newlineMode, NEWLINE_MODES, 'crlf'))
  };
}

// §9.3 的前两行：把旧布局里的 pane 列表与 pane 分屏状态搬到分组对象上。
//
// 为什么必须显式搬：主进程每次存盘都会走 normalizeConfig → migrateSerialGroupsConfig
// 重建整个分组对象，没在这里列出的键会在一次保存后静默丢失。
//
// 优先读 source.panes：渲染翻转之后由渲染层直接写这两个键，此时 workspaceLayout
// 只剩兼容镜像的作用，不能让镜像把新值覆盖回去。panes 与 paneSplit 必须取自同一个
// 来源，否则会出现「新 pane 列表配旧分屏开关」这种半新半旧的状态。
//
// 没有任何布局时返回空对象而不是补默认值：缺省与「显式是默认值」在读取侧语义不同，
// 与 uiPrefs 的处理保持一致。
function groupWorkspaceFields(source) {
  const explicit = Array.isArray(source.panes) ? source.panes : null;
  const layout = isPlainObject(source.workspaceLayout) ? source.workspaceLayout : null;
  const rawPanes = explicit || (layout && Array.isArray(layout.panes) ? layout.panes : null);
  if (!rawPanes) return {};

  const usedPaneIds = new Set();
  const usedTabIds = new Set();
  const panes = [];
  for (const item of rawPanes) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : '';
    if (!id || usedPaneIds.has(id)) continue;
    usedPaneIds.add(id);

    const tabIds = [];
    for (const tabId of (Array.isArray(item.tabIds) ? item.tabIds : [])) {
      // 同一个标签不能同时属于两个 pane（I4）：重复项保留第一次出现的那一个。
      if (typeof tabId !== 'string' || !tabId || usedTabIds.has(tabId)) continue;
      usedTabIds.add(tabId);
      tabIds.push(tabId);
    }
    panes.push({
      id,
      tabIds,
      activeTabId: tabIds.includes(item.activeTabId) ? item.activeTabId : (tabIds[0] || null)
    });
  }
  if (!panes.length) return {};

  const splitSource = isPlainObject(source.paneSplit)
    ? source.paneSplit
    : (explicit ? null : {
      enabled: layout.splitEnabled === true,
      orientation: layout.orientation,
      sizes: layout.paneSizes
    });
  const activePaneId = explicit
    ? (typeof source.activePaneId === 'string' ? source.activePaneId : '')
    : (typeof layout?.activePaneId === 'string' ? layout.activePaneId : '');
  const sizes = {};
  if (isPlainObject(splitSource?.sizes)) {
    for (const [paneId, value] of Object.entries(splitSource.sizes)) {
      const size = Number(value);
      if (paneId && Number.isFinite(size) && size > 0) sizes[paneId] = size;
    }
  }

  // §9.3 第三行：旧布局的 activePaneId 若指向一个有激活叶的 pane，
  // 就用它初始化焦点；否则取第一个有激活叶的 pane。
  // 焦点决定启动后显示哪一列（§2.6），不能凭空补一个默认值。
  const focusedTabId = focusedTabIdFromPanes(panes, activePaneId);

  return {
    panes,
    paneSplit: {
      enabled: splitSource?.enabled === true,
      orientation: splitSource?.orientation === 'vertical' ? 'vertical' : 'horizontal',
      sizes
    },
    ...(focusedTabId ? { focusedTabId } : {})
  };
}

// 从 pane 列表里取「当前应该聚焦的那个叶」。
//
// 优先级：显式 activePaneId 指向的 pane > 第一个有 activeTabId 的 pane。
// 只看 activeTabId 而不看 tabIds：后者可能是空数组，取 tabIds[0] 会得到 undefined，
// 那会把一个不存在的 id 当成焦点写进去（I7 直接不成立）。
function focusedTabIdFromPanes(panes, activePaneId) {
  const preferred = activePaneId
    ? panes.find(pane => pane.id === activePaneId && pane.activeTabId)
    : null;
  if (preferred) return preferred.activeTabId;
  const fallback = panes.find(pane => pane.activeTabId);
  return fallback ? fallback.activeTabId : null;
}

// 从 v14 的全局字段构造默认分组。
// title 取端口名（设计文档 9.2）；端口为空时给一个可读的占位名，而不是空字符串，
// 否则分组标签会变成一块空白，用户不知道那是什么。
function buildMigratedDefaultGroup(config) {
  const source = isPlainObject(config) ? config : {};
  const serialOptions = normalizeGroupSerialOptions(source.lastSerialOptions);
  const portPath = typeof source.lastSerialOptions?.path === 'string'
    ? source.lastSerialOptions.path.trim()
    : '';
  const title = portPath || serialOptions.portPath || 'Serial 1';

  return {
    id: MIGRATED_DEFAULT_GROUP_ID,
    title,
    portPath,
    status: 'disconnected',
    sessionId: null,
    serialOptions,
    // 直接沿用已归一化的旧字段，不在这里二次改写：
    // 这一层的职责是「搬家」，不是「重新校验」。
    filterTabs: Array.isArray(source.filterTabs) ? source.filterTabs : [],
    chartTabs: Array.isArray(source.chartTabs) ? source.chartTabs : [],
    workspaceLayout: isPlainObject(source.workspaceLayout) ? source.workspaceLayout : null
  };
}

// 归一化已有的一个分组。用于读取 v15 配置时补齐缺项，
// 也保证「加一个字段再读回来」不会把结果改得面目全非。
function normalizeSerialGroup(group, index, fallbackOptions) {
  const source = isPlainObject(group) ? group : {};
  const id = typeof source.id === 'string' && source.id.trim()
    ? source.id.trim()
    : `g-${String(index + 1).padStart(8, '0')}`;
  // 只有确实含可识别字段时才带上这个键，否则整体省略——
  // 省略与「全是默认值」在读取侧的语义不同（前者继承全局，后者是明确的组内值）。
  const uiPrefs = normalizeGroupUiPrefs(source.uiPrefs);


  return {
    id,
    title: typeof source.title === 'string' && source.title.trim()
      ? source.title.trim().slice(0, 60)
      : `Serial ${index + 1}`,
    portPath: typeof source.portPath === 'string' ? source.portPath.trim() : '',
    status: oneOf(source.status, SERIAL_STATUSES, 'disconnected'),
    // sessionId 是运行时标识，重启后一律为 null；写进配置只为保持 schema 形状。
    sessionId: null,
    serialOptions: normalizeGroupSerialOptions(source.serialOptions, fallbackOptions),
    ...(uiPrefs ? { uiPrefs } : {}),
    filterTabs: Array.isArray(source.filterTabs) ? source.filterTabs : [],
    chartTabs: Array.isArray(source.chartTabs) ? source.chartTabs : [],
    workspaceLayout: isPlainObject(source.workspaceLayout) ? source.workspaceLayout : null,
    // panes / paneSplit 是模型层的新位置。没有布局时整体省略，
    // 「没有」与「显式是默认值」在读取侧语义不同。
    ...groupWorkspaceFields(source)
  };
}

// 归一化整个分组列表：去重 id、补缺项。
// 空数组是**合法**的（用户可以关掉所有分组只剩 Shell），这里不强行补一个分组；
// 「没有分组时用旧字段兜一个出来」只在迁移路径上发生一次。
function normalizeSerialGroups(groups, fallbackOptions) {
  if (!Array.isArray(groups)) return [];
  const usedIds = new Set();
  const normalized = [];

  groups.forEach((group, index) => {
    if (!isPlainObject(group)) return;
    const next = normalizeSerialGroup(group, index, fallbackOptions);
    // id 冲突时派生一个稳定后缀；不能用随机值，否则幂等性又没了。
    if (usedIds.has(next.id)) {
      let suffix = 2;
      while (usedIds.has(`${next.id}-${suffix}`)) suffix++;
      next.id = `${next.id}-${suffix}`;
    }
    usedIds.add(next.id);
    normalized.push(next);
  });

  return normalized;
}

// 迁移主入口：给定一份配置，返回带 serialGroups 的新配置。
//
// 只在「没有 serialGroups 这个键」时构造默认分组。
// 注意判据是 hasOwnProperty 而不是 `Array.isArray(...) && length`：
// 用户如果把分组全关了、留下一个空数组，再读回来绝不能被当成「没迁移过」而重新造出一个分组。
function migrateSerialGroupsConfig(config) {
  const source = isPlainObject(config) ? config : {};
  const hasSerialGroups = Object.prototype.hasOwnProperty.call(source, 'serialGroups');

  if (hasSerialGroups) {
    return {
      ...source,
      configVersion: SERIAL_GROUPS_CONFIG_VERSION,
      serialGroups: normalizeSerialGroups(source.serialGroups, source.lastSerialOptions)
    };
  }

  const defaultGroup = buildMigratedDefaultGroup(source);
  return {
    ...source,
    configVersion: SERIAL_GROUPS_CONFIG_VERSION,
    serialGroups: normalizeSerialGroups([defaultGroup], source.lastSerialOptions)
  };
}

// 判断这份配置是否「需要迁移」。用于决定是否写备份文件：
// 只有尚未迁移过的配置才值得备份，已经迁移过的配置再备份会覆盖掉真正的 v14 原件。
function needsSerialGroupsMigration(config) {
  const source = isPlainObject(config) ? config : {};
  return !Object.prototype.hasOwnProperty.call(source, 'serialGroups');
}

module.exports = {
  SERIAL_GROUPS_CONFIG_VERSION,
  MIGRATED_DEFAULT_GROUP_ID,
  normalizeGroupSerialOptions,
  buildMigratedDefaultGroup,
  normalizeSerialGroup,
  normalizeSerialGroups,
  migrateSerialGroupsConfig,
  needsSerialGroupsMigration
};
