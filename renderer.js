const { ipcRenderer } = require('electron');
const fs = require('fs');
const { pathToFileURL } = require('url');

window.addEventListener('error', (event) => {
    ipcRenderer.send('renderer-diagnostic-log', {
        source: 'window.error',
        message: event.message || 'Unknown renderer error',
        stack: event.error?.stack || `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`
    });
});

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    ipcRenderer.send('renderer-diagnostic-log', {
        source: 'unhandledrejection',
        message: reason?.message || String(reason || 'Unknown renderer rejection'),
        stack: reason?.stack || ''
    });
});
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { TerminalUnicodeWidthAddon } = require('./src/terminal/terminal-unicode-width');
const iconv = require('iconv-lite');
const { t, getLanguage } = require('./src/common/i18n');
const { createAnchoredConfirmDialog } = require('./src/common/anchored-confirm-dialog');
const { normalizeIntegerSetting } = require('./src/common/config-values');
const { isStandardBaudRate, normalizeBaudRate, normalizeCustomBaudRates } = require('./src/serial/baud-rates');
const { createWorkspaceManager, normalizeWorkspaceLayoutShape } = require('./src/workspace/workspace-manager');
const { createLayoutRenderer } = require('./src/workspace/layout-renderer');
const { getHorizontalInsertionIndex } = require('./src/workspace/tab-reorder');
const { parseHexInput, buildSerialWriteBuffer } = require('./src/serial/serial-codec');
const { HexStreamFormatter } = require('./src/terminal/hex-formatter');
const { serializeTerminalBuffer } = require('./src/terminal/terminal-buffer-text');
const { appendPendingOutput, takePendingChunk } = require('./src/terminal/terminal-output-buffer');
const { formatSentRecord } = require('./src/terminal/sent-record');
const { translateConptyMouseMode } = require('./src/shell/shell-mouse-compat');
const uPlot = require('uplot');
const { SerialTextStream } = require('./src/serial/serial-text-stream');
const { ChartParserIpcClient, discoverChartFieldsInWorker } = require('./src/chart/chart-parser-ipc-client');
const { ChartDataModel } = require('./src/chart/chart-data-model');
const { SerialGroupRegistry, normalizeGroupId, DEFAULT_SERIAL_GROUP_ID: REGISTRY_DEFAULT_GROUP_ID } = require('./src/serial/serial-group-registry');
const { SerialGroupContextStore } = require('./src/serial/serial-group-context');
const {
    DISPLAY_PREF_SCOPES,
    normalizeDisplayPrefScope,
    normalizeDisplayPrefs,
    readGroupDisplayPrefs,
    resolveDisplayPrefs,
    displayPrefsEqual
} = require('./src/serial/serial-group-display-prefs');
const { SerialDataParser } = require('./src/serial/serial-data-parser');
const { mainTabId, mainTabButtonId, serialContainerId } = require('./src/serial/serial-group-dom');
const {
    groupPaneId,
    groupSplitterId,
    groupWorkspaceRootId,
    groupWorkspaceContainerId,
    GROUP_WORKSPACE_CONTAINER_ID,
    GROUP_WORKSPACE_SPLITTER_ID,
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
    describeGroupWorkspace
} = require('./src/serial/serial-group-layout-dom');
const { createDefaultLayoutFor, normalizeLayoutShape } = require('./src/workspace/workspace-layout-shape');
const { SerialTerminalRuntimeRegistry } = require('./src/serial/serial-group-runtime');
const { SerialOutputBuckets } = require('./src/serial/serial-output-buckets');
const { createGroupTabListStore } = require('./src/serial/serial-group-tab-lists');
const { addSerialGroup, removeSerialGroup, renameSerialGroup, resolveGroupDisplayTitle } = require('./src/serial/serial-groups-model');
const { describeGroupTab, describeGroupTabBar, GROUP_TAB_BAR_ID, GROUP_TAB_LIST_ID } = require('./src/serial/serial-group-tab-bar');
const { ChartView } = require('./src/chart/chart-view');
const { buildChartCsv } = require('./src/chart/chart-csv');
const {
    deleteSearchHistoryItem,
    normalizeSearchHistory,
    recordSearchHistory,
    setSearchHistoryPinned
} = require('./src/common/search-history');
const {
    createTerminalRevisionTracker,
    findAnchoredMatchIndex,
    resolveNavigationIndex
} = require('./src/terminal/terminal-search-state');
const {
    getVerticalInsertionIndex,
    reorderQuickSendItems,
    moveQuickSendGroup,
    moveQuickSendItem,
    deleteQuickSendGroup,
    disableSidebarQuickSend,
    deleteQuickSendById
} = require('./src/common/quick-send-reorder');
const { projectWorkspace, importWorkspace } = require('./src/workspace/tabs-workspace-projection');
const tabModel = require('./src/workspace/tab-model');
const { createWorkspaceModelManager } = require('./src/workspace/workspace-model-manager');
const { serializeWorkspaceLayout, restoreWorkspaceLayout: decodeWorkspaceLayout } = require('./src/workspace/workspace-layout-state');

const terminalSearchTrackers = new WeakMap();

const createMaterialIcon = (name, className = 'material-icon') => window.MaterialIcons.createIcon(name, className);
const TERMINAL_FONT_FAMILY = (config) => `${config.fontFamily}, ${config.fontFamilyZh}, "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", "Courier New", monospace`;

// OSC 52：把 base64 文本写进系统剪贴板。
//
// 为什么需要：`atman` 这类 CLI 的 copy 不是直接调系统剪贴板，而是往终端写
// `ESC ] 52 ; c ; <base64> BEL`，由终端负责落地。Windows Terminal / iTerm /
// kitty 实现了该协议所以能复制；xterm.js 默认忽略未知 OSC，内容被静默丢弃，
// 表现为「复制了但剪贴板没变」。
//
// 有意收窄到「只写」，不做完整 OSC 52 语义：
//   - 读取请求（负载为 '?'）一律拒绝。允许读取等于让串口另一端的设备读走
//     用户剪贴板，这是不可接受的信息外泄面。
//   - 'c' / 'p' 选择区都落到系统剪贴板：Windows/macOS 没有 X11 primary 概念。
//   - 有大小上限：串口设备或日志内容可以伪造这条序列，不设限就能用超大负载
//     反复覆盖剪贴板。
const OSC52_CLIPBOARD_IDENT = 52;
const OSC52_MAX_BYTES = 1024 * 1024;
// 严格 base64：长度必须是 4 的倍数，末尾最多两个 = 填充。
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function registerTerminalOsc52(term) {
    if (!term?.parser?.registerOscHandler) return;
    term.parser.registerOscHandler(OSC52_CLIPBOARD_IDENT, data => {
        // 负载格式：<select>;<base64>，select 常见为 'c'、'p' 或空。
        const separator = data.indexOf(';');
        if (separator === -1) return true;
        const select = data.slice(0, separator).trim();
        const payload = data.slice(separator + 1);
        // '?' 是读取请求，拒绝并吞掉，避免序列泄漏到屏幕上。
        if (!payload || payload === '?') return true;

        // 先校验再解码：Buffer.from(x, 'base64') 是宽松的，会把非法字符跳过并
        // 继续解出乱码。串口设备可以借此往剪贴板塞垃圾内容，所以这里只接受
        // 严格合法的 base64（标准表，可含 = 填充，忽略换行）。
        const normalized = payload.replace(/\s+/g, '');
        if (!BASE64_PATTERN.test(normalized)) return true;

        const text = Buffer.from(normalized, 'base64').toString('utf8');
        if (!text) return true;
        if (Buffer.byteLength(text, 'utf8') > OSC52_MAX_BYTES) {
            ipcRenderer.send('renderer-log', `OSC 52 payload rejected: exceeds ${OSC52_MAX_BYTES} bytes (select=${select})`);
            return true;
        }
        writeClipboardText(text);
        return true;
    });
}

function enableTerminalUnicode11(term) {
    term.loadAddon(new TerminalUnicodeWidthAddon());
    registerTerminalOsc52(term);
}

const SEND_LIMITS = Object.freeze({ main: 1024 * 1024, quick: 1024 * 1024, auto: 64 * 1024, paste: 1024 * 1024, terminal: 1024 * 1024 });
const SUPPORTED_ENCODINGS = new Set(['utf8', 'ascii', 'gbk']);

let currentConfig = null;
let currentLanguage = 'en';
let isApplyingConfig = false;
// 这四个参数曾经是模块级全局值，P4 起改为“每个串口分组一份”。
// 保留这四个 `let` 只作为**默认分组的缓存**，目的是不改变现有 30+ 处读取点的写法；
// 任何非默认分组必须走 getGroupDisplay()，不得读这四个变量。
let receiveDisplayMode = 'text';
let receiveEncoding = 'utf8';
let sendEncoding = 'utf8';
let newlineMode = 'crlf';
let textDecoder = null;
// 快捷指令的作用域是全局共享（同一条指令在任何分组都参与匹配），但**解码器与滚动匹配缓冲区
// 必须按分组各一份**：共用一个解码器时，两个分组同时收的多字节字符会被拆到两组字节里各解一半
// （乱码）；共用一个缓冲区时，A 组的触发文本会和 B 组的尾巴拼在一起误匹配。
const quickTriggerDecoders = new Map();
const quickTriggerBuffers = new Map();
let appliedHexSettingsKey = '';
const serialWriteChains = new Map();
const serialConnectRequests = new Map();
let serialConnectRequestSequence = 0;
const serialConnectionSessions = new Map();
let serialSessionId = 0;
// P2：分组上下文。首版只注册 default 一个分组，但字节分发的判定已经走注册表，
// 后续添加分组时不需要再改这条链路。
const serialGroupRegistry = new SerialGroupRegistry({ defaultGroupId: REGISTRY_DEFAULT_GROUP_ID });
// 这两把锁必须按分组：一个分组在连/重连时，另一个分组的点击不能被静默丢弃。
// 实现放在 isGroupConnecting / isGroupReconnecting 旁（依赖 resolveSerialGroupId）。
let serialDisconnectWaiters = new Map();
// 已绑定键盘输入的分组集合（键是 groupId）。以前只有一个 onData，只服务默认分组。
// 必须声明在这里：模块加载期就会调用 bindGroupTerminalInput 绑默认分组。
const serialInputBoundGroups = new Set();
// let currentMode = 'terminal'; // Removed temporarily

// Display Settings

// 时间戳/行号/发送回显这五项的作用域（全局共享或每组一份）由设置页的开关决定。
// `globalDisplayPrefs` 始终是**全局那一份**：scope=global 时它是唯一真源；
// scope=per-group 时它是新分组以及尚未保存过偏好的分组的继承来源。
let displayPrefScope = DISPLAY_PREF_SCOPES.GLOBAL;
const globalDisplayPrefs = normalizeDisplayPrefs({});

// 下面五个 `let` 是**默认分组**的缓存，只为不改动既有读取点的写法而保留。
// 任何分组都要走 getGroupDisplayPrefs()，不得直接读它们——
// 否则 scope=per-group 时切到 g-1 仍会拿到默认分组的显示偏好。
let showTimestamp = false;
let showLineNumbers = false;
// P2：行号计数器与收发显示参数已下沉到分组上下文（serial-group-context.js）。
// 这里保留同名访问器，避免一次性改写全文调用点；真正的状态按 groupId 隔离。
const serialGroupContext = new SerialGroupContextStore({ defaultGroupId: REGISTRY_DEFAULT_GROUP_ID });
function groupState(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    return serialGroupContext.get(groupId);
}

// 读一个分组的四个收发显示参数。
//
// 默认分组的默认参数**必须**用常量 REGISTRY_DEFAULT_GROUP_ID 而不是 activeGroupId：
// 模块顶层（getHexFormatter(REGISTRY_DEFAULT_GROUP_ID) 那一行）会立即调用它，
// 而 activeGroupId 声明在后面。默认参数里引用它会直接触发 TDZ 启动崩溃。
function getGroupDisplay(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    const state = serialGroupContext.get(id);
    return {
        receiveDisplayMode: state.receiveDisplayMode,
        receiveEncoding: state.receiveEncoding,
        sendEncoding: state.sendEncoding,
        newlineMode: state.newlineMode
    };
}

// 写回一个分组的显示参数。默认分组同步模块级缓存，供现有 30+ 处读取点继续使用。
function setGroupDisplay(groupId, patch = {}) {
    const id = resolveSerialGroupId(groupId);
    const state = serialGroupContext.setDisplay(id, patch);
    if (id === REGISTRY_DEFAULT_GROUP_ID) {
        receiveDisplayMode = state.receiveDisplayMode;
        receiveEncoding = state.receiveEncoding;
        sendEncoding = state.sendEncoding;
        newlineMode = state.newlineMode;
    }
    return state;
}
let logIncludeTimestamp = false;
let logIncludeLineNumbers = false;
let lastCharWasCR = false;

// 取某个分组**应当实际使用**的五项显示偏好。
//
// 默认分组同时回写模块级缓存，让仍未改写的读取点保持与分组一致；
// 非默认分组直接读分组自己的 uiPrefs（group 作用域）或全局那一份（global 作用域）。
// 默认参数用常量而非 activeGroupId：这个函数在分组函数定义之前就可能被调用。
//
// 这个函数在**逐行渲染**的热路径上（getPrefix / renderSentRecord），每行都要调，
// 所以结果必须缓存：否则每行都要 Array.find 分组 + 新建对象。
// 缓存有效性模型：
//   global 作用域 —— 只要不写全局值，所有分组的结果就是同一份，永不失效；
//   per-group 作用域 —— 按 groupId 各存一份，写入或作用域变化时整体作废。
// 分组对象被 syncSerialGroupsFromConfig 重建后旧缓存仍指向旧对象，
// 但它们的**字段值相等**，所以读取结果仍然正确；真正的风险只在写入后不失效，
// 而所有写入都走 setGroupDisplayPrefs / applyDisplayPrefScope。
let displayPrefsCache = new Map();
function invalidateDisplayPrefsCache() {
    displayPrefsCache = new Map();
}

function getGroupDisplayPrefs(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    const cached = displayPrefsCache.get(id);
    if (cached) return cached;
    const group = getSerialGroupById(id);
    const prefs = resolveDisplayPrefs({
        scope: displayPrefScope,
        globalPrefs: globalDisplayPrefs,
        group
    });
    displayPrefsCache.set(id, prefs);
    if (id === REGISTRY_DEFAULT_GROUP_ID) {
        showTimestamp = prefs.showTimestamp;
        showLineNumbers = prefs.showLineNumbers;
        echoSentData = prefs.echoSentData;
        echoSentDataBothFormats = prefs.echoSentDataBothFormats;
        echoSentDataInFilterTabs = prefs.echoSentDataInFilterTabs;
    }
    return prefs;
}

// 写入某一分组的显示偏好。
//
// global 作用域下写的是全局那一份（所有分组立即同步）；per-group 下只写该分组自己的 uiPrefs。
// 返回值是写入后该分组**实际生效**的偏好，供调用方刷新侧栏与终端主题。
function setGroupDisplayPrefs(groupId, patch = {}) {
    const id = resolveSerialGroupId(groupId);
    const next = normalizeDisplayPrefs({ ...getGroupDisplayPrefs(id), ...patch });
    if (displayPrefScope === DISPLAY_PREF_SCOPES.PER_GROUP) {
        const group = getSerialGroupById(id);
        if (group) group.uiPrefs = next;
    } else {
        Object.assign(globalDisplayPrefs, next);
    }
    // 必须先失效再读：上面那次 getGroupDisplayPrefs 读的是旧值（作为合并基底），
    // 不失效的话后面这次会命中旧缓存，调用方拿到的就是写入前的偏好。
    invalidateDisplayPrefsCache();
    return getGroupDisplayPrefs(id);
}

// per-group → global：删掉分组残留值，此后一律读全局那一份。
function clearGroupDisplayPrefs() {
    serialGroups.forEach(group => {
        if (group && Object.prototype.hasOwnProperty.call(group, 'uiPrefs')) delete group.uiPrefs;
    });
}

// 作用域变化时的收尾。
//
// global → per-group：把所有分组先用**当前全局值**种一份，
// 这样用户切过去的第一屏与他之前看到的完全一致，不会突然回到出厂默认；
// 在此之前各组残留的旧 uiPrefs 也会被覆盖掉，不会「一开开关就飘出几天前的值」。
//
// per-group → global：删掉分组残留值（clearGroupDisplayPrefs），此后一律读全局那一份。
function applyDisplayPrefScope(scope) {
    const next = normalizeDisplayPrefScope(scope);
    const previous = displayPrefScope;
    displayPrefScope = next;
    if (next === DISPLAY_PREF_SCOPES.PER_GROUP) {
        if (previous !== DISPLAY_PREF_SCOPES.PER_GROUP) {
            serialGroups.forEach(group => {
                if (group) group.uiPrefs = { ...globalDisplayPrefs };
            });
        }
    } else {
        clearGroupDisplayPrefs();
    }
    invalidateDisplayPrefsCache();
    // 种入的 uiPrefs 必须落盘：否则重启后分组级副本丢失，
    // 用户会发现「刚改过的每组独立设置又回到全局值」。
    // 由配置文件里的 displayPrefScope 触发的应用不写盘（见 flushPendingDisplayPrefScope）。
    if (!isApplyingConfig && !suppressDisplayPrefPersist) {
        persistSerialGroups();
        ipcRenderer.send('update-display-settings', { displayPrefScope: next });
    }
    return next;
}

// 从配置恢复时暂存的作用域。applyConfig 里只记不动，等分组列表同步完成后再真正应用——
// 否则「global → per-group」会把当前全局值种进一份马上被重建丢弃的旧分组列表。
let pendingDisplayPrefScope = null;
// 从磁盘恢复时只应用不落盘：否则每次启动都会多写一次配置，
// 而这份配置刚刚从磁盘读出来，没有值得写回去的变化。
let suppressDisplayPrefPersist = false;

function flushPendingDisplayPrefScope() {
    if (pendingDisplayPrefScope === null) return;
    const next = pendingDisplayPrefScope;
    pendingDisplayPrefScope = null;
    suppressDisplayPrefPersist = true;
    try {
        applyDisplayPrefScope(next);
    } finally {
        suppressDisplayPrefPersist = false;
    }
}

// Color settings
let timestampColor = '#808080';
let lineNoColor = '#67986f';
let highlightRules = [];
let highlightColors = {
    search: { background: '#f5d90a', foreground: '#000000' },
    filter: { background: '#535353', foreground: '#ffffff' },
    selection: { background: '#073ca8', foreground: '#ffffff' }
};
let mouseWheelScrollLines = 3;
let scrollToBottomOnSend = true;
// 发送回显配置：总开关、文本+HEX 双表示、过滤标签页展示与整行背景色。
let echoSentData = true;
let echoSentDataBothFormats = false;
let echoSentDataInFilterTabs = true;
let echoSentDataHighlightColor = '#1e3a5f';

const DEFAULT_WORKSPACE_LAYOUT = {
    splitEnabled: false,
    orientation: 'horizontal',
    activePaneId: 'pane-1',
    paneSizes: {
        'pane-1': 0.5,
        'pane-2': 0.5
    },
    panes: [
        { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main'] },
        { id: 'pane-2', activeTabId: null, tabIds: [] }
    ]
};

let workspaceLayout = cloneWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT);
let workspaceModel = null;
// 每分组各一套布局与一套布局管理器（两级分屏的基础）。
//
// 为什么用 Map + 模块级别名而不逐处传 groupId：渲染层里 `workspaceManager.xxx` 与
// `workspaceLayout` 合计 60 余处读取点，它们都应该作用于**当前激活分组**。
// 逐处改写的风险是漏一处就静默错布局；集中在一个切换函数上则只需对一次。
// 这与 P4 的显示参数缓存、本阶段前半段的 filterTabs 别名是同一手法。
const groupWorkspaceLayouts = new Map();
const groupWorkspaceManagers = new Map();
// 从配置读到的分组布局快照（panes / paneSplit / focusedTabId）。
//
// 为什么单独存一份而不直接读 serialGroups：serialGroups 用 let 声明在文件后段，
// 而 setActiveGroupWorkspace 在模块加载期就会被调用，那时它还没初始化（TDZ）。
// 这份 Map 声明在加载期安全的位置，由 syncSerialGroupsFromConfig 填充。
// 值里的 panes 只存配置原样，不在这里变换。
const groupLayoutSnapshots = new Map();
let workspaceManager = null;
let lastAppliedWorkspaceLayoutKey = '';
let isRestoringWorkspaceSession = false;
let isDraggingWorkspaceSplitter = false;
let scheduledUpdateToast = null;
let scheduledUpdateToastTimer = null;
let scheduledUpdateToastRemoveTimer = null;

function tr(key, params = {}) {
    return t(currentLanguage, key, params);
}

function trFallback(key, fallback, params = {}) {
    const value = tr(key, params);
    return value === key ? fallback.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '') : value;
}

function cloneWorkspaceLayout(layout) {
    return JSON.parse(JSON.stringify(layout || DEFAULT_WORKSPACE_LAYOUT));
}

function ensureWorkspaceLayoutShape(layout) {
    return normalizeWorkspaceLayoutShape(layout);
}

function hexToAnsi(hex) {
    if (!hex) return '';
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
}

function hexToAnsiBackground(hex) {
    if (!hex) return '';
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `\x1b[48;2;${r};${g};${b}m`;
}

function getTerminalTheme(config) {
    return {
        background: getTerminalWallpaperPath(config) ? 'rgba(0, 0, 0, 0)' : config.background,
        foreground: config.foreground,
        cursor: config.foreground,
        selectionBackground: config.highlightColors.selection.background,
        selectionForeground: config.highlightColors.selection.foreground
    };
}

function getTerminalWallpaperPath(config) {
    const wallpaperPath = config.terminalWallpaper?.path;
    return typeof wallpaperPath === 'string' && wallpaperPath && fs.existsSync(wallpaperPath) ? wallpaperPath : '';
}

let terminalWallpaperLoadId = 0;

function applyTerminalWallpaper(config) {
    const wallpaperPath = getTerminalWallpaperPath(config);
    const loadId = ++terminalWallpaperLoadId;
    document.documentElement.style.setProperty('--terminal-background-color', config.background || '#000000');
    document.documentElement.style.setProperty('--terminal-wallpaper-image', 'none');
    document.documentElement.style.setProperty('--terminal-wallpaper-overlay', '0');
    if (!wallpaperPath) return;

    const imageUrl = pathToFileURL(wallpaperPath).href;
    const image = new Image();
    image.onload = () => {
        if (loadId !== terminalWallpaperLoadId) return;
        const overlayOpacity = Math.min(100, Math.max(0, Number(config.terminalWallpaper?.overlayOpacity) || 0)) / 100;
        document.documentElement.style.setProperty('--terminal-wallpaper-image', `url("${imageUrl}")`);
        document.documentElement.style.setProperty('--terminal-wallpaper-overlay', String(overlayOpacity));
    };
    image.src = imageUrl;
}

const showTimestampCb = document.getElementById('show-timestamp');
const showLinenoCb = document.getElementById('show-lineno');
const echoSentDataCb = document.getElementById('echo-sent-data');
const echoSentDataBothCb = document.getElementById('echo-sent-data-both');
const echoSentDataFilterCb = document.getElementById('echo-sent-data-filter');
const mainSendInput = document.getElementById('main-send-input');
const mainInputHistoryBtn = document.getElementById('main-input-history-btn');
const mainInputHistoryMenu = document.getElementById('main-input-history-menu');
const mainSendBtn = document.getElementById('main-send-btn');
const mainAddQuickSendBtn = document.getElementById('main-add-quick-send-btn');
const mainSendLast = document.getElementById('main-send-last');
const mainActionStatus = document.getElementById('main-action-status');
const mainInputPanel = document.getElementById('main-input-panel');
const mainSendHexCb = document.getElementById('main-send-hex');
const mainSendAppendCrlfCb = document.getElementById('main-send-append-crlf');
const sidebar = document.getElementById('sidebar');
const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');
const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
const sidebarConnectBtn = document.getElementById('sidebar-connect-btn');
const sidebarClearBtn = document.getElementById('sidebar-clear-btn');
const clearAllLogsBtn = document.getElementById('clear-all-logs-btn');
const sidebarPrefsBtn = document.getElementById('sidebar-prefs-btn');
const sidebarInputBtn = document.getElementById('sidebar-input-btn');
const sidebarShellBtn = document.getElementById('sidebar-shell-btn');
const sidebarThroughputCompact = document.getElementById('sidebar-throughput-compact');
const sidebarThroughputRx = document.getElementById('sidebar-throughput-rx');
const sidebarThroughputTx = document.getElementById('sidebar-throughput-tx');
const mainSendOnEnterCb = document.getElementById('main-send-on-enter');
const mainInputValidation = document.getElementById('main-input-validation');
const receiveModeSelect = document.getElementById('receive-mode-select');
const receiveEncodingSelect = document.getElementById('receive-encoding-select');
const sendEncodingSelect = document.getElementById('send-encoding-select');
const toggleMainInputBtn = document.getElementById('toggle-main-input');
const toggleShellSidebarBtn = document.getElementById('toggle-shell-sidebar');
const shellSidebar = document.getElementById('shell-sidebar');
const shellSidebarCloseBtn = document.getElementById('shell-sidebar-close-btn');
const shellProfileBtns = document.getElementById('shell-profile-btns');
const shellManageProfilesBtn = document.getElementById('shell-manage-profiles-btn');
const shellAutoCrlfCb = document.getElementById('shell-auto-crlf');
const shellClearOnRestartCb = document.getElementById('shell-clear-on-restart');
const shellQuickCommandList = document.getElementById('shell-quick-command-list');
const shellQuickCommandEmpty = document.getElementById('shell-quick-command-empty');
const shellQuickCommandAddBtn = document.getElementById('shell-quick-command-add');
const shellQuickCommandDialog = document.getElementById('shell-quick-command-dialog');
const shellQuickCommandDialogTitle = document.getElementById('shell-quick-command-dialog-title');
const shellQuickCommandDialogCloseBtn = document.getElementById('shell-quick-command-dialog-close');
const shellQuickCommandDialogCancelBtn = document.getElementById('shell-quick-command-dialog-cancel');
const shellQuickCommandSaveBtn = document.getElementById('shell-quick-command-save');
const shellQuickCommandLabelInput = document.getElementById('shell-quick-command-label');
const shellQuickCommandContentInput = document.getElementById('shell-quick-command-content');
const shellQuickCommandAppendEnterInput = document.getElementById('shell-quick-command-append-enter');
const shellQuickCommandValidation = document.getElementById('shell-quick-command-validation');
const workspaceRootEl = document.getElementById('workspace-root');
const workspaceSplitterEl = document.getElementById('workspace-splitter');
const serialGroupTabBarEl = document.getElementById('serial-group-tab-bar');
const serialGroupTabListEl = document.getElementById('serial-group-tab-list');
const addSerialGroupBtn = document.getElementById('add-serial-group-btn');
// 单层模式下唯一可见的多串口入口。它初始在 pane 标签行，多分组时被搬到分组栏。
const addSerialGroupInlineBtn = document.getElementById('add-serial-group-inline-btn');
// 多分组时的新建 Shell 入口。Shell 属于「上层标签栏」那一层，所以它常任在分组标签行里；
// 单分组时由 pane 行那个静态按钮（pane-1-new-shell-tab-btn）当代入口。
const addShellTabBtn = document.getElementById('add-shell-tab-btn');
let suppressMainInputFocus = false;
const DEFAULT_SHORTCUTS = {
    sendMainInput: 'Ctrl+Enter',
    toggleSendHistory: 'Alt+H',
    historyPrevious: 'Alt+Up',
    historyNext: 'Alt+Down',
    focusSearch: 'Ctrl+F',
    clearActiveTerminal: 'Ctrl+L',
    refreshPorts: 'Ctrl+R',
    toggleSerialConnection: 'Ctrl+Shift+D'
};
let activeShortcuts = { ...DEFAULT_SHORTCUTS };
let welcomeGuideChecked = false;

function setActionStatus(message) {
    if (mainActionStatus) {
        mainActionStatus.textContent = message || trFallback('main.ready', 'Ready');
    }
}

setActionStatus(trFallback('main.ready', 'Ready'));

// 把五项显示偏好的实际值写回侧栏控件。
//
// 直接写 checked 不会触发 change 事件，因此不会反过来再调一次 applyDisplayPrefChange。
function syncDisplayPrefCheckboxes(prefs) {
    if (showTimestampCb) showTimestampCb.checked = prefs.showTimestamp;
    if (showLinenoCb) showLinenoCb.checked = prefs.showLineNumbers;
    if (echoSentDataCb) echoSentDataCb.checked = prefs.echoSentData;
    if (echoSentDataBothCb) echoSentDataBothCb.checked = prefs.echoSentDataBothFormats;
    if (echoSentDataFilterCb) echoSentDataFilterCb.checked = prefs.echoSentDataInFilterTabs;
}

// 五项显示偏好（时间戳/行号/发送回显/双格式/过滤页回显）的统一写入入口。
//
// 持久化目标取决于作用域：
//   global    —— 沿用改造前的顶层键，经 update-display-settings 写入，行为与旧版一致；
//   per-group —— 写进 serialGroups[i].uiPrefs，并立即整份持久化分组列表。
// 两个分支都会先更新内存中的真源，所以切换分组时侧栏能立刻读到新值。
function applyDisplayPrefChange(field, value) {
    const groupId = resolveSerialGroupId(activeGroupId);
    const next = setGroupDisplayPrefs(groupId, { [field]: value });
    syncDisplayPrefCheckboxes(next);
    if (displayPrefScope === DISPLAY_PREF_SCOPES.PER_GROUP) {
        persistSerialGroups();
    } else {
        ipcRenderer.send('update-display-settings', { [field]: next[field] });
    }
}

showTimestampCb.addEventListener('change', (e) => {
    applyDisplayPrefChange('showTimestamp', e.target.checked);
});

showLinenoCb.addEventListener('change', (e) => {
    applyDisplayPrefChange('showLineNumbers', e.target.checked);
});

// 发送回显开关：与显示时间/行号同级，属于显示层偏好，切换后立即生效并持久化。
echoSentDataCb?.addEventListener('change', (e) => {
    applyDisplayPrefChange('echoSentData', e.target.checked);
});

echoSentDataBothCb?.addEventListener('change', (e) => {
    applyDisplayPrefChange('echoSentDataBothFormats', e.target.checked);
});

echoSentDataFilterCb?.addEventListener('change', (e) => {
    applyDisplayPrefChange('echoSentDataInFilterTabs', e.target.checked);
});

let currentBatchTimestamp = null;

// 每批日志只计算一次时间戳字符串，逐行复用；未传入时按当前时间即时生成。
function formatTimestamp(now = new Date()) {
    return now.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
}

function getPrefix(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    let s = '';
    const reset = '\x1b[0m';
    const state = groupState(groupId);
    // 前缀属于本分组：per-group 作用域下各组可能各开各的，
    // 用模块级变量会让 g-1 的数据按默认分组的偏好加前缀。
    const prefs = getGroupDisplayPrefs(groupId);
    
    if (prefs.showTimestamp) {
        const time = currentBatchTimestamp || formatTimestamp();
        const color = hexToAnsi(timestampColor);
        s += `${color}[${time}]${reset} `;
    }
    if (prefs.showLineNumbers) {
        const lineNo = String(state.serialLineCounter).padStart(4, '0');
        const color = hexToAnsi(lineNoColor);
        s += `${color}[${lineNo}]${reset} `;
        state.serialLineCounter++;
    }
    return s;
}

function getLogPrefix(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    let s = '';
    const state = groupState(groupId);
    if (logIncludeTimestamp) {
        s += `[${currentBatchTimestamp || formatTimestamp()}] `;
    }
    if (logIncludeLineNumbers) {
        s += `[${String(state.logLineCounter).padStart(4, '0')}] `;
        state.logLineCounter++;
    }
    return s;
}

let compiledHighlightRules = [];
// 过滤正则按对象缓存一份带 g 标志的副本，避免逐行逐标签重新编译；
// 原始 filterRegex 保持无 g（供 test() 无状态使用）。
const globalFilterRegexCache = new WeakMap();


// 高亮规则只在配置变更时编译一次，避免逐行逐规则重复 new RegExp。
function compileHighlightRules(rules) {
    const compiled = [];
    (rules || []).forEach(rule => {
        if (!rule || !rule.enabled || !rule.regex) return;
        try {
            let pattern = rule.regex;
            // Legacy support for (?i) prefix, overriding caseSensitive if present
            let isCaseSensitive = rule.caseSensitive;
            if (pattern.startsWith('(?i)')) {
                pattern = pattern.substring(4);
                isCaseSensitive = false;
            }
            // Handle useRegex flag (if useRegex is false, escape special characters)
            if (rule.useRegex === false) {
                pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
            compiled.push({ re: new RegExp(pattern, isCaseSensitive ? 'g' : 'gi'), color: rule.color });
        } catch (e) {
            // Ignore invalid regex
        }
    });
    return compiled;
}

function collectGlobalHighlightMatches(text) {
    const matches = [];
    if (!compiledHighlightRules.length) return matches;
    compiledHighlightRules.forEach(({ re, color }) => {
        // 复用带 g 标志的正则，需重置 lastIndex 开始本行匹配
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(text)) !== null) {
            // Prevent infinite loop for empty matches
            if (match[0].length === 0) {
                re.lastIndex++;
                continue;
            }
            matches.push({
                start: match.index,
                end: match.index + match[0].length,
                color,
                isFilterMatch: false
            });
        }
    });
    return matches;
}

function applyHighlighting(text, filterRegex = null, globalMatches = null) {
    if (!text) return text;
    const matches = (globalMatches || collectGlobalHighlightMatches(text)).map(match => ({ ...match }));

    // Apply filter regex highlight
    if (filterRegex) {
        try {
            // 优先复用缓存的带 g 副本；若原始正则已带 g 则直接使用（调用前已重置 lastIndex）。
            let re = globalFilterRegexCache.get(filterRegex);
            if (!re) {
                re = filterRegex.global ? filterRegex : new RegExp(filterRegex.source, filterRegex.flags + 'g');
                globalFilterRegexCache.set(filterRegex, re);
            }
            re.lastIndex = 0;
            let match;
            while ((match = re.exec(text)) !== null) {
                // Prevent infinite loop for empty matches
                if (match[0].length === 0) {
                    re.lastIndex++;
                    continue;
                }
                matches.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    isFilterMatch: true
                });
            }
        } catch (e) {
            // Ignore invalid regex
        }
    }

    if (matches.length === 0) return text;

    // Sort matches by start index
    matches.sort((a, b) => a.start - b.start);

    // Merge overlapping matches (prioritizing filter match)
    const mergedMatches = [];
    let currentMatch = matches[0];

    for (let i = 1; i < matches.length; i++) {
        const nextMatch = matches[i];
        if (nextMatch.start < currentMatch.end) {
            // Overlap detected
            currentMatch.end = Math.max(currentMatch.end, nextMatch.end);
            // If any of the overlapping matches is a filter match, mark the merged block as filter match
            if (nextMatch.isFilterMatch) {
                currentMatch.isFilterMatch = true;
            } else if (!currentMatch.isFilterMatch && nextMatch.color) {
                // Only overwrite color if current match is not a filter match
                currentMatch.color = nextMatch.color;
            }
        } else {
            mergedMatches.push(currentMatch);
            currentMatch = nextMatch;
        }
    }
    mergedMatches.push(currentMatch);

    let result = '';
    let lastIndex = 0;

    for (const m of mergedMatches) {
        if (m.start < lastIndex) continue; 
        
        result += text.substring(lastIndex, m.start);
        
        // \x1b[48;5;236m is a dark gray background. \x1b[1m is bold.
        if (m.isFilterMatch) {
            result += hexToAnsiBackground(highlightColors.filter.background)
                + hexToAnsi(highlightColors.filter.foreground)
                + '\x1b[1m' + text.substring(m.start, m.end) + '\x1b[0m';
        } else {
            // Normal highlight rule
            result += hexToAnsi(m.color) + text.substring(m.start, m.end) + '\x1b[0m';
        }
        
        lastIndex = m.end;
    }
    
    result += text.substring(lastIndex);
    return result;
}

// 行解析器已抽到 serial-data-parser.js（无 DOM 依赖，可单测）。
//
// 默认分组的解析器由 `createSerialRuntime()` 在建终端时一并创建，并作为终端运行时
// 的一部分返回。这里不单独 new 一个：同一分组若存在两个解析器，只有其中一个会被写入
// 数据，行号会看起来「不涨」，属于最难定位的一类状态分裂。
//
// 声明成 `let` 是因为模块顶部先执行到这里、终端运行时要到下方才构造。赋值后不再变化。
let dataParser = null;
// 输出队列按 groupId 分桶。改造前只有一个数组，任意两个分组的字节会在
// Buffer.concat 时被拼成同一批，然后写进同一个终端与同一个日志文件。
const SERIAL_OUTPUT_QUEUE_HIGH_WATER_BYTES = 1024 * 1024;
const serialOutputBuckets = new SerialOutputBuckets({
    highWaterBytes: SERIAL_OUTPUT_QUEUE_HIGH_WATER_BYTES,
    defaultGroupId: REGISTRY_DEFAULT_GROUP_ID
});
let serialOutputFlushScheduled = false;
let serialOutputFlushTimer = null;
let lastSerialOutputFlushAt = 0;
const SERIAL_OUTPUT_MAX_FPS = 30;
const SERIAL_OUTPUT_FRAME_MS = 1000 / SERIAL_OUTPUT_MAX_FPS;

// ---- 分组数据面 ----------------------------------------------------------
//
// 终端与行解析器由 serialRuntimes 持有；解码器与 HEX 格式化器体积小、状态也必须
// 按分组隔离（各自的半个多字节字符、各自的 HEX 偏移），所以在这里单独维护一份，
// 键同样是 groupId。
//
// 为什么未登记的 groupId 一律回落默认分组：注册表里没有的分组既没有终端也没有配置，
// 若在这里为它新建一套对象，等于在注册表之外悄悄长出第二个终端——数据会进去，
// 但界面上永远看不到，而且不会报错。回落至少让数据可见。

// 主标签页 id 反查分组：clearTerminal 这类按 tabId 工作的路径需要它。
function resolveGroupIdForMainTab(tabId) {
    const target = typeof tabId === 'string' ? tabId : '';
    for (const id of serialGroupRegistry.listGroupIds()) {
        if (mainTabId(id) === target) return id;
    }
    return REGISTRY_DEFAULT_GROUP_ID;
}

function resolveSerialGroupId(groupId) {
    const id = normalizeGroupId(groupId);
    return serialGroupRegistry.getGroup(id) ? id : REGISTRY_DEFAULT_GROUP_ID;
}

function isActiveSerialGroup(groupId) {
    return resolveSerialGroupId(groupId) === serialGroupRegistry.activeGroupId;
}

// 该分组是否已连接。注册表是唯一真相源——用全局 isConnected 判定会让
// 「切到 g-1 后往它的终端里打字」被默认分组的状态拦掉。
function isGroupConnected(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const group = serialGroupRegistry.getGroup(resolveSerialGroupId(groupId));
    return group ? group.connected === true : false;
}

// 该分组当前的会话号。注册表是真相源：它按分组各自递增，互不影响。
function getGroupSessionId(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const group = serialGroupRegistry.getGroup(resolveSerialGroupId(groupId));
    return group ? group.sessionId : 0;
}

const serialGroupIo = new Map();

// 每个分组一份解码器与 HEX 格式化器。格式化器的回调必须带上自己的 groupId，
// 否则它的输出会被写进默认分组的终端。
function getSerialGroupIo(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    let io = serialGroupIo.get(id);
    if (!io) {
        io = {
            textDecoder: null,
            hexFormatter: new HexStreamFormatter({}, lines => writeHexLines(id, lines))
        };
        serialGroupIo.set(id, io);
    }
    return io;
}

function getTextDecoder(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    return getSerialGroupIo(groupId).textDecoder;
}

function setTextDecoder(groupId, decoder) {
    getSerialGroupIo(groupId).textDecoder = decoder;
}

function getHexFormatter(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    return getSerialGroupIo(groupId).hexFormatter;
}

// HEX 显示设置是全应用一份，但每个分组的格式化器都要拿到它，否则切到另一个分组
// 时字节数/大小写/偏移显示会退回默认值。
function configureAllHexFormatters(settings) {
    const ids = new Set([...serialGroupRegistry.listGroupIds(), REGISTRY_DEFAULT_GROUP_ID]);
    ids.forEach(id => getHexFormatter(id).configure(settings));
}

function flushAllHexFormatters() {
    const ids = new Set([...serialGroupRegistry.listGroupIds(), REGISTRY_DEFAULT_GROUP_ID]);
    ids.forEach(id => getHexFormatter(id).flush());
}

// 终端运行时按 groupId 取；未登记的回落默认分组（模块加载时已断言它存在）。
function getSerialRuntime(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    return serialRuntimes.get(resolveSerialGroupId(groupId)) || defaultSerialRuntime;
}

function getSerialTerm(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    return getSerialRuntime(groupId).term;
}
// 终端待写入缓冲：以回滚行数为主上限，字节硬上限仅作为内存兜底，避免极端长行撑爆内存。
const TERMINAL_PENDING_OUTPUT_HARD_LIMIT = 32 * 1024 * 1024;
// 单次交给 xterm 解析的字节预算：窗口恢复时按此分批写入，避免一次巨型解析阻塞主线程。
const TERMINAL_WRITE_BATCH_BYTES = 512 * 1024;

function getTerminalPendingLineLimit() {
    const limit = Number(currentConfig?.scrollbackLimit);
    return Number.isFinite(limit) && limit > 0 ? limit : 20000;
}
const terminalWriteStates = new WeakMap();

function scrollMainTerminalToBottom(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const term = serialRuntimes.get(groupId)?.term;
    if (typeof term?.scrollToBottom !== 'function') return;
    requestAnimationFrame(() => term.scrollToBottom());
}

function drainTerminalOutput(term, state) {
    if (state.writing || !state.pending.length) return;
    const skipped = state.skipped;
    state.skipped = false;
    const chunk = takePendingChunk(state, TERMINAL_WRITE_BATCH_BYTES);
    if (!chunk) return;
    state.writing = true;
    const output = `${skipped ? '\r\n[Display output skipped to limit memory usage]\r\n' : ''}${chunk}`;
    try {
        term.write(output, () => {
            state.writing = false;
            if (state.resetAfterWrite) {
                state.resetAfterWrite = false;
                invalidateTerminalSearch(term, 'reset', { clearAnchor: true });
                term.reset();
            }
            if (state.pending.length) scheduleTerminalDrain(term, state);
        });
    } catch (error) {
        state.writing = false;
        state.pending = [];
        state.pendingLength = 0;
        state.pendingLines = 0;
    }
}

// 让出一轮事件循环后再写入下一批，保证恢复可见时界面仍能逐帧渲染而不冻结。
function scheduleTerminalDrain(term, state) {
    if (state.drainScheduled) return;
    state.drainScheduled = true;
    setTimeout(() => {
        state.drainScheduled = false;
        drainTerminalOutput(term, state);
    }, 0);
}

function writeTerminalOutput(term, output) {
    if (!term || !output) return;
    let state = terminalWriteStates.get(term);
    if (!state) {
        state = { writing: false, pending: [], pendingLength: 0, pendingLines: 0, skipped: false, resetAfterWrite: false, drainScheduled: false };
        terminalWriteStates.set(term, state);
    }
    // 未达到回滚行数前完整排队，超过后才从最旧处按行丢弃；字节硬上限仅作为内存兜底。
    const dropped = appendPendingOutput(state, output, {
        maxLines: getTerminalPendingLineLimit(),
        maxBytes: TERMINAL_PENDING_OUTPUT_HARD_LIMIT
    });
    if (dropped > 0) state.skipped = true;
    drainTerminalOutput(term, state);
}

function clearTerminalOutput(term) {
    const state = terminalWriteStates.get(term);
    if (state) {
        state.pending = [];
        state.pendingLength = 0;
        state.pendingLines = 0;
        state.skipped = false;
        state.resetAfterWrite = state.writing;
    }
    invalidateTerminalSearch(term, 'reset', { clearAnchor: true });
    term.reset();
}

function scheduleSerialOutputFlush() {
    if (serialOutputFlushScheduled) return;
    serialOutputFlushScheduled = true;
    const delay = Math.max(0, SERIAL_OUTPUT_FRAME_MS - (performance.now() - lastSerialOutputFlushAt));
    serialOutputFlushTimer = setTimeout(() => {
        serialOutputFlushTimer = null;
        requestAnimationFrame(flushSerialOutputQueue);
    }, delay);
}

function flushSerialOutputQueue() {
    serialOutputFlushScheduled = false;
    lastSerialOutputFlushAt = performance.now();
    if (!serialOutputBuckets.hasPending()) return;
    // 每个批次只含一个分组的字节。这一条由 SerialOutputBuckets 保证，
    // 消费侧不得再把多个批次合并——那正是改造前串流的成因。
    for (const batch of serialOutputBuckets.drain()) {
        dispatchSerialBatch(batch.groupId, batch.buffer);
    }
    if (serialOutputBuckets.hasPending() && !serialOutputFlushScheduled) {
        scheduleSerialOutputFlush();
    }
}

// 把一个分组的字节送进它自己的终端与日志。
function dispatchSerialBatch(groupId, bytes) {
    const id = resolveSerialGroupId(groupId);
    const runtime = serialRuntimes.get(id);
    if (!runtime || !bytes || !bytes.length) return;
    currentBatchTimestamp = formatTimestamp();
    try {
        // 触发源是**本批字节**，触发后的回发也必须回到这个分组，不能回 activeGroupId。
        processQuickSendAutoTriggers(bytes, id);
        // 显示模式必须按**本批字节所属分组**读：否则两个分组只能是同一种显示模式，
        // A 组设成 HEX 会把 B 组的文本输出也变成 HEX。
        if (getGroupDisplay(id).receiveDisplayMode === 'hex') {
            getHexFormatter(id).push(bytes);
        } else {
            if (!getTextDecoder(id)) createTextDecoder(id);
            const text = getTextDecoder(id).write(bytes);
            if (text) writeTextLines(id, runtime.dataParser.parse(text));
        }
    } finally {
        currentBatchTimestamp = null;
    }
}

function flushPendingSerialOutput() {
    if (serialOutputFlushScheduled) {
        if (serialOutputFlushTimer) clearTimeout(serialOutputFlushTimer);
        serialOutputFlushTimer = null;
        serialOutputFlushScheduled = false;
        flushSerialOutputQueue();
    }
}

// groupId 默认值保证单分组行为与改造前一致。
function queueSerialOutput(bytes, groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const result = serialOutputBuckets.push(groupId, bytes);
    if (result.shouldFlush) {
        flushPendingSerialOutput();
        return;
    }
    scheduleSerialOutputFlush();
}

function writeTextLines(groupId, lines) {
    const id = resolveSerialGroupId(groupId);
    const runtime = serialRuntimes.get(id);
    if (!runtime || !lines.length) return;
    const formattedLines = lines.map(line => {
        const globalMatches = collectGlobalHighlightMatches(line.text);
        return {
            ...line,
            logPrefix: getLogPrefix(id),
            globalMatches,
            highlighted: applyHighlighting(line.text, null, globalMatches)
        };
    });
    const mainOutput = formattedLines.map(line => `${line.prefix}${line.highlighted}${line.delimiter ? '\r\n' : ''}`).join('');
    if (mainOutput) {
        writeTerminalOutput(runtime.term, mainOutput);
        writeMainTabLog(formattedLines.map(line => `${line.logPrefix}${line.highlighted}${line.delimiter}`).join(''), id);
    }
    // P5：过滤页按分组各一份，所以这里取**本批字节所属分组**的过滤页列表，
    // 而不是模块级别名（那个只指向激活分组）。P3 的 isActiveSerialGroup 临时
    // 边界已移除：它会让非激活分组在那段时间的过滤数据永久丢失。
    filterTabsStore.getList(id).forEach(tab => {
        if (tab.showSentOnly === true || tab.dataMode !== 'text') return;
        const formatted = formattedLines.map(({ text, delimiter, prefix, logPrefix, globalMatches }) => {
            if (tab.filterRegex && !tab.filterRegex.test(text)) return null;
            const highlighted = applyHighlighting(text, tab.filterRegex, globalMatches);
            return {
                terminal: `${prefix}${highlighted}${delimiter ? '\r\n' : ''}`,
                log: `${logPrefix}${highlighted}${delimiter}`
            };
        }).filter(Boolean);
        const output = formatted.map(line => line.terminal).join('');
        if (output) {
            writeTerminalOutput(tab.term, output);
            writeFilterTabLog(tab, formatted.map(line => line.log).join(''), id);
        }
    });
}

function writeHexLines(groupId, lines) {
    const id = resolveSerialGroupId(groupId);
    const runtime = serialRuntimes.get(id);
    if (!runtime || !lines.length) return;
    const formattedLines = lines.map(line => ({
        text: line.output.replace(/\r?\n$/, ''),
        prefix: getPrefix(id),
        logPrefix: getLogPrefix(id),
        globalMatches: null,
        highlighted: ''
    }));
    formattedLines.forEach(line => {
        line.globalMatches = collectGlobalHighlightMatches(line.text);
        line.highlighted = applyHighlighting(line.text, null, line.globalMatches);
    });
    const mainOutput = formattedLines.map(({ text, prefix }) => `${prefix}${text}\r\n`).join('');
    writeTerminalOutput(runtime.term, mainOutput);
    writeMainTabLog(formattedLines.map(({ text, logPrefix }) => `${logPrefix}${text}\r\n`).join(''), id);
    // 同 writeTextLines：HEX 路径也必须取本分组自己的过滤页。
    filterTabsStore.getList(id).forEach(tab => {
        if (tab.showSentOnly === true || tab.dataMode !== 'hex') return;
        const matched = formattedLines.map(({ text, prefix, logPrefix, globalMatches }) => {
            if (tab.filterRegex && !tab.filterRegex.test(text)) return null;
            const highlighted = applyHighlighting(text, tab.filterRegex, globalMatches);
            return {
                terminal: `${prefix}${highlighted}\r\n`,
                log: `${logPrefix}${highlighted}\r\n`
            };
        }).filter(Boolean);
        const output = matched.map(line => line.terminal).join('');
        if (output) {
            writeTerminalOutput(tab.term, output);
            writeFilterTabLog(tab, matched.map(line => line.log).join(''), id);
        }
    });
}

// 模块级别名指向默认分组的格式化器：显示设置、清屏这些路径操作的就是主终端。
const hexFormatter = getHexFormatter(REGISTRY_DEFAULT_GROUP_ID);

// 发送回显使用独立的背景色整行标记，不经过 SerialDataParser，也不占用接收行号。
function renderSentRecord(record, groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    // 三个回显开关都属于**这条记录所属的分组**：per-group 作用域下，
    // g-1 关了回显不能连带把默认分组也静默；反过来默认分组关着也不该吞掉 g-1 的记录。
    const prefs = getGroupDisplayPrefs(id);
    if (!prefs.echoSentData) return;
    const runtime = serialRuntimes.get(id);
    if (!runtime) return;
    const formatted = formatSentRecord(record, {
        label: trFallback('main.txLabel', 'TX'),
        both: prefs.echoSentDataBothFormats
    });
    const bg = hexToAnsiBackground(echoSentDataHighlightColor);
    const body = formatted.line;
    writeTerminalOutput(runtime.term, `${bg}${body}\x1b[0m\r\n`);
    writeMainTabLog(`${body}\r\n`, id);
    if (!prefs.echoSentDataInFilterTabs) return;
    if (!isActiveSerialGroup(id)) return;
    filterTabs.forEach(tab => {
        if (tab.showSentOnly === true) {
            writeTerminalOutput(tab.term, `${bg}${body}\x1b[0m\r\n`);
            writeFilterTabLog(tab, `${body}\r\n`, id);
            return;
        }
        if (tab.filterRegex && !tab.filterRegex.test(body)) return;
        writeTerminalOutput(tab.term, `${bg}${body}\x1b[0m\r\n`);
        writeFilterTabLog(tab, `${body}\r\n`, id);
    });
}

function createTextDecoder(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    // 解码器实例本来就按分组存（setTextDecoder），但「用哪种编码解码」以前是全局的：
    // 两个分组无法各用一种编码。这里按本分组取。
    const id = resolveSerialGroupId(groupId);
    const encoding = getGroupDisplay(id).receiveEncoding;
    setTextDecoder(id, iconv.getDecoder(SUPPORTED_ENCODINGS.has(encoding) ? encoding : 'utf8'));
}

// 编码按**本分组**取：接收编码本来就是一个分组一份，用默认分组的编码去解别的分组的字节
// 会在 GBK/UTF-8 混用时报错或出乱码。
function createQuickTriggerDecoder(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    const encoding = getGroupDisplay(id).receiveEncoding;
    quickTriggerDecoders.set(id, iconv.getDecoder(SUPPORTED_ENCODINGS.has(encoding) ? encoding : 'utf8'));
}

// 不传 groupId 表示「全部清空」（关闭自动触发时用）；传了就只清该分组。
function resetQuickTriggerReceive(groupId = null) {
    if (groupId === null) {
        quickTriggerDecoders.clear();
        quickTriggerBuffers.clear();
        return;
    }
    const id = resolveSerialGroupId(groupId);
    quickTriggerDecoders.delete(id);
    quickTriggerBuffers.delete(id);
}

function flushTextReceive(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    const runtime = serialRuntimes.get(id);
    const decoder = getTextDecoder(id);
    if (decoder) {
        const finalText = decoder.end();
        if (finalText && runtime) writeTextLines(id, runtime.dataParser.parse(finalText));
        setTextDecoder(id, null);
    }
    if (runtime) writeTextLines(id, runtime.dataParser.flush());
}

function resetTextReceive(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    const runtime = serialRuntimes.get(id);
    setTextDecoder(id, null);
    if (runtime) {
        runtime.dataParser.isNewLine = true;
        runtime.dataParser.incomingBuffer = '';
    }
    if (getGroupDisplay(id).receiveDisplayMode === 'text') createTextDecoder(id);
}

function updateFilterModeStatuses() {
    filterTabs.forEach(tab => {
        // 过滤页目前全应用一份，只跟随激活分组，所以暂停态也按激活分组算。
        const paused = tab.dataMode !== getGroupDisplay(activeGroupId).receiveDisplayMode;
        if (tab.modeStatus) {
            tab.modeStatus.textContent = paused
                ? `${tab.dataMode.toUpperCase()} ${trFallback('main.filterPaused', 'paused')}`
                : tab.dataMode.toUpperCase();
            tab.modeStatus.classList.toggle('paused', paused);
        }
    });
}

// 切换接收显示模式。groupId 缺省为默认分组，保证单分组调用点无需改动。
function switchReceiveMode(nextMode, { persist = true, groupId = REGISTRY_DEFAULT_GROUP_ID } = {}) {
    const id = resolveSerialGroupId(groupId);
    const normalized = nextMode === 'hex' ? 'hex' : 'text';
    const previous = getGroupDisplay(id).receiveDisplayMode;
    const formatter = getHexFormatter(id);
    flushPendingSerialOutput();
    if (normalized !== previous) {
        if (previous === 'text') flushTextReceive(id);
        else formatter.flush();
        setGroupDisplay(id, { receiveDisplayMode: normalized });
        if (normalized === 'text') createTextDecoder(id);
        else formatter.reset({ resetOffset: false });
    } else if (normalized === 'text' && !getTextDecoder(id)) {
        createTextDecoder(id);
    }
    // 侧栏控件反映的是激活分组，切非激活分组时不能去改可见控件。
    if (id === activeGroupId) {
        if (receiveModeSelect) receiveModeSelect.value = normalized;
        if (receiveEncodingSelect) receiveEncodingSelect.disabled = normalized === 'hex';
        updateFilterModeStatuses();
    }
    if (persist && !isApplyingConfig) saveSerialModeConfig();
}

function switchReceiveEncoding(nextEncoding, { persist = true, groupId = REGISTRY_DEFAULT_GROUP_ID } = {}) {
    const id = resolveSerialGroupId(groupId);
    const normalized = SUPPORTED_ENCODINGS.has(nextEncoding) ? nextEncoding : 'utf8';
    const previous = getGroupDisplay(id).receiveDisplayMode === 'text';
    if (normalized !== getGroupDisplay(id).receiveEncoding) {
        if (previous) flushTextReceive(id);
        setGroupDisplay(id, { receiveEncoding: normalized });
        if (previous) createTextDecoder(id);
        resetQuickTriggerReceive(id);
    }
    if (id === activeGroupId && receiveEncodingSelect) receiveEncodingSelect.value = normalized;
    if (persist && !isApplyingConfig) saveSerialModeConfig();
}

function getTerminalPlainText(targetTerm) {
    return serializeTerminalBuffer(targetTerm?.buffer?.active);
}

async function writeClipboardText(text) {
    if (!text) return false;
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        ipcRenderer.send('renderer-log', 'Failed to write clipboard text from renderer');
        return false;
    }
}

async function readClipboardText() {
    try {
        return await navigator.clipboard.readText();
    } catch {
        ipcRenderer.send('renderer-log', 'Failed to read clipboard text from renderer');
        return '';
    }
}

function getContextMenuLabels() {
    return {
        copy: tr('main.contextCopy'),
        copyAll: tr('main.contextCopyAll'),
        findSelection: tr('main.contextFindSelection'),
        clearTerminal: tr('main.contextClearTerminal'),
        clearAndResetHex: trFallback('main.contextClearAndResetHex', 'Clear and Reset Hex Offset'),
        pasteAndSend: tr('main.contextPasteAndSend'),
        sendSelection: tr('main.contextSendSelection'),
        createFilterFromSelection: tr('main.contextCreateFilterFromSelection'),
        useSelectionAsFilter: tr('main.contextUseSelectionAsFilter'),
        appendSelectionToFilter: tr('main.contextAppendSelectionToFilter'),
        locateInMainTerminal: tr('main.contextLocateInMainTerminal'),
        toggleMatchCase: tr('main.contextToggleMatchCase'),
        toggleWholeWord: tr('main.wholeWord'),
        toggleRegex: tr('main.contextToggleRegex'),
        closeFilterTab: tr('main.contextCloseFilterTab'),
        splitHorizontal: tr('main.splitHorizontal'),
        splitVertical: tr('main.splitVertical'),
        moveToOtherPane: tr('main.moveToOtherPane'),
        closeSplit: tr('main.closeSplit'),
        newFilterTab: tr('main.newFilterTab'),
        newShellTab: tr('main.newShellTab'),
        closeShellTab: tr('main.contextCloseShellTab'),
        restartShell: tr('main.contextRestartShell'),
        toggleShellTextMode: tr('main.contextToggleShellTextMode'),
        newCmdTab: tr('main.newCmdTab'),
        newPowerShellTab: tr('main.newPowerShellTab'),
        newBashTab: tr('main.newBashTab'),
        chartPause: tr('main.chartPause'),
        chartResume: tr('main.chartResume'),
        chartLive: tr('main.chartLive'),
        chartClear: tr('main.chartClear'),
        chartExportWindow: tr('main.chartExportWindow'),
        chartExportAll: tr('main.chartExportAll'),
        chartSettings: tr('main.chartSettings'),
        chartClose: tr('main.chartClose'),
        groupSplitHorizontal: trFallback('main.groupSplitHorizontal', 'Split Groups Left/Right'),
        groupSplitVertical: trFallback('main.groupSplitVertical', 'Split Groups Top/Bottom'),
        groupSplitClose: trFallback('main.groupSplitClose', 'Close Group Split'),
        detachToOwnColumn: trFallback('main.detachToOwnColumn', 'Detach to Own Column'),
        joinGroupColumn: trFallback('main.joinGroupColumn', 'Move into Group Column'),
        // 右键菜单里的「新建图表」。与 newShellTab / newFilterTab 并列，
        // 菜单模板里三项共用同一段构造（见 main.js 的 paneNewTabItems）。
        newChartTab: trFallback('main.newChartTab', 'New Chart Tab'),
        addSerialPort: tr('main.addSerialPort')
    };
}

function stripShellMouseReports(tabState, data) {
    const input = `${tabState.mouseInputSequenceCarry || ''}${data || ''}`;
    const reportPattern = /\x1b\[<\d+(?:;\d+){2}[Mm]|\x1b\[\d+;\d+;\d+M|\x1bM[\s\S]{3}/g;
    const filtered = input.replace(reportPattern, '');
    let carry = '';
    for (let length = Math.min(8, filtered.length); length > 0; length--) {
        const suffix = filtered.slice(-length);
        if (/^\x1b(?:\[<?[0-9;]*|M[\s\S]{0,2})$/.test(suffix)) {
            carry = suffix;
            break;
        }
    }
    tabState.mouseInputSequenceCarry = carry;
    return carry ? filtered.slice(0, -carry.length) : filtered;
}

function setShellTextMode(tabState, enabled) {
    if (!tabState?.term) return;
    const mouseService = tabState.term._core?.coreMouseService;
    if (!mouseService) return;
    if (enabled) {
        if (tabState.shellMouseTrackingMode === undefined) {
            tabState.shellMouseTrackingMode = tabState.term.modes?.mouseTrackingMode || 'none';
        }
        // xterm otherwise consumes drag events for the shell instead of starting selection.
        mouseService._activeProtocol = 'NONE';
        mouseService._onProtocolChange?.fire(0);
        tabState.term.element?.classList.remove('enable-mouse-events');
    } else if (tabState.shellMouseTrackingMode !== undefined) {
        const protocolByMode = { none: 'NONE', x10: 'X10', vt200: 'VT200', drag: 'DRAG', any: 'ANY' };
        const protocol = protocolByMode[tabState.shellMouseTrackingMode] || 'NONE';
        mouseService._activeProtocol = protocol;
        mouseService._onProtocolChange?.fire(mouseService._protocols[protocol]?.events || 0);
        tabState.term.element?.classList.toggle('enable-mouse-events', protocol !== 'NONE');
        delete tabState.shellMouseTrackingMode;
    }
}

function bindShellTextModeWheel(tabState, element) {
    bindTerminalWheel(tabState?.term, element, () => tabState.textMode || (
        tabState.term.buffer.active.type === 'normal' && tabState.term.modes.mouseTrackingMode === 'none'
    ));
}

function getWorkspaceTabMenuCapabilities(tabId, groupId, itemId) {
    const groupId_ = groupIdForWorkspaceTab(tabId) || groupId || activeGroupId;
    const source = workspaceModel && tabModel.locateTab(workspaceModel, tabId, itemId);
    const group = workspaceModel && tabModel.groupLayout(workspaceModel, groupId_);
    return {
        groupId: groupId_,
        paneId: source?.stack.id || '',
        itemId: source?.item.id || '',
        isMultiGroup: workspaceModel ? !tabModel.isFlat(workspaceModel) : false,
        groupSplitEnabled: Boolean(workspaceModel && workspaceModel.layout.root.type === 'split'),
        splitEnabled: group?.splitEnabled === true,
        canMerge: Boolean(workspaceModel && tabModel.getMergeTarget(workspaceModel, tabId, itemId)),
        canSplit: Boolean(workspaceModel && tabModel.canSplitTab(workspaceModel, tabId, groupId_, itemId)),
        canMoveToOtherPane: Boolean(workspaceModel && tabModel.getOtherPaneTarget(workspaceModel, tabId, groupId_, itemId))
    };
}

function requestTerminalContextMenu(payload) {
    ipcRenderer.send('show-terminal-context-menu', {
        ...payload,
        ...getWorkspaceTabMenuCapabilities(payload.tabId, payload.groupId),
        labels: getContextMenuLabels()
    });
}

// 弹分组标签的右键菜单（分组级分屏入口）。
//
// 复用 show-terminal-context-menu 这条 IPC，只是把 terminalType 换成 'group'，
// 而不是另开一条通道：主进程那份菜单模板和发送回流逻辑已经存在，再造一条会让
// 「渲染进程发什么、主进程回什么」这套对应关系变成两套。
//
// tabId 为业务组身份，itemId 精确指向该组被点击的布局锚点。
function requestSerialGroupContextMenu(groupId, itemId) {
    requestWorkspaceTabContextMenu({ tabId: groupId, groupId, itemId });
}

// 标签栏与内容区共用模型能力；菜单展示不是执行授权，点击时仍重新校验。
function requestWorkspaceTabContextMenu({ tabId, groupId, itemId }) {
    if (!tabId || !workspaceModel) return;
    const capabilities = getWorkspaceTabMenuCapabilities(tabId, groupId, itemId);
    ipcRenderer.send('show-terminal-context-menu', {
        terminalType: tabModel.isContainer(workspaceModel.tabs[tabId]) ? 'group' : 'tab',
        tabId, ...capabilities, itemId: itemId || capabilities.itemId,
        canMerge: Boolean(tabModel.getMergeTarget(workspaceModel, tabId, itemId)),
        labels: getContextMenuLabels()
    });
}

function getLogicalTerminalBufferLine(buffer, lineIndex) {
    if (!buffer || lineIndex < 0 || lineIndex >= buffer.length) return null;

    let start = lineIndex;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;

    let end = lineIndex;
    while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;

    let text = '';
    for (let index = start; index <= end; index++) {
        const line = buffer.getLine(index);
        if (!line) continue;
        text += line.translateToString(index === end);
    }
    return { text, start, end };
}

function countLogicalLineOccurrencesAfter(buffer, target) {
    let occurrenceFromEnd = 1;
    for (let index = target.end + 1; index < buffer.length;) {
        const line = getLogicalTerminalBufferLine(buffer, index);
        if (!line) break;
        if (line.text === target.text) occurrenceFromEnd++;
        index = line.end + 1;
    }
    return occurrenceFromEnd;
}

function getTerminalBufferLineContextByEvent(term, element, event) {
    if (!term?.buffer?.active || !element) return null;

    const rect = element.getBoundingClientRect();
    const relativeY = event.clientY - rect.top;
    const rowHeight = rect.height / Math.max(1, term.rows || 1);
    const viewportRow = Math.max(0, Math.min((term.rows || 1) - 1, Math.floor(relativeY / Math.max(1, rowHeight))));
    const buffer = term.buffer.active;
    const bufferBaseY = buffer.viewportY || 0;
    const bufferLineIndex = bufferBaseY + viewportRow;
    const line = getLogicalTerminalBufferLine(buffer, bufferLineIndex);
    if (!line) return null;
    return {
        text: line.text,
        occurrenceFromEnd: countLogicalLineOccurrencesAfter(buffer, line)
    };
}

// 注意：term 可以是 getter 或返回 term 的函数。
//
// 非默认分组的终端实例是**惰性创建**的（由 createSerialRuntime 在切标签时建），
// 绑监听这一刻它可能还不存在。用惰性取值就能在每次右键时拿到当时的实例；
// 直接传实例会绑到默认分组的 term 上，表现为「在新分组终端里右键，
// 清屏却清掉了默认分组的屏幕」。
// 注意：term 可以传实例，也可以传返回实例的函数。
//
// 非默认分组的终端实例是**惰性创建**的（由 createSerialRuntime 在切标签时建），
// 绑监听这一刻它可能还不存在。传函数就能在每次右键时拿到当时的实例；
// 直接传实例会绑到默认分组的 term 上，表现为「在新分组终端里右键，
// 清屏却清掉了默认分组的屏幕」。
function bindTerminalContextMenu({ terminalType, term, element, getTabState }) {
    if (!element) return;
    const resolveTerm = () => (typeof term === 'function' ? term() : term);
    element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const currentTerm = resolveTerm();
        if (!currentTerm) return;
        const tabState = typeof getTabState === 'function' ? getTabState() : null;
        const tabId = tabState?.id || (terminalType === 'main' ? mainTabId(REGISTRY_DEFAULT_GROUP_ID) : '');
        const groupId = groupIdForWorkspaceTab(tabId) || activeGroupId;
        if (tabState && terminalType === 'filter') {
            tabState.contextLine = getTerminalBufferLineContextByEvent(currentTerm, element, event);
        }
        requestTerminalContextMenu({
            terminalType,
            paneId: resolvePaneId(tabState?.paneId, tabId, mainTabId(groupId)),
            tabId,
            groupId,
            hasSelection: currentTerm.hasSelection(),
            selectedText: currentTerm.hasSelection() ? currentTerm.getSelection() : '',
            isConnected: isGroupConnected(groupId),
            splitEnabled: getGroupWorkspaceManager(groupId).isSplitEnabled(),
            filterText: tabState?.filterText || '',
            canLocateInMain: Boolean(tabState?.contextLine?.text),
            caseSensitive: Boolean(tabState?.caseSensitive),
            wholeWord: Boolean(tabState?.wholeWord),
            useRegex: Boolean(tabState?.useRegex),
            shellTextMode: Boolean(tabState?.textMode),
            receiveDisplayMode: getGroupDisplay(groupId).receiveDisplayMode
        });
    });
}

function bindTerminalWheel(term, element, shouldHandle = () => true) {
    if (!term || !element) return;
    // 外层捕获先于 xterm 的滚动容器处理，避免同一滚轮事件再按默认速度滚动。
    element.addEventListener('wheel', (event) => {
        if (!shouldHandle() || event.deltaY === 0 || !Number.isFinite(event.deltaY)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        term.scrollLines(Math.sign(event.deltaY) * mouseWheelScrollLines);
    }, { passive: false, capture: true });
}

function locateInMainTerminal(context) {
    if (!context?.text || !serialTerm?.buffer?.active) return false;
    const buffer = serialTerm.buffer.active;
    let remainingOccurrence = Math.max(1, Number(context.occurrenceFromEnd) || 1);
    let match = null;
    for (let index = buffer.length - 1; index >= 0;) {
        const line = getLogicalTerminalBufferLine(buffer, index);
        if (!line) break;
        if (line.text === context.text && --remainingOccurrence === 0) {
            match = line;
            break;
        }
        index = line.start - 1;
    }
    if (!match) return false;

    switchPaneTab(getPaneIdForTabId('tab-main'), 'tab-main');
    requestAnimationFrame(() => {
        serialTerm.scrollToLine(match.start);
        serialTerm.selectLines(match.start, match.end);
    });
    return true;
}

function setSearchFromText(text) {
    if (!text) return;
    showSidebarTab('tab-search');
    searchInput.value = text;
    resetSearchState();
    refreshSearchCount({ force: true });
}

function focusSearchWithActiveSelection() {
    setSidebarCollapsed(false);
    const target = getActiveSearchTarget();
    const selectedText = target?.term?.hasSelection?.() ? target.term.getSelection() : '';
    if (selectedText) {
        setSearchFromText(selectedText);
    } else {
        showSidebarTab('tab-search');
    }
    searchInput?.focus();
    searchInput?.select();
}

function clearTerminalByTabId(tabId) {
    if (!tabId || tabId === 'tab-main' || tabId.startsWith('tab-main-')) {
        const groupId = resolveGroupIdForMainTab(tabId || 'tab-main');
        if (getGroupDisplay(groupId).receiveDisplayMode === 'hex') getHexFormatter(groupId).reset({ resetOffset: false });
        else resetTextReceive(groupId);
        clearTerminalOutput(getSerialTerm(groupId));
        serialGroupContext.resetLineCounters(groupId);
        // 尚未上屏的字节也要一起丢掉，否则清空后旧数据会紧接着又冒出来。
        serialOutputBuckets.clear(groupId);
        return;
    }
    const ownerGroupId = groupIdForWorkspaceTab(tabId);
    const filterTab = ownerGroupId ? filterTabsStore.getList(ownerGroupId).find(t => t.id === tabId) : null;
    if (filterTab) {
        clearTerminalOutput(filterTab.term);
        filterTab.contextLine = null;
        return;
    }
    const shellTab = getShellTabState(tabId);
    if (shellTab) {
        invalidateTerminalSearch(shellTab.term, 'clear', { clearAnchor: true });
        shellTab.term.clear();
    }
}

function restartShellTab(tabId) {
    const shellTab = getShellTabState(tabId);
    if (!shellTab) return;
    ipcRenderer.send('close-shell-tab-session', { tabId });
    shellTab.mouseModeSequenceCarry = '';
    shellTab.mouseInputSequenceCarry = '';
    invalidateTerminalSearch(shellTab.term, 'reset', { clearAnchor: true });
    shellTab.term.reset();
    shellTab.btn?.classList.remove('exited');
    shellTab.term.writeln(`\r\n[${tr('main.shellStarting')}]\r\n`);
    ipcRenderer.invoke('create-shell-tab-session', { tabId, cols: shellTab.term.cols, rows: shellTab.term.rows, profileId: shellTab.profileId || '' })
        .then(() => {
            shellTab.sessionReady = true;
            ipcRenderer.send('resize-shell-tab', { tabId, cols: shellTab.term.cols, rows: shellTab.term.rows });
            setActionStatus(tr('main.shellStarting'));
        })
        .catch((error) => {
            shellTab.term.writeln(`\r\n[ERROR] ${tr('main.shellStartFailed', { error: error?.message || error })}\r\n`);
        });
}

async function handleTerminalContextMenuAction(payload = {}) {
    const { action, tabId, terminalType, paneId } = payload;
    if (workspaceModel && (/^split-(left|right|top|bottom)$/.test(action) || action === 'merge-layout' || action === 'close-group-split' || action === 'close-split')) {
        const sourceId = tabId || payload.groupId;
        const hit = tabModel.locateTab(workspaceModel, sourceId, payload.itemId);
        const result = hit && dispatchWorkspaceAction(action.startsWith('split-')
            ? { type: 'split', source: { tabId: sourceId, itemId: hit.item.id }, target: { nodeId: hit.stack.id }, direction: action.slice(6) }
            : { type: 'merge', source: { tabId: sourceId, itemId: hit.item.id } });
        setActionStatus(result?.ok ? '已更新局部分屏' : `无法更新分屏：${result?.reason || '没有合法目标'}`);
        return;
    }
    // 被右键的那一个分组（主进程回传）。分组级动作必须作用于它而不是激活分组：
    // 用户右键的是「这一个组」，而激活组可能是旁边那个（实测 diag985：三列共存时
    // 右键 g-2 选分屏，参与表里记的却是 g-1）。
    const contextGroupId = payload.groupId ? resolveSerialGroupId(payload.groupId) : activeGroupId;
    const isFilter = terminalType === 'filter';
    const isShell = terminalType === 'shell';
    const isChart = terminalType === 'chart';
    const isGroup = terminalType === 'group';
    const filterTab = isFilter ? filterTabsStore.getList(contextGroupId).find(tab => tab.id === tabId) : null;
    const shellTab = isShell ? getShellTabState(tabId) : null;
    const chartTab = isChart ? chartTabsStore.getList(contextGroupId).find(tab => tab.id === tabId) : null;
    const targetTerm = (isChart || isGroup) ? null : (isFilter ? filterTab?.term : (isShell ? shellTab?.term : serialRuntimes.get(contextGroupId)?.term));
    // 布局动作不依赖终端实例；菜单打开后标签可能已关闭，交给最新模型拒绝并提示。
    const isLayoutAction = ['split-horizontal', 'split-vertical', 'move-to-other-pane'].includes(action);
    if (!isGroup && !isLayoutAction && ((isChart && !chartTab) || (!isChart && !targetTerm && action !== 'paste-send'))) return;

    switch (action) {
        case 'copy-all': {
            const text = getTerminalPlainText(targetTerm);
            if (text) {
                await writeClipboardText(text);
            }
            break;
        }
        case 'find-selection': {
            const text = targetTerm?.getSelection();
            if (text) {
                setSearchFromText(text);
            }
            break;
        }
        case 'clear-terminal': {
            clearTerminalByTabId(tabId || 'tab-main');
            setActionStatus(trFallback('main.terminalCleared', 'Terminal cleared'));
            break;
        }
        case 'clear-reset-hex':
        case 'clear-and-reset-hex':
        case 'reset-hex-offset': {
            clearTerminalByTabId(mainTabId(contextGroupId));
            getHexFormatter(contextGroupId).reset({ resetOffset: true });
            setActionStatus(trFallback('main.hexOffsetReset', 'Terminal cleared and Hex offset reset'));
            break;
        }
        case 'paste-send': {
            const text = await readClipboardText();
            if (text) {
                if (isShell && shellTab) {
                    shellTab.term.paste(text);
                } else if (isGroupConnected(contextGroupId)) {
                    await sendSerialRequest({ groupId: contextGroupId, mode: 'text', content: text, source: 'paste' }, SEND_LIMITS.paste);
                }
            }
            break;
        }
        case 'send-selection': {
            const text = targetTerm?.getSelection();
            if (text && isShell && shellTab) {
                ipcRenderer.send('shell-tab-input', { tabId: shellTab.id, data: text });
            } else if (text && isGroupConnected(contextGroupId)) {
                await sendSerialRequest({ groupId: contextGroupId, mode: 'text', content: text, source: 'selection' }, SEND_LIMITS.paste);
            }
            break;
        }
        case 'create-filter-from-selection': {
            const text = targetTerm?.getSelection();
            if (text) {
                createFilterTab({ filterText: text, caseSensitive: false, useRegex: false, dataMode: getGroupDisplay(contextGroupId).receiveDisplayMode }, resolvePaneId(paneId, tabId));
                setActionStatus('已用选中文本新建过滤标签页');
            }
            break;
        }
        case 'new-filter-tab': {
            createFilterTab({}, resolvePaneId(paneId, tabId));
            setActionStatus('已新建过滤标签页');
            break;
        }
        // 右键菜单里的「新建图表」：与二级栏那个按钮走同一个 createChartTab，
        // 不另写一条创建逻辑（否则两条路的默认参数、落 pane 规则会各自漂移）。
        case 'new-chart-tab': {
            createChartTab({}, resolvePaneId(paneId, tabId));
            setActionStatus('已新建图表标签页');
            break;
        }
        case 'split-group-horizontal':
        case 'split-group-vertical': {
            const hit = workspaceModel && tabModel.locateTab(workspaceModel, contextGroupId, payload.itemId);
            const result = hit && dispatchWorkspaceAction({ type: 'split', source: { tabId: contextGroupId, itemId: hit.item.id },
                target: { nodeId: hit.stack.id }, direction: action === 'split-group-vertical' ? 'bottom' : 'right' });
            setActionStatus(result?.ok ? '已移动指定串口组' : '无法分屏：没有合法目标');
            break;
        }
        case 'add-serial-group': {
            addSerialGroupFromUi();
            break;
        }

        // 重命名对四类标签都成立：分组标签改分组名（可跟随端口），
        // 其余标签改自己的标题。统一在这里分发，菜单项只有一处。
        case 'rename-tab': {
            const renameTarget = resolveRenameTarget({ terminalType, tabId, contextGroupId });
            if (renameTarget) openRenameTabDialog(renameTarget);
            break;
        }
        case 'split-horizontal':
        case 'split-vertical': {
            const orientation = action === 'split-vertical' ? 'vertical' : 'horizontal';
            const changed = Boolean(tabId) && splitWorkspaceTabIntoPane({ tabId, groupId: contextGroupId, orientation });
            setActionStatus(changed
                ? (orientation === 'vertical' ? '已将标签页移入上下分屏' : '已将标签页移入左右分屏')
                : '无法新建分屏：当前格至少需要两个标签，或标签位置已变化，请重新打开菜单');
            break;
        }
        case 'move-to-other-pane': {
            const changed = moveWorkspaceTabToOtherPane({ tabId, groupId: contextGroupId, itemId: payload.itemId });
            setActionStatus(changed
                ? '已移动标签页到另一个分屏'
                : '无法移动：没有可用的其他分屏，或标签位置已变化，请重新打开菜单');
            break;
        }
        case 'close-split': {
            getGroupWorkspaceManager(contextGroupId).collapseSplit();
            setActionStatus('已关闭分屏');
            break;
        }
        case 'toggle-chart-paused': {
            if (chartTab) toggleChartPaused(chartTab);
            break;
        }
        case 'chart-return-live': {
            chartTab?.view?.returnToLive();
            break;
        }
        case 'clear-chart': {
            if (chartTab) clearChartDataSession(chartTab);
            break;
        }
        case 'export-chart-window': {
            if (chartTab) await exportChartSamples('window', chartTab);
            break;
        }
        case 'export-chart-all': {
            if (chartTab) await exportChartSamples('all', chartTab);
            break;
        }
        case 'chart-settings': {
            if (chartTab) openChartSettings(chartTab);
            break;
        }
        case 'close-chart-tab': {
            if (chartTab) await closeChartTab(chartTab.id);
            break;
        }
        case 'use-selection-as-filter': {
            const text = targetTerm?.getSelection();
            if (filterTab && text) {
                const input = filterTab.element.querySelector('.filter-input');
                input.value = text;
                filterTab.filterText = text;
                filterTab.updateRegex();
            }
            break;
        }
        case 'append-selection-to-filter': {
            const text = targetTerm?.getSelection();
            if (filterTab && text) {
                const input = filterTab.element.querySelector('.filter-input');
                input.value = `${input.value || ''}${text}`;
                filterTab.filterText = input.value;
                filterTab.updateRegex();
            }
            break;
        }
        case 'locate-in-main-terminal': {
            if (!filterTab) break;
            if (!locateInMainTerminal(filterTab.contextLine)) {
                setActionStatus(tr('main.searchResultZero'));
            }
            break;
        }
        case 'toggle-case-sensitive': {
            if (filterTab) {
                filterTab.caseSensitive = !filterTab.caseSensitive;
                filterTab.caseBtn.classList.toggle('active', filterTab.caseSensitive);
                filterTab.updateRegex();
            }
            break;
        }
        case 'toggle-whole-word': {
            if (filterTab) {
                filterTab.wholeWord = !filterTab.wholeWord;
                filterTab.wordBtn.classList.toggle('active', filterTab.wholeWord);
                filterTab.updateRegex();
            }
            break;
        }
        case 'toggle-regex': {
            if (filterTab) {
                filterTab.useRegex = !filterTab.useRegex;
                filterTab.regexBtn.classList.toggle('active', filterTab.useRegex);
                filterTab.updateRegex();
            }
            break;
        }
        case 'close-filter-tab': {
            if (filterTab) {
                await closeFilterTab(filterTab.id);
            }
            break;
        }
        case 'new-shell-tab': {
            createShellTab({ profileId: getDefaultShellProfileId() }, resolvePaneId(paneId, tabId));
            setActionStatus(tr('main.shellStarting'));
            break;
        }
        case 'close-shell-tab': {
            if (shellTab) {
                await closeShellTab(shellTab.id);
            }
            break;
        }
        case 'restart-shell': {
            if (shellTab) {
                restartShellTab(shellTab.id);
            }
            break;
        }
        case 'toggle-shell-text-mode': {
            if (shellTab) {
                shellTab.textMode = !shellTab.textMode;
                setShellTextMode(shellTab, shellTab.textMode);
                updateShellTextMode(shellTab);
            }
            break;
        }
    }
}

// Initialize Terminals
/*
const term = new Terminal({ cursorBlink: true });
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));
*/

// 主串口终端的构造模板。
//
// 为什么做成模板而不是直接 new 一个：多分组需要「一个分组一个终端」，若每个分组
// 各写一段构造代码，壁纸、Unicode 11 宽度、字体回退这些跨终端一致性就会逐份漂移。
// 只保留一份模板，`createSerialRuntime(groupId)` 对任意分组都走它。
//
// **必须带上设置里的显示参数（字体/字号/主题）**：这里曾经只返回 cursorBlink 四项，
// 于是后建的分组拿到 xterm 默认字体，而默认分组的字体是 `applyConfig` 事后单独写进去的
// —— 用户看到的就是「新建的串口组日志终端字体没跟着设置走」。模板才是唯一真相源，
// 不能让「默认分组额外被赋一次值」成为它和后续分组的差别。
//
// **config 为空时必须提前返回不带显示参数的版本**：默认分组的终端在模块加载期就建，
// 那时 `currentConfig` 还是 null，而 `getTerminalTheme` 要读 `highlightColors.selection`，
// 直接传进去会抛 TypeError 把整个 renderer 加载搞挂（实测：
// `renderer.js failed at module init: Cannot read properties of undefined (reading 'selection')`）。
// 设置到位后 `applyConfig` 会用同一个模板重写一次，所以这里不需要猜任何默认值。
function buildSerialTerminalOptions(config = currentConfig) {
    const options = {
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: true
    };
    if (!config) return options;
    return {
        ...options,
        fontSize: config.fontSize,
        fontWeight: config.fontWeight,
        fontFamily: TERMINAL_FONT_FAMILY(config),
        scrollback: config.scrollbackLimit || 20000,
        theme: getTerminalTheme(config)
    };
}

// 按 groupId 建一个完整的串口终端运行时（终端 + fit + search + 解析器）。
//
// 容器 id 由 serial-group-dom.js 统一计算，默认分组仍是 'serial-container'。
// 若容器不存在就不再建——xterm 的 open() 拿到 null 会直接抛，而且报到的是 xterm 内部，
// 很难看出真正原因在哪里。返回 null 让调用方自己决定怎么报错更清楚。
function createSerialRuntime(groupId) {
    const containerId = serialContainerId(groupId);
    const container = document.getElementById(containerId);
    if (!container) return null;

    const term = new Terminal(buildSerialTerminalOptions());
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    enableTerminalUnicode11(term);
    term.open(container);
    bindTerminalWheel(term, container);

    // 每个分组自己的行解析器，行号只能记进它自己的分组上下文。
    const dataParser = new SerialDataParser({ prefixProvider: () => getPrefix(groupId) });

    return {
        groupId,
        term,
        fitAddon,
        searchAddon,
        dataParser,
        container,
        dispose() {
            unobserveTerminalSearchChanges(term);
            dataParser.reset();
            try {
                term.dispose();
            } catch (error) {
                console.error(`Failed to dispose terminal for group ${groupId}:`, error);
            }
        }
    };
}

// 分组终端运行时注册表：负责「谁持有、什么时候建、什么时候释放」。
// 构造函数不建任何实例——xterm 需要真实 DOM，而这里执行时标签尚未渲染完。
const serialRuntimes = new SerialTerminalRuntimeRegistry({
    defaultGroupId: REGISTRY_DEFAULT_GROUP_ID,
    createRuntime: createSerialRuntime
});

// 默认分组的终端在模块加载期就要建好：主终端是应用启动后就存在的东西，
// 而且后面的 32 处 serialTerm 引用全部依赖它已存在。
const defaultSerialRuntime = serialRuntimes.getOrCreate(REGISTRY_DEFAULT_GROUP_ID);
if (!defaultSerialRuntime) {
    throw new Error(`Missing serial container for group ${REGISTRY_DEFAULT_GROUP_ID}`);
}
serialRuntimes.assertDefaultAttached();
const serialTerm = defaultSerialRuntime.term;
const serialFitAddon = defaultSerialRuntime.fitAddon;
const serialSearchAddon = defaultSerialRuntime.searchAddon;
// 默认分组的行解析器直接用运行时里那一个，绝不另建。
dataParser = defaultSerialRuntime.dataParser;
// serialTerm.open() 已在 createSerialRuntime() 里做过。这里不能再调一次：
// xterm 重复 open 同一容器会重建 DOM 并丢掉已写入内容，且不报错。
const mainTabButton = document.querySelector('.main-tab[data-target="tab-main"]');
if (mainTabButton) {
    // 必须按标签**所属分组**切换，不能用模块级别名：
    // 静态 tab-main 属于默认分组，而切到 g-1 后别名指向 g-1 的布局，
    // switchPaneTab 会在 g-1 里找 tab-main 而直接返回，表现为「点主标签没反应」。
    //
    // 也不能给 switchPaneTab 传 groupId：它只转交给模块级别名。
    // 这里先把别名切到默认分组，切完再恢复。
    mainTabButton.addEventListener('click', () => {
        const savedGroupId = activeGroupId;
        setActiveGroupWorkspace(REGISTRY_DEFAULT_GROUP_ID);
        try {
            switchPaneTab(getPaneIdForTabId('tab-main'), 'tab-main');
        } finally {
            setActiveGroupWorkspace(savedGroupId);
        }
    });
}

function bindChartContextMenu(tab) {
    tab.element.addEventListener('contextmenu', event => {
        event.preventDefault();
        const range = tab.view?.viewRange;
        requestTerminalContextMenu({
            terminalType: 'chart',
            paneId: resolvePaneId(tab.paneId, tab.id),
            tabId: tab.id,
            splitEnabled: isSplitEnabled(),
            paused: tab.paused,
            canReturnToLive: Boolean(tab.view?.fullRange && !tab.view.following),
            canExportWindow: Boolean(range && tab.model?.query(range[0], range[1]).length),
            canExportAll: Boolean(tab.model?.samples.length)
        });
    });
}

async function showWelcomeGuideForCurrentVersion(config) {
    if (welcomeGuideChecked) return;
    welcomeGuideChecked = true;
    try {
        const aboutInfo = await ipcRenderer.invoke('get-about-info');
        const version = typeof aboutInfo?.version === 'string' ? aboutInfo.version : '';
        if (!version || config.lastWelcomeVersion === version) return;
        serialTerm.write(buildWelcomeGuideOutput(version));
        config.lastWelcomeVersion = version;
        ipcRenderer.send('save-config', { lastWelcomeVersion: version });
    } catch (error) {
        console.error('Failed to show welcome guide:', error);
    }
}

function buildWelcomeGuideOutput(version) {
    const reset = '\x1b[0m';
    const banner = [
        '██╗ ████████╗███████╗████████╗',
        '╚██╗╚══██╔══╝██╔════╝╚══██╔══╝',
        ' ╚██╗  ██║   ███████╗   ██║   ',
        ' ██╔╝  ██║   ╚════██║   ██║   ',
        '██╔╝   ██║   ███████║   ██║   ',
        '╚═╝    ╚═╝   ╚══════╝   ╚═╝   '
    ];
    const bannerColors = ['45;212;191', '34;211;238', '56;189;248', '96;165;250', '129;140;248', '192;132;252'];
    const bannerOutput = banner.map((line, index) => `\x1b[1;38;2;${bannerColors[index]}m${line}${reset}`).join('\r\n');
    const guideLines = tr('main.welcomeGuide', { version }).split('\n').map((line, index, lines) => {
        if (index === 0) return `\x1b[1;38;2;94;234;212m${line}${reset}`;
        const feature = line.match(/^(\d+\.\s*)([^:：]+)([:：])(.*)$/);
        if (feature) {
            return `\x1b[1;38;2;250;204;21m${feature[1]}${reset}`
                + `\x1b[1;38;2;96;165;250m${feature[2]}${feature[3]}${reset}`
                + `\x1b[38;2;203;213;225m${feature[4]}${reset}`;
        }
        if (index === lines.length - 1) return `\x1b[38;2;192;132;252m${line}${reset}`;
        return line;
    }).join('\r\n');
    const clearHint = `\x1b[1;38;2;251;191;36m${tr('main.welcomeClearHint')}${reset}`;
    return `${bannerOutput}\r\n\r\n${guideLines}\r\n\r\n${clearHint}\r\n\r\n`;
}
// 默认分组的终端容器供 context menu 与后续 fit 使用；滚轮在 runtime 构造时统一绑定。
// 各自重新 getElementById 会让「容器换了一个」这类错误分散到三处、无法统一修正。
const serialContainerEl = document.getElementById(serialContainerId(REGISTRY_DEFAULT_GROUP_ID));
bindTerminalContextMenu({
    terminalType: 'main',
    term: serialTerm,
    element: serialContainerEl
});

// Filter Tabs Management
//
// `filterTabs` / `chartTabs` 从 P5 起**每个串口分组各一份**。做法与 P4 把四个显示
// 参数下沉时完全同构：把真实存储交给 store，模块级这两个 `let` 只作为「指向当前分组那个
// 数组」的别名。切换分组时改指向即可——现有 54 处 `filterTabs.forEach/.find/.push`
// 一行都不用改。
//
// 为什么这两个 `let` 必须保留（而不是全部改成 getGroupTabList(groupId)）：
// 消费点分布在渲染、日志、导出、右键菜单、图表写入等几十处，逐处改 groupId 的
// 漏改代价是「标签写进了别的分组」这类不会报错的缺陷。别名方案把风险集中在
// setActiveGroupTabLists() 这一个函数上。
const filterTabsStore = createGroupTabListStore({ defaultGroupId: REGISTRY_DEFAULT_GROUP_ID });
const chartTabsStore = createGroupTabListStore({ defaultGroupId: REGISTRY_DEFAULT_GROUP_ID });
let filterTabs = filterTabsStore.getList(REGISTRY_DEFAULT_GROUP_ID);
let chartTabs = chartTabsStore.getList(REGISTRY_DEFAULT_GROUP_ID);

// 把上面两个别名指向指定分组的数组。必须在切分组时调用，且必须**早于**任何
// 该分组的标签读写——applyActiveSerialGroup() 的第一条语句就是它。
//
// 默认参数用常量 REGISTRY_DEFAULT_GROUP_ID 而不是 activeGroupId：本函数会在
// 模块加载期被 syncSerialGroupsFromConfig 间接调用，那时 activeGroupId 还在 TDZ 里。
function setActiveGroupTabLists(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    filterTabs = filterTabsStore.getList(id);
    chartTabs = chartTabsStore.getList(id);
    return { filterTabs, chartTabs };
}
let nextFilterTabId = 1;
let shellTabs = [];
let nextShellTabId = 1;
let nextChartTabId = 1;
let renameTabState = null;
const renameTabDialog = document.getElementById('rename-tab-dialog');
const renameTabInput = document.getElementById('rename-tab-input');
const renameTabFollowPortRow = document.getElementById('rename-tab-follow-port-row');
const renameTabFollowPortInput = document.getElementById('rename-tab-follow-port');
const renameTabValidation = document.getElementById('rename-tab-validation');

function getPaneDom(paneId) {
    return document.getElementById(paneId);
}

function getPaneTabsList(paneId) {
    return document.getElementById(`${paneId}-tabs-list`);
}

function getPaneTabsContent(paneId) {
    return document.getElementById(`${paneId}-tabs-content`);
}

// 普通标签按钮（main / filter / chart / shell）上的右键菜单。
//
// 为什么需要这一层：分组级分屏是「右键标签」触发的，但之前只有 `.serial-group-tab`
// （分组标签本身）挂了 contextmenu。主终端、过滤页、图表页、Shell 的标签按钮全都没挂，
// 于是「有些标签右键没反应」——而恰恰是这些标签所属的分组才是用户想移走的那一组。
//
// 为什么复用 requestSerialGroupContextMenu 而不是另开一套菜单：右键一个普通标签时，
// 用户的意图是「把我现在待的这个串口组移走」，作用面仍是分组而不是该标签。菜单项
// （左右 / 上下 / 关闭分屏 / 新建串口）与分组标签上的完全一致，分出一套只会让两份
// 模板各自漂移。
//
// 为什么必须委托：标签按钮会被 appendChild 在行之间搬动（Shell 在列首行与分组行之间
// 来回走），构造时用闭包绑定的引用在搬动后仍有效，但拿到的 paneId 可能已经过时。
// 委托在列表容器上、每次从 dataset 现读，与分组标签的写法保持一致。
//
// 初始化兼容行使用本委托；运行态行由递归布局协调器捕获事件并读取精确成员身份。
function bindPaneTabListEvents(listEl) {
    if (!listEl || listEl.dataset.paneTabEvents === '1') return;
    listEl.dataset.paneTabEvents = '1';
    listEl.addEventListener('contextmenu', event => {
        // 分组标签自己的委托已经处理过，不要重复弹菜单。
        if (event.target.closest('.serial-group-tab')) return;
        const button = event.target.closest('.main-tab');
        if (!button) return;
        const tabId = button.dataset.target;
        if (!tabId) return;
        // 标签属于哪个分组，就用那个分组的菜单。
        // Shell 不在任何 pane.tabIds 里，resolvePaneId 会回落到默认 pane，
        // 那时按激活分组算——用户右键 Shell 想移走的也是他当前正在看的那个组。
        const paneId = resolvePaneId(button.dataset.paneId, tabId);
        const groupId = groupIdFromPaneId(paneId) || activeGroupId;
        event.preventDefault();
        event.stopPropagation();
        // 单分组时给组内 pane 分屏项，多分组时仍是分组级菜单（由它内部判定）。
        requestWorkspaceTabContextMenu({ tabId, paneId, groupId });
    });
}

// 优先查实际布局成员；新 pane 尚未登记时按完整生成 ID 比对，不能用宽前缀。
function groupIdFromPaneId(paneId) {
    if (typeof paneId !== 'string' || !paneId) return null;
    if (workspaceModel) {
        const hit = tabModel.tree.find(workspaceModel.layout.root, paneId);
        if (hit?.scope) return hit.scope.tabId;
        if (hit?.node.type === 'stack') {
            const selected = hit.node.items.find(item => item.id === hit.node.activeItemId);
            if (selected?.content) return selected.tabId;
            const anchor = hit.node.items.find(item => item.content);
            if (anchor) return anchor.tabId;
        }
        return tabModel.isFlat(workspaceModel) ? serialGroups[0]?.id : null;
    }
    const index = /^pane-(\d+)(?:-|$)/.exec(paneId)?.[1];
    const hit = serialGroups.find(group =>
        groupWorkspaceLayouts.get(group.id)?.panes.some(pane => pane.id === paneId)
        || (index && groupPaneId(group.id, Number(index)) === paneId));
    return hit?.id || null;
}

function groupIdForWorkspaceTab(tabId) {
    if (!tabId) return null;
    if (workspaceModel) {
        const tab = workspaceModel.tabs[tabId];
        return tab?.ownerGroupId || tab?.parentId || null;
    }
    const group = serialGroups.find(item =>
        tabId === mainTabId(item.id)
        || groupWorkspaceLayouts.get(item.id)?.panes.some(pane => pane.tabIds.includes(tabId))
        || filterTabsStore.getList(item.id).some(tab => tab.id === tabId)
        || chartTabsStore.getList(item.id).some(tab => tab.id === tabId));
    return group?.id || null;
}

function moveWorkspaceTabToOtherPane({ tabId, groupId, itemId }) {
    if (!workspaceModel) return false;
    const id = groupIdForWorkspaceTab(tabId) || groupId || activeGroupId;
    const target = tabModel.getOtherPaneTarget(workspaceModel, tabId, id, itemId);
    if (!target) return false;
    const result = dispatchWorkspaceAction({ type: 'move', tabId, itemId, target });
    if (result.ok) { persistGroupWorkspaceLayout(id); persistShellTabs(); }
    return result.ok;
}

// The compatibility axis entry translates directly into a local tree split.
function splitWorkspaceTabIntoPane({ tabId, groupId, orientation }) {
    if (!workspaceModel) return false;
    const id = groupIdForWorkspaceTab(tabId) || groupId || activeGroupId;
    const hit = tabModel.locateTab(workspaceModel, tabId);
    const result = hit && dispatchWorkspaceAction({ type: 'split', source: { tabId },
        target: { nodeId: hit.stack.id }, direction: orientation === 'vertical' ? 'bottom' : 'right' });
    if (result?.ok) { persistGroupWorkspaceLayout(id); persistShellTabs(); }
    return result?.ok === true;
}


// 二级标签行的动作按钮组（新建 Shell / 过滤 / 图表）——**唯一构造路径**。
//
// 为什么必须只留这一条：默认分组的 pane-1/pane-2 在 index.html 里有静态标记，
// 非默认分组的 pane 由 createGroupPaneElement 现建。两处各写一份的代价是实测过的：
// 静态标记里按钮之间的换行缩进会渲染成空白文本节点（实测 6 个，每个约一个空格宽），
// 动态创建的没有，于是第一组与第二组的相邻间距分别是 8.39px 与 4px（diag1052）。
// 用户报的「两个明明可以复用的控件，还是单独实现」指的就是这个。
//
// 因此：
//   • 按钮一律用 DOM API 建，**不插入任何文本节点**，间距只由 CSS 的 gap 决定；
//   • 静态 pane 的动作组在加载期用同一函数重建；
//   • 新增按钮只改 PANE_ACTION_BUTTON_SPECS，不再改两处 DOM。
const PANE_ACTION_BUTTON_SPECS = Object.freeze([
    { kind: 'shell', icon: 'terminal', titleKey: 'main.newShellTab' },
    { kind: 'filter', icon: 'filter_alt', titleKey: 'main.newFilterTab' },
    { kind: 'chart', icon: 'show_chart', titleKey: 'main.newChartTab' },
    { kind: 'serial', icon: 'add', titleKey: 'main.addSerialPort' }
]);

// create 闭包必须拿**按钮所在的 pane**，否则在第二分屏那一行点「新建过滤」会建到第一个 pane 里。
function createPaneActionButtons(paneId) {
    const elements = [];
    PANE_ACTION_BUTTON_SPECS.forEach(spec => {
        const button = document.createElement('button');
        button.id = `${paneId}-new-${spec.kind}-tab-btn`;
        button.className = 'secondary pane-new-tab-btn';
        button.type = 'button';
        button.title = tr(spec.titleKey);
        button.appendChild(createMaterialIcon(spec.icon, 'material-icon'));
        button.addEventListener('click', () => {
            if (spec.kind === 'shell') createShellTab({ profileId: getDefaultShellProfileId() }, paneId);
            else if (spec.kind === 'filter') createFilterTab({}, paneId);
            else if (spec.kind === 'chart') createChartTab({}, paneId);
            else addSerialGroupFromUi();
        });
        elements.push(button);
    });
    return elements;
}

// 把一个动作组容器填成标准形态。静态标记里的空白文本节点也一并消失，
// 于是「间距不一致」不可能再因源码排版而复发。
//
// 不用 replaceChildren：模块加载期的 DOM 门禁用的是最小 stub，
// 只实现了 removeChild / appendChild，用交集写法才能让两者都跑得起来。
function fillPaneActionButtons(actionsEl, paneId) {
    if (!actionsEl) return;
    // 先把旧节点（含空白文本节点）清干净：只持元素而不持文本，是保证间距只由 CSS 决定的前提。
    while (actionsEl.firstChild) actionsEl.removeChild(actionsEl.firstChild);
    createPaneActionButtons(paneId).forEach(button => actionsEl.appendChild(button));
}

// 按需创建第 3 个及以后的 pane 节点。
//
// index.html 里 pane-1 / pane-2 是静态写死的，行为与改造前完全一致；
// 但布局层已经支持 N 个 pane（P5），多出来的 pane 必须能现建。
// 不建的话，appendChild(null) 会静默把标签页丢掉——这是最难查的一类空面板缺陷。
//
// rootId 默认 `workspace-root`（默认分组，普通单串口路径与改造前一致）。
// 多分组时调用方传本分组自己的 root（`workspace-root-<g>`），否则新建的 pane
// 会全部挂进默认分组的工作区，表现为「g-1 里点新分屏没反应」。
function createPaneElement(paneId, rootId = 'workspace-root') {
    if (!paneId || getPaneDom(paneId)) return null;
    const root = document.getElementById(rootId);
    if (!root) return null;

    const paneEl = document.createElement('div');
    paneEl.className = 'workspace-pane';
    paneEl.id = paneId;
    paneEl.dataset.paneId = paneId;
    paneEl.hidden = true;

    const header = document.createElement('div');
    header.className = 'main-tabs-header pane-tabs-header';
    const tabsList = document.createElement('div');
    tabsList.className = 'main-tabs-list pane-tabs-list';
    tabsList.id = `${paneId}-tabs-list`;
    tabsList.setAttribute('role', 'tablist');
    // 二级栏的动作按钮组只走 createPaneActionButtons 这一条路径（见其函数头）。
    // 这里不能再写一份 buttonSpecs：静态标记与动态 pane 各写一份，正是两组间距
    // 不一致（8.39px vs 4px）的根因。
    const actions = document.createElement('div');
    actions.className = 'pane-tab-actions';
    actions.append(...createPaneActionButtons(paneId));
    header.appendChild(tabsList);
    header.appendChild(actions);
    // 右键菜单委托必须在列表建好时就挂上：标签按钮是后来 appendChild 进来的，
    // 事件委托不依赖子节点已存在。
    bindPaneTabListEvents(tabsList);

    const content = document.createElement('div');
    content.className = 'main-tabs-content pane-tabs-content';
    content.id = `${paneId}-tabs-content`;

    paneEl.appendChild(header);
    paneEl.appendChild(content);
    // 内容区激活由 document 委托统一处理，覆盖静态与动态 pane。

    // 追加到最后一个已有 pane 之后，保证 splitter 仍然落在中间。
    // 若直接 appendChild 到 root，新 pane 会跑到 splitter 后面。
    const existingPanes = root.querySelectorAll('.workspace-pane');
    const lastPane = existingPanes[existingPanes.length - 1];
    if (lastPane && lastPane.parentNode === root) {
        root.insertBefore(paneEl, lastPane.nextSibling);
    } else {
        root.appendChild(paneEl);
    }
    return paneEl;
}

function getShellTabState(tabId) {
    return shellTabs.find(tab => tab.id === tabId) || null;
}

function getChartTabState(tabId) {
    return chartTabs.find(tab => tab.id === tabId) || null;
}

// 每个分组的布局存在 Map 里；模块级 `workspaceLayout` 只是**当前激活分组**那份的别名。
//
// 注意这里用 normalizeGroupId 而不是 resolveSerialGroupId：后者对未登记的分组会
// 回落默认分组，那会把新分组的布局静默存到默认分组头上。
function getGroupWorkspaceLayout(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    if (workspaceModel && tabModel.isContainer(workspaceModel.tabs[groupId])) {
        return getGroupWorkspaceManager(groupId).getLayoutSnapshot();
    }
    const id = normalizeGroupId(groupId);
    let layout = groupWorkspaceLayouts.get(id);
    if (!layout) {
        layout = normalizeLayoutShape(
            createLayoutFromGroupConfig(id) || createDefaultLayoutForGroup(id),
            { mainTabId: mainTabId(id) }
        );
        groupWorkspaceLayouts.set(id, layout);
    }
    return layout;
}

// 默认布局：一个 pane，主标签落在 pane 内。
//
// pane id 必须跟着分组走（默认组 'pane-1'，其余 'pane-1-<g>'），
// 写死 'pane-1' 会让所有分组抢同一个 pane。
function createDefaultLayoutForGroup(groupId) {
    const id = normalizeGroupId(groupId);
    return createDefaultLayoutFor({
        paneIds: describeGroupWorkspace(id, { paneCount: 1 }).paneIds,
        mainTabId: mainTabId(id)
    });
}

// 从配置里的 panes / paneSplit 构造布局对象（§9.3 迁移的读取端）。
//
// 迁移只负责把旧键搬到新位置，真正让它们生效的是这里：少了这一步，
// 写进配置的 panes / paneSplit 就是死数据（重启后仍走默认布局）。
//
// 只做形状搬运，不在这里做不变式修复：pane 数、tab 归属、activeTabId
// 的合法性统一由 normalizeWorkspaceLayoutShape 负责，这一层再校验一遍
// 会出现两套规则，改一处漏一处就是新的真源分叉。
//
// 返回 null 表示「这个分组没存过布局」，由调用方回落默认布局。不能返回
// 一个空布局：那会把「从没打开过分屏」与「显式只有一个空 pane」混为一谈，
// 而后者会让 reconcileEmptyPanes 在启动时把一个本不该存在的 pane 合入。
//
// activePaneId 取 paneSplit 里记的那个：它就是用户在分屏下最后操作的那一栏。
// 不合法时 normalizeWorkspaceLayoutShape 会自己回落，这一层不重复判断。
function createLayoutFromGroupConfig(groupId) {
    const id = normalizeGroupId(groupId);
    const snapshot = groupLayoutSnapshots.get(id);
    if (!snapshot || !Array.isArray(snapshot.panes) || !snapshot.panes.length) return null;

    const split = snapshot.paneSplit && typeof snapshot.paneSplit === 'object' ? snapshot.paneSplit : {};
    return normalizeLayoutShape({
        splitEnabled: split.enabled === true,
        orientation: split.orientation,
        activePaneId: split.activePaneId,
        paneSizes: split.sizes,
        panes: snapshot.panes
    }, { mainTabId: mainTabId(id) });
}

// 保存指定组；顶层 workspaceLayout 仅保留默认组兼容镜像。
// panes / paneSplit 同步供配置归一化与恢复读取，回调必须传入其所属组。
function persistGroupWorkspaceLayout(groupId = activeGroupId) {
    if (!currentConfig) return;
    if (isApplyingConfig || isRestoringWorkspaceSession) return;
    if (workspaceModel) { scheduleWorkspaceLayoutSave(); return; }
    const id = normalizeGroupId(groupId);
    const payload = cloneWorkspaceLayout(getGroupWorkspaceLayout(id));
    const target = serialGroups.find(group => group && group.id === id);
    if (target) {
        target.workspaceLayout = payload;
        target.panes = payload.panes.map(pane => ({
            id: pane.id,
            tabIds: [...pane.tabIds],
            activeTabId: pane.activeTabId
        }));
        target.paneSplit = {
            enabled: payload.splitEnabled === true,
            orientation: payload.orientation,
            sizes: { ...payload.paneSizes },
            activePaneId: payload.activePaneId
        };
        target.focusedTabId = payload.panes
            .find(pane => pane.id === payload.activePaneId && pane.activeTabId)?.activeTabId
            || payload.panes.find(pane => pane.activeTabId)?.activeTabId
            || target.focusedTabId
            || null;
        // 快照同步回写：否则本轮之后若有人清掉 groupWorkspaceLayouts（例如关分组）
        // 再重建，就会读到上一次保存时的旧布局。
        groupLayoutSnapshots.set(id, {
            panes: target.panes,
            paneSplit: target.paneSplit
        });
    }
    if (id === REGISTRY_DEFAULT_GROUP_ID) {
        currentConfig.workspaceLayout = payload;
    }
    ipcRenderer.send('save-config', {
        serialGroups,
        ...(id === REGISTRY_DEFAULT_GROUP_ID ? { workspaceLayout: payload } : {})
    });
}

// 当前分组的简写：保留原调用点与签名不变。
function persistWorkspaceLayout() {
    persistGroupWorkspaceLayout(activeGroupId);
}

// manager 的读写和回调绑定创建时的组，不依赖之后切换的控制组。
function createGroupWorkspaceManager(groupId) {
    const id = normalizeGroupId(groupId);
    const options = {
        getLayout: () => getGroupWorkspaceLayout(id),
        setLayout: (nextLayout) => {
            groupWorkspaceLayouts.set(id, nextLayout);
            if (id === activeGroupId) workspaceLayout = nextLayout;
        },
        cloneLayout: (layout) => cloneWorkspaceLayout(layout || createDefaultLayoutForGroup(id)),
        normalizeLayout: (layout) => normalizeLayoutShape(layout, { mainTabId: mainTabId(id) }),
        persistLayout: () => persistGroupWorkspaceLayout(id),
        getPaneDom,
        getPaneTabsList,
        getPaneTabsContent,
        onTabActivated: ({ tabId, paneId }) => {
            window.dispatchEvent(new CustomEvent('main-tab-changed', { detail: { tabId, paneId } }));
        },
        onTabMoved: ({ tabId, targetPaneId }) => {
            const filterTab = filterTabsStore.getList(id).find(tab => tab.id === tabId);
            if (filterTab) {
                filterTab.paneId = targetPaneId;
                persistFilterTabs({ groupId: id });
                return;
            }
            const shellTab = getShellTabState(tabId);
            if (shellTab) {
                shellTab.paneId = targetPaneId;
                persistShellTabs();
                return;
            }
            const chartTab = chartTabsStore.getList(id).find(tab => tab.id === tabId);
            if (chartTab) {
                chartTab.paneId = targetPaneId;
                persistChartTabs(id);
            }
        },
        // 新建的第 3 个及以后 pane 必须挂在**本分组的 root** 下，
        // 否则多分组的 pane 会全部跑进默认分组的工作区。
        ensurePaneElement: (paneId) => createPaneElement(paneId, groupWorkspaceRootId(id)),
        fitWorkspace: fitWorkspaceTerminals,
        // 布局发生变化（增删标签 / 切激活 / 改分屏 / 改比例）时请求一次渲染。
        // 这是布局层与渲染层之间**唯一**的接口：它只报「模型变了」，不告诉渲染层怎么画。
        onLayoutChanged: () => {
            renderWorkspaceNow();
        }
    };
    return workspaceModel
        ? createWorkspaceModelManager({ ...options, groupId: id, getWorkspace: () => workspaceModel,
            dispatch: dispatchWorkspaceAction, describeTab: describeWorkspaceBusinessTab })
        : createWorkspaceManager(options);
}

// 拿到某个分组的布局管理器（惰性创建）。
function getGroupWorkspaceManager(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = normalizeGroupId(groupId);
    let manager = groupWorkspaceManagers.get(id);
    if (!manager) {
        manager = createGroupWorkspaceManager(id);
        groupWorkspaceManagers.set(id, manager);
    }
    return manager;
}

// 把模块级别名切到目标分组。
//
// **必须早于任何布局读写**：`workspaceManager.xxx` 与 `workspaceLayout` 的 60 余处
// 消费点读的都是这两个别名，切晚了就会把上一个分组的布局当成当前分组的。
function setActiveGroupWorkspace(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = normalizeGroupId(groupId);
    workspaceManager = getGroupWorkspaceManager(id);
    workspaceLayout = getGroupWorkspaceLayout(id);
    return { workspaceManager, workspaceLayout };
}

// 启动时就把默认分组那一套建好：renderer 顶层有大量在模块加载期就要读布局的表达式。
setActiveGroupWorkspace(REGISTRY_DEFAULT_GROUP_ID);

let workspaceFitFrame = null;

function fitWorkspaceTerminals() {
    if (workspaceFitFrame !== null) return;
    workspaceFitFrame = requestAnimationFrame(() => {
        workspaceFitFrame = null;
        // 显示计划已挂载面板；fit 还需检查祖先可见性与真实尺寸，避免隐藏面板算出零列。
        const isPanelShown = tabId => {
            const el = document.getElementById(tabId);
            if (!el || !el.classList.contains('active')) return false;
            if (el.offsetParent === null) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };

        // 串口终端：**逐个分组** fit 自己的 fitAddon。
        //
        // 之前只调 serialFitAddon（默认分组）而且不看可见性，非默认分组的串口主终端
        // 从建出来之后就没被 fit 过。实测分组级左右分屏后两列面板都是 396 px，但
        // default term=49 cols、g-1 term=80 cols；手动再调一次 fit 仍 49/80（diag914）。
        // 隐藏的面板不 fit：fit() 会把 cols/rows 算成 0（display:none 下尺寸为 0）并
        // 写坏缓冲区布局，切回可见时又得重算一次。
        serialGroups.forEach(group => {
            const runtime = serialRuntimes.get(group.id);
            if (!runtime || !runtime.fitAddon) return;
            if (!isPanelShown(mainTabId(group.id))) return;
            runtime.fitAddon.fit();
        });

        // 过滤页 / 图表页：store 是**按分组**的，不能用模块级 filterTabs 别名
        // （它只指向激活分组，其它分组的过滤页永远不会被 fit）。
        serialGroups.forEach(group => {
            filterTabsStore.getList(group.id).forEach(tab => {
                if (!isPanelShown(tab.id)) return;
                tab.fitAddon.fit();
            });
            chartTabsStore.getList(group.id).forEach(tab => {
                if (isPanelShown(tab.id)) tab.view?.resize();
            });
        });

        shellTabs.forEach(tab => {
            if (!isPanelShown(tab.id)) return;
            tab.fitAddon.fit();
            const sizeChanged = tab.lastFitCols !== tab.term.cols || tab.lastFitRows !== tab.term.rows;
            if (!isDraggingWorkspaceSplitter && sizeChanged) {
                // 只记录已发给 PTY 的尺寸，拖动中的 fit 不能吞掉松手后的最终通知。
                tab.lastFitCols = tab.term.cols;
                tab.lastFitRows = tab.term.rows;
                ipcRenderer.send('resize-shell-tab', { tabId: tab.id, cols: tab.term.cols, rows: tab.term.rows });
            }
        });
    });
}

function getPaneById(paneId) {
    return getGroupWorkspaceManager(groupIdFromPaneId(paneId) || activeGroupId).getPaneById(paneId);
}

function isSplitEnabled() {
    return workspaceManager.isSplitEnabled();
}

function getOrientation() {
    return workspaceManager.getOrientation();
}

function normalizeWorkspaceLayout(layout) {
    return workspaceManager.normalizeWorkspaceLayout(layout);
}

function getActivePane() {
    return getGroupWorkspaceManager(activeGroupId).getActivePane();
}

// 当前控制组查询显式按 activeGroupId 取 manager，避免模块别名时序影响。
function getActiveTabId(fallbackTabId = 'tab-main') {
    return getGroupWorkspaceManager(activeGroupId).getActiveTabId(fallbackTabId);
}

function getActiveTabInfo(fallbackTabId = 'tab-main') {
    return getGroupWorkspaceManager(activeGroupId).getActiveTabInfo(fallbackTabId);
}

// 取指定分组自己的激活标签。侧栏的「清空当前终端」「保存当前标签」
// 「搜索目标」必须走这个：用别名会让侧栏操作固定作用于别名指向的分组，
// 而用户在界面上看到的是激活分组——两者不一致时按钮就「点错了串口」。
function getGroupActiveTabId(groupId = REGISTRY_DEFAULT_GROUP_ID, fallbackTabId = 'tab-main') {
    return getGroupWorkspaceManager(groupId).getActiveTabId(fallbackTabId);
}

function getGroupActiveTabInfo(groupId = REGISTRY_DEFAULT_GROUP_ID, fallbackTabId = 'tab-main') {
    return getGroupWorkspaceManager(groupId).getActiveTabInfo(fallbackTabId);
}

function resolvePaneId(paneId, tabId, fallbackTabId = 'tab-main') {
    const id = groupIdFromPaneId(paneId) || groupIdForWorkspaceTab(tabId) || activeGroupId;
    return getGroupWorkspaceManager(id).resolvePaneId(paneId, tabId, fallbackTabId);
}

function getOtherPaneId(paneId) {
    return getGroupWorkspaceManager(groupIdFromPaneId(paneId) || activeGroupId).getOtherPaneId(paneId);
}

function getTabPaneId(tabId, fallbackPaneId = 'pane-1') {
    if (workspaceModel) {
        const hit = tabModel.paneOfTab(workspaceModel, workspaceModel.tabs[tabId]);
        return hit?.pane.id || fallbackPaneId;
    }
    const shell = isShellTabId(tabId) ? getShellTabState(tabId) : null;
    if (shell?.hostPaneId && groupIdFromPaneId(shell.hostPaneId)) return shell.hostPaneId;
    return getGroupWorkspaceManager(groupIdForWorkspaceTab(tabId) || activeGroupId).getTabPaneId(tabId, fallbackPaneId);
}

function isTabActive(tabId) {
    return workspaceManager.isTabActive(tabId);
}

function getPaneIdForTabId(tabId) {
    return getTabPaneId(tabId);
}


function ensurePaneActiveTab(paneId) {
    return workspaceManager.ensurePaneActiveTab(paneId);
}

function setActivePane(paneId, options = {}) {
    return workspaceManager.setActivePane(paneId, options);
}

// 切换标签的唯一入口：写焦点，然后由 renderWorkspace 重新收敛。
// 不再有「先遮住上层 Shell 再切」这种两步操作：显隐只由 plan.panelIds 写一次。
//
// **必须同时写焦点**：布局层的 switchPaneTab 只写 panes[].activeTabId，而模型的
// visiblePanelIdsOfColumn 在未分屏形态下跟的是 focusedTabId。只写前者会出现
// 「pane 的 activeTabId 变了、屏幕还是旧那一页」——新建 Shell / 新建过滤页都踩过这个坑。
//
// **必须按标签所属分组写布局**，不能用模块级别名：
// 模块级 `workspaceManager` 指向的是**当前激活分组**，而分组级分屏后每个可见列各是一个
// 分组，用户点的那一列往往不是激活分组。用别名写会落到错的布局里，而 `focusedWorkspaceTabId`
// 又是对的，于是模型算出的 `panelIds` 只看焦点对得上哪一列的面板——
// 结果就是「焦点已经变了、那一列还是显示旧标签」（实测 diag1141：
// 焦点 `tab-filter-1`、默认列 `activeTabId` 仍是 `tab-main`、DOM 面板仍只有 `tab-main`）。
//
// 所以这里先把 paneId 反解成它的归属分组，拿到那个分组的 manager 再写；
// 反解不出来（合成 pane、未知 id）时才回落到别名。
function resolveWorkspaceManagerForPane(paneId) {
    const groupId = groupIdFromPaneId(paneId);
    if (groupId && serialGroups.some(group => group.id === groupId)) {
        return getGroupWorkspaceManager(groupId);
    }
    return getGroupWorkspaceManager(activeGroupId);
}

function switchPaneTab(paneId, tabId, options = {}) {
    if (workspaceModel) return dispatchWorkspaceAction({ type: 'activate', tabId }).ok;
    const targetManager = resolveWorkspaceManagerForPane(paneId);
    const switched = targetManager.switchPaneTab(paneId, tabId, options);
    if (tabId && !workspaceModel) focusedWorkspaceTabId = tabId;
    renderWorkspaceNow();
    return switched;
}


window.__switchWorkspaceTab = switchPaneTab;

// 仅供 CDP 验证脚本调用。
//
// 原生右键菜单由主进程弹出，CDP 点不到菜单项，只能绕过菜单直接驱动同一条动作处理函数。
// 它走的就是 ipcRenderer.on('terminal-context-menu-action') 的回调本身，
// 所以验证到的是真实代码路径，而不是另写一套仅供测试的分支。
window.__handleContextMenuAction = handleTerminalContextMenuAction;

// Test hooks dispatch the same target-based transaction as menus and drag/drop.
window.__moveWorkspaceTab = (tabId, nodeId, index) => dispatchWorkspaceAction({
    type: 'move', tabId, target: { nodeId, index }
});

// 以下三个也只供 CDP 验证脚本使用。
//
// 侧栏按钮的验证难点在于：没有真实串口连接时无法让终端产生内容，而「清空」
// 按钮的效果只能通过「内容还在不在」来判定。因此提供一个写哨兵/读哨兵的
// 最小钩子，以及两个直接读侧栏所依赖数据的只读入口——它们与按钮内部调用的
// 是同一个函数（getActiveSearchTarget / getActiveTerminalExport），不是另写的副本。
// 注意：必须用 getOrCreate 而不是 getSerialTerm。
// getSerialRuntime 在分组运行时尚未创建时会**回落到默认分组**，
// 那样「写 g-1 的哨兵」会实际写进默认分组的终端，验证就变成恒真。
window.__seedGroupSentinel = () => {
    try {
        const seed = (groupId, text) => {
            const runtime = serialRuntimes.getOrCreate(resolveSerialGroupId(groupId));
            runtime?.term?.write(`${text}\r\n`);
            return Boolean(runtime?.term);
        };
        const okDefault = seed(REGISTRY_DEFAULT_GROUP_ID, 'SENTINEL_DEFAULT');
        const okG1 = seed('g-1', 'SENTINEL_G1');
        return { ok: okDefault && okG1, okDefault, okG1 };
    } catch (error) {
        return { ok: false, reason: String(error && error.message || error) };
    }
};

window.__readGroupSentinels = () => {
    const readTerm = groupId => {
        try {
            // 读也走 get()，不能走 getSerialTerm 的回落分支。
            const runtime = serialRuntimes.get(resolveSerialGroupId(groupId));
            const term = runtime?.term;
            if (!term) return '';
            const buffer = term.buffer.active;
            let text = '';
            for (let i = 0; i < buffer.length; i += 1) {
                const line = buffer.getLine(i);
                if (line) text += line.translateToString(true) + '\n';
            }
            return text;
        } catch {
            return '';
        }
    };
    return { default: readTerm(REGISTRY_DEFAULT_GROUP_ID), g1: readTerm('g-1') };
};

window.__getActiveSearchTarget = getActiveSearchTarget;
window.__getActiveTerminalExport = getActiveTerminalExport;

function ensurePaneTabMembership(paneId, tabId) {
    return workspaceManager.ensurePaneTabMembership(paneId, tabId);
}

function applyWorkspaceLayoutToDom() {
    return workspaceManager.applyLayoutToDom();
}

function enableSplit(orientation) {
    return workspaceManager.enableSplit(orientation);
}

function moveTabToPane(tabId, targetPaneId, options = {}) {
    return moveTabToGroupPane(tabId, targetPaneId, groupIdFromPaneId(targetPaneId), options);
}

let workspaceTabDragState = null;

// Drop targets are existing, visible tree Stacks at either row level.
function getWorkspaceTabDropTarget(clientX, clientY) {
    if (!workspaceModel) return null;
    return Array.from(document.querySelectorAll('.layout-stack > .pane-tabs-header > .pane-tabs-list')).map(list => ({
        list, paneId: list.dataset.layoutNodeId, groupId: groupIdFromPaneId(list.dataset.layoutNodeId)
    })).find(({ list }) => {
        if (!list.getClientRects().length) return false;
        const rect = list.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top - 6 && clientY <= rect.bottom + 6;
    }) || null;
}

function updateWorkspaceTabDrag(state, clientX, clientY) {
    if (!state.dragging || !workspaceModel) return;
    state.preview.style.left = `${clientX + 10}px`; state.preview.style.top = `${clientY + 10}px`;
    state.indicator.remove(); state.targetNodeId = null; state.insertionIndex = null;
    const target = getWorkspaceTabDropTarget(clientX, clientY);
    if (!target) return;
    const source = tabModel.locateTab(workspaceModel, state.tabId, state.tabButton.dataset.layoutItemId);
    if (!source) return;
    const rect = target.list.getBoundingClientRect(), edge = Math.min(36, rect.width / 4);
    if (clientX < rect.left + edge) target.list.scrollLeft -= Math.ceil((rect.left + edge - clientX) / 4);
    else if (clientX > rect.right - edge) target.list.scrollLeft += Math.ceil((clientX - (rect.right - edge)) / 4);
    const tabs = Array.from(target.list.querySelectorAll('.main-tab')).filter(button => button !== state.tabButton);
    const index = getHorizontalInsertionIndex(tabs.map(button => button.getBoundingClientRect()), clientX);
    const check = tabModel.applyWorkspaceAction(workspaceModel, { type: 'move', tabId: state.tabId,
        itemId: source.item.id, target: { nodeId: target.paneId, index } });
    if (!check.ok) return;
    target.list.insertBefore(state.indicator, tabs[index] || null);
    state.targetNodeId = target.paneId; state.insertionIndex = index;
}

function startWorkspaceTabDrag(state) {
    state.dragging = true;
    state.tabButton.classList.add('workspace-tab-dragging');
    const preview = state.tabButton.cloneNode(true);
    preview.classList.remove('active', 'workspace-tab-dragging');
    preview.classList.add('workspace-tab-drag-preview');
    preview.setAttribute('aria-hidden', 'true');
    preview.querySelectorAll('button, [tabindex]').forEach(element => { element.tabIndex = -1; });
    preview.style.width = `${state.tabButton.getBoundingClientRect().width}px`;
    document.body.appendChild(preview);
    state.preview = preview;
    state.indicator = document.createElement('span');
    state.indicator.className = 'workspace-tab-drop-indicator';
    state.indicator.setAttribute('aria-hidden', 'true');
    updateWorkspaceTabDrag(state, state.lastX, state.lastY);
}

function finishWorkspaceTabDrag(state) {
    state.preview?.remove();
    state.indicator?.remove();
    state.tabButton.classList.remove('workspace-tab-dragging');
    if (!state.dragging) return;
    if (workspaceModel) {
        const nodeId = state.targetNodeId;
        if (!nodeId || state.insertionIndex === null) return;
        const target = { nodeId, index: state.insertionIndex };
        const result = dispatchWorkspaceAction({ type: 'move', tabId: state.tabId, itemId: state.tabButton.dataset.layoutItemId, target });
        if (result.ok) {
            serialGroups.forEach(group => persistGroupWorkspaceLayout(group.id));
            persistShellTabs();
            state.tabButton.dataset.suppressClickUntil = String(performance.now() + 300);
        }
        return;
    }

}

// 跨分组移动标签必须走**目标分组自己的**布局管理器。
//
// 用模块级别名 `moveTabToPane` 会在当前激活分组的布局里找目标 pane：目标 pane 属于
// 另一个分组时，`getPaneById` 会回落成 pane-1，标签被“搬进了第一个 pane”而位置不变。
// 这个错误不报错、不警告，只表现为「拖到别的列里没反应」。
function moveTabToGroupPane(tabId, targetPaneId, targetGroupId, options = {}) {
    const groupId = targetGroupId || groupIdFromPaneId(targetPaneId);
    if (!groupId || groupIdFromPaneId(targetPaneId) !== groupId) return false;
    if (isMultiGroupLayer() && groupIdForWorkspaceTab(tabId) !== groupId) return false;
    return getGroupWorkspaceManager(groupId).moveTabToPane(tabId, targetPaneId, options);
}

function bindWorkspaceTabDragging() {
    // 事件委托到 document，用 `.pane-tabs-list` 限定范围。
    //
    // 为什么不在模块加载期逐 pane 绑定：非默认分组的 pane 是**后续动态创建**的，
    // 而且第 3 个及以后的 pane 也是现建的——写死 pane-1/pane-2 会让那些面板上的
    // 标签完全拖不动（没有任何报错，只是“拖了没反应”）。
    //
    // `.serial-group-tab-list` 不含 `pane-tabs-list` 类名，因此分组层标签不会被误绑。
    document.addEventListener('pointerdown', event => {
        const tabButton = event.target.closest?.('.main-tab');
        if (!tabButton) return;
        if (event.target.closest('.main-tab-close')) return;
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
        const list = tabButton.closest('.pane-tabs-list');
        // Shell 可以出现在三处：pane 标签行、某分组的上层行、独立列的列首行。
        // 后两处的容器都不带 pane-tabs-list 类名，所以只能按标签本身判定它是 Shell。
        // 串口分组标签（.serial-group-tab）不得从这里起拖：分屏由右键菜单决定。
        const isShell = isShellTabId(tabButton.dataset.target);
        const inGroupRow = Boolean(tabButton.closest('.group-tab-row'));
        if (!list && !(isShell && inGroupRow)) return;
        workspaceTabDragState = {
            pointerId: event.pointerId,
            tabId: tabButton.dataset.target || tabButton.dataset.groupId,
            tabButton,
            isShell,
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            dragging: false
        };
    });
    document.addEventListener('pointermove', event => {
        const state = workspaceTabDragState;
        if (!state || state.pointerId !== event.pointerId) return;
        state.lastX = event.clientX;
        state.lastY = event.clientY;
        if (!state.dragging && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) >= 6) {
            startWorkspaceTabDrag(state);
        }
        if (state.dragging) {
            event.preventDefault();
            updateWorkspaceTabDrag(state, event.clientX, event.clientY);
        }
    }, { passive: false });
    const finish = event => {
        const state = workspaceTabDragState;
        if (!state || state.pointerId !== event.pointerId) return;
        workspaceTabDragState = null;
        finishWorkspaceTabDrag(state);
    };
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    document.addEventListener('click', event => {
        const tabButton = event.target.closest?.('.main-tab');
        if (tabButton && performance.now() < Number(tabButton.dataset.suppressClickUntil || 0)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    // 双击主终端标签进入重命名。
    //
    // 必须走 document 级委托：主终端标签有两份来源——默认分组是 index.html 的
    // 静态标记，其余分组由 ensureSerialGroupMainTabDom() 动态创建。逐处绑定必然
    // 漏掉其中一份（历史上就是这样漏的：单串口模式下双击毫无反应）。
    //
    // 只匹配串口主标签（data-target 形如 tab-main / tab-main-<group>）：Shell、
    // 过滤、图表标签各自在构建函数里绑过 dblclick，这里再绑会弹出两个弹窗。
    document.addEventListener('dblclick', event => {
        const tabButton = event.target.closest?.('.main-tab');
        if (!tabButton) return;
        if (event.target.closest('.main-tab-close')) return;
        const tabId = tabButton.dataset.target || '';
        if (!tabId.startsWith('tab-main')) return;
        event.preventDefault();
        event.stopPropagation();
        const groupId = groupIdForWorkspaceTab(tabId) || activeGroupId;
        const group = getSerialGroupById(groupId);
        if (!group) return;
        openRenameTabDialog({
            groupId,
            title: group.followPort === true && group.portPath ? group.portPath : (group.title || '')
        });
    }, true);
}

bindWorkspaceTabDragging();

function collapseSplit() {
    return workspaceManager.collapseSplit();
}

function addTabToPane(tabId, paneId, options = {}) {
    return workspaceManager.addTabToPane(tabId, paneId, options);
}

// 把标签登记到 **paneId 所属的那个分组** 的布局里。
//
// 为什么不能直接用 addTabToPane（模块级别名）：创建标签时 `resolvedPaneId` 可能属于
// 非激活分组（例如 syncSerialGroupsFromConfig 逐组恢复、或新建分组后还没切别名），
// 而别名指向的是当前激活分组。走别名会把 tab-main-g-1 登记进默认分组的布局，
// 结果是 g-1 自己的标签行永远是空的，且两个「Main」挤在同一行。
//
// 运行态以树的实际区域/owner 为准；旧 pane 命名仅供初始化导入。
function addTabToOwningGroupPane(tabId, paneId, options = {}) {
    const id = resolveGroupIdFromPaneId(paneId);
    if (workspaceModel) {
        if (workspaceModel.tabs[tabId]) return tabModel.locateTab(workspaceModel, tabId)?.stack.id || null;
        const business = describeWorkspaceBusinessTab(tabId);
        if (!business) return null;
        const result = dispatchWorkspaceAction({ type: 'add-leaf', groupId: groupIdFromPaneId(paneId) || activeGroupId,
            paneId, options: business, activate: options.activate !== false });
        return result.ok ? tabModel.locateTab(workspaceModel, tabId)?.stack.id : null;
    }
    return getGroupWorkspaceManager(id).addTabToPane(tabId, paneId, options);
}

// 优先查实际布局成员，再精确匹配本组生成的 pane ID。
function resolveGroupIdFromPaneId(paneId) {
    return groupIdFromPaneId(paneId) || REGISTRY_DEFAULT_GROUP_ID;
}

function setPaneSizes(pane1Ratio, options = {}) {
    return workspaceManager.setPaneSizes(pane1Ratio, options);
}


function bindWorkspacePaneTransitionFit() {
    if (!workspaceRootEl) return;

    workspaceRootEl.addEventListener('transitionend', (event) => {
        if (event.propertyName !== 'flex-basis' || isDraggingWorkspaceSplitter) return;
        // pane 数可变，按类名判断而不是列举 pane-1 / pane-2。
        if (!event.target?.classList?.contains('workspace-pane')) return;
        fitWorkspaceTerminals();
    });

    sidebar?.addEventListener('transitionend', (event) => {
        if (event.target !== sidebar || event.propertyName !== 'width') return;
        fitWorkspaceTerminals();
    });
}

function removeTabFromWorkspace(tabId, options = {}) {
    return workspaceManager.removeTab(tabId, options);
}

function restoreWorkspaceLayout(layout, options = {}) {
    return workspaceManager.restoreLayout(layout, options);
}

function getNextTabId() {
    return nextFilterTabId++;
}

function syncNextFilterTabId(tabId) {
    const match = String(tabId || '').match(/^tab-filter-(\d+)$/);
    if (!match) return;
    const numericId = Number(match[1]);
    if (Number.isFinite(numericId) && numericId >= nextFilterTabId) {
        nextFilterTabId = numericId + 1;
    }
}

function getNextShellTabId() {
    return nextShellTabId++;
}

function syncNextShellTabId(tabId) {
    const match = String(tabId || '').match(/^tab-shell-(\d+)$/);
    if (!match) return;
    const numericId = Number(match[1]);
    if (Number.isFinite(numericId) && numericId >= nextShellTabId) {
        nextShellTabId = numericId + 1;
    }
}

// ---- 多串口分组：状态、标签栏、容器创建 -------------------------------------
//
// 这一层放在这里而不是文件顶部，是因为它要用到 getPaneTabsList / switchPaneTab /
// addTabToPane 等已经定义好的函数；放到上方会在模块加载时碰到 TDZ。

// 分组的权威列表。首版从配置的 serialGroups 初始化；空列表会回落到单个默认分组——
// 用户可能把分组全关了，但渲染层必须至少有一个终端可以显示。
let serialGroups = [];
let activeGroupId = REGISTRY_DEFAULT_GROUP_ID;
let isApplyingSessionGroups = false;

// 「当前是不是多分组（两层）形态」的**唯一入口**。
//
// 早先这个判断在 8 个地方各写一遍 `serialGroups.length > 1`（1341 / 2386 / 4226 /
// 4291 / 4419 / 4519 与 4730 / 4775 的 `<= 1`）。它决定四件互斥的事：分组标签行显不显示、
// 「添加串口」和「新建 Shell」按钮放哪一层、Shell 标签挂在哪一行。四处各自判断，
// 改一处漏三处就是「改了分组看不到按钮」这类缺陷的固定来源。
//
// 必须用 function 而不是 const：最早的调用点在 1341 行，那时本行还没执行；函数声明会提升。
function isMultiGroupLayer() {
    return serialGroups.length > 1;
}

function createDefaultSerialGroupState() {
    const options = currentConfig?.lastSerialOptions || {};
    // 兜底值从默认分组上下文读，而不是读那四个模块级 let：后者只是默认分组的缓存，
    // 一旦某个调用点让它们与上下文不同步，这里就会把陈旧值写进新分组的状态。
    const display = getGroupDisplay(REGISTRY_DEFAULT_GROUP_ID);
    return {
        id: REGISTRY_DEFAULT_GROUP_ID,
        title: typeof options.path === 'string' && options.path.trim() ? options.path.trim() : 'Serial 1',
        portPath: typeof options.path === 'string' ? options.path.trim() : '',
        status: 'disconnected',
        sessionId: null,
        serialOptions: {
            baudRate: options.baudRate || '115200',
            dataBits: String(options.dataBits || '8'),
            stopBits: String(options.stopBits || '1'),
            parity: options.parity || 'none',
            receiveDisplayMode: options.receiveDisplayMode || display.receiveDisplayMode,
            receiveEncoding: options.receiveEncoding || display.receiveEncoding,
            sendEncoding: options.sendEncoding || display.sendEncoding,
            newlineMode: options.newlineMode || display.newlineMode
        },
        filterTabs: [],
        chartTabs: [],
        workspaceLayout: null
    };
}

function normalizeSerialGroupState(groups) {
    const list = Array.isArray(groups) ? groups.filter(item => item && typeof item === 'object') : [];
    const seen = new Set();
    const normalized = [];
    list.forEach((group, index) => {
        const id = typeof group.id === 'string' && group.id.trim() ? group.id.trim() : '';
        if (!id || seen.has(id)) return;
        seen.add(id);
        // uiPrefs 是**可选**字段：只有 per-group 作用域下用户动过某个分组的显示开关才会有。
        // 缺省时不补 ——— 补齐会让「组内没存过」与「组内显式存成默认值」变成同一件事，
        // 而前者应当继续继承全局值。
        const uiPrefs = group.uiPrefs && typeof group.uiPrefs === 'object' && !Array.isArray(group.uiPrefs)
            ? normalizeDisplayPrefs(group.uiPrefs)
            : null;
        normalized.push({
            ...group,
            id,
            title: typeof group.title === 'string' && group.title.trim() ? group.title.trim() : `Serial ${index + 1}`,
            status: typeof group.status === 'string' ? group.status : 'disconnected',
            ...(uiPrefs ? { uiPrefs } : {})
        });
    });
    if (!normalized.length) normalized.push(createDefaultSerialGroupState());
    return normalized;
}

// 把配置里每个分组自己的过滤页/图表页恢复进各自的桶。
//
// 为什么必须在这里做：applyConfig 上面那段只恢复默认分组（全局 config.filterTabs），
// 其余分组的标签存在各自的 serialGroups[].filterTabs / .chartTabs 里。而 createFilterTab /
// createChartTab 末尾是把标签 push 进**模块级别名**（当前激活分组那份数组），所以循环内
// 必须先 setActiveGroupTabLists 切到该分组，否则所有分组的标签都会挤进同一个桶。
//
// 调用点的要求（比函数本身更容易写错）：必须在本函数所在函数体里、ensureSerialGroupMainTabDom
// 逐个建完容器之后才能调，因为 createFilterTab 需要该分组的 pane 容器真实存在。
function restorePerGroupTabsFromConfig(config) {
    const groups = Array.isArray(config?.serialGroups) ? config.serialGroups : [];
    const savedFlag = isRestoringWorkspaceSession;
    const savedPaneId = activeGroupId;
    isRestoringWorkspaceSession = true;
    try {
        groups.forEach(group => {
            const id = resolveSerialGroupId(group && group.id);
            // 默认分组已被 applyConfig 那段全局 config.filterTabs 逻辑恢复过；
            // 这里用 count() 兜底，否则会出现两套一模一样的过滤页。
            const filterConfigs = Array.isArray(group?.filterTabs) ? group.filterTabs : [];
            const chartConfigs = Array.isArray(group?.chartTabs) ? group.chartTabs : [];
            if (!filterConfigs.length && !chartConfigs.length) return;
            if (filterTabsStore.count(id) > 0 && chartTabsStore.count(id) > 0) return;
            setActiveGroupTabLists(id);
            // 标签必须建在**本分组的** pane-1 里。以前传字面量 'pane-1'，
            // 于是所有分组的过滤页/图表页都挤进默认分组那一套容器。
            const groupPane = groupPaneId(id, 1);
            if (filterTabsStore.count(id) === 0) {
                filterConfigs.forEach(tabConfig => createFilterTab(tabConfig, groupPane));
            }
            if (chartTabsStore.count(id) === 0) {
                chartConfigs.forEach(tabConfig => createChartTab(tabConfig, groupPane));
            }
        });
    } finally {
        setActiveGroupTabLists(savedPaneId);
        isRestoringWorkspaceSession = savedFlag;
    }
}

// 为一个非默认分组建列容器 `#serial-group-workspace-<g>`，内含自己的分组标签行
// `#serial-group-tab-bar-<g>`、`#workspace-root-<g>`、`#workspace-splitter-<g>` 与 `#pane-1-<g>`。
//
// 默认分组**不建**：它对应 index.html 里静态的 `#serial-group-workspace-default`，
// 内部 `#workspace-root` 及其全部后代 id 逐字不变。这条不是省事，而是启动时序要求——
// `#serial-container` 在静态 `pane-1` 内，而默认分组的 xterm 在模块加载期就 open() 了它。
//
// 幂等：已存在就直接返回。
function resolveWorkspaceColumnId(columnId) {
    return workspaceModel && tabModel.tree.find(workspaceModel.layout.root, columnId)
        ? columnId : resolveSerialGroupId(columnId);
}

function ensureSerialGroupWorkspaceDom(groupId) {
    const id = resolveWorkspaceColumnId(groupId);
    if (id === REGISTRY_DEFAULT_GROUP_ID) {
        return document.getElementById(groupWorkspaceEntryId(id));
    }
    const containerId = groupWorkspaceContainerId(id);
    const existing = document.getElementById(containerId);
    if (existing) return existing;
    const outer = document.getElementById(GROUP_WORKSPACE_CONTAINER_ID);
    if (!outer) return null;

    const container = document.createElement('div');
    // 列容器同时带 serial-group-workspace 与 group-column 两个类：
    // 前者管「占满可用空间」，后者管「纵向排列：标签行 → 工作区」。
    container.className = 'serial-group-workspace group-column';
    container.id = containerId;
    container.dataset.groupId = id;

    // 列首的分组标签行。必须先于 .workspace-root 插入，且后续永不被重排走。
    container.appendChild(createGroupTabRowElement(id));

    // 每个分组首版只建 1 个 pane（不分屏）；后续分屏由布局层的 ensurePaneElement 追加。
    const workspace = describeGroupWorkspace(id, { paneCount: 1 });
    const rootEl = document.createElement('div');
    rootEl.className = 'workspace-root';
    rootEl.id = workspace.rootId;
    rootEl.dataset.groupId = id;

    workspace.panes.forEach(entry => {
        rootEl.appendChild(getPaneDom(entry.paneId) || createGroupPaneElement(id, entry.paneId));
    });

    const splitter = document.createElement('div');
    splitter.className = 'workspace-splitter';
    splitter.id = workspace.splitterId;
    splitter.hidden = true;
    splitter.dataset.groupSplitter = 'pane';
    splitter.dataset.groupId = id;

    container.appendChild(rootEl);
    container.appendChild(splitter);

    // 插在默认分组之后、外层分界条之前，保证「默认分组在左、新分组往右排」。
    const outerSplitter = document.getElementById(GROUP_WORKSPACE_SPLITTER_ID);
    if (outerSplitter && outerSplitter.parentNode === outer) {
        outer.insertBefore(container, outerSplitter);
    } else {
        outer.appendChild(container);
    }
    return container;
}


// 造一个非默认分组的分组标签行（含标签列表与「添加串口」占位）。
//
// 「添加串口」按钮**不在**每列各造一个：它只保留静态那一个，由
// placeGroupAddButton() 移到当前激活列。多列各一个会让用户同时看到好几个同样的按钮。
function createGroupTabRowElement(groupId) {
    const id = resolveWorkspaceColumnId(groupId);
    const row = document.createElement('div');
    row.className = 'group-tab-row serial-group-tab-bar';
    row.id = groupTabRowId(id);
    row.hidden = true;

    const list = document.createElement('div');
    list.className = 'main-tabs-list serial-group-tab-list';
    list.id = groupTabListId(id);
    list.setAttribute('role', 'tablist');
    row.appendChild(list);
    // 动态列的行与静态行一样走事件委托（同一个挂载点存在时才挂）。
    bindGroupTabListEvents(list);
    return row;
}

// 取（必要时建）某个分组的分组标签行。默认分组走静态标记，永不重建。
function getGroupTabRow(groupId) {
    const id = resolveWorkspaceColumnId(groupId);
    const rowId = groupTabRowId(id);
    const existing = document.getElementById(rowId);
    if (existing) return existing;
    if (id === REGISTRY_DEFAULT_GROUP_ID) return null;
    const column = document.getElementById(groupWorkspaceEntryId(id));
    if (!column) return null;
    // 列首没有标签行时补一个（历史数据或手工改造过的 DOM）。
    const created = createGroupTabRowElement(id);
    column.insertBefore(created, column.firstChild);
    return created;
}

// 取某个分组的分组标签列表容器。
function getGroupTabList(groupId) {
    const id = resolveWorkspaceColumnId(groupId);
    return document.getElementById(groupTabListId(id));
}

// 把静态分组标签行搬回默认分组列首。
//
// 关闭非默认分组时必须先调一次：静态行可能正被 borrow 在那个即将删除的列里，
// 跟着容器一起 remove 掉之后，分组栏就永久消失且没有任何报错。
function reclaimSharedGroupTabRow() {
    const home = document.getElementById(groupWorkspaceEntryId(REGISTRY_DEFAULT_GROUP_ID));
    const row = document.getElementById(GROUP_TAB_BAR_ID);
    if (!home || !row) return;
    if (row.parentElement === home) return;
    home.insertBefore(row, home.firstChild);
}

// 把静态「添加串口」按钮从即将删除的列里抢回来。
//
// 按钮住在某个列的标签行里（见 placeGroupAddButton），而列会被 remove。
// 不抢回来就跟着一起消失，而且没有任何报错——分组栏上的「添加串口」再不出现。
// 抢回来先丢到静态行里，之后 placeGroupAddButton 会把它放到正确位置。
function reclaimGroupAddButton() {
    if (!addSerialGroupBtn) return;
    const home = document.getElementById(GROUP_TAB_BAR_ID);
    if (!home || home.contains(addSerialGroupBtn)) return;
    let actions = home.querySelector('.serial-group-tab-actions');
    if (!actions) {
        actions = document.createElement('div');
        actions.className = 'serial-group-tab-actions';
        home.appendChild(actions);
    }
    actions.appendChild(addSerialGroupBtn);
}

// 把新建 Shell 按钮从即将删除的列里抢回到静态行。与 reclaimGroupAddButton 同一理由。
function reclaimShellAddButton() {
    if (!addShellTabBtn) return;
    const home = document.getElementById(GROUP_TAB_BAR_ID);
    if (!home || home.contains(addShellTabBtn)) return;
    let actions = home.querySelector('.serial-group-tab-actions');
    if (!actions) {
        actions = document.createElement('div');
        actions.className = 'serial-group-tab-actions';
        home.appendChild(actions);
    }
    actions.insertBefore(addShellTabBtn, actions.firstChild);
}

// 「添加串口」按钮只能出现在**当前真正可见**的那一条分组标签行里。
//
// 早期这里用 getGroupTabRow(activeGroupId)，把按钮放进了分组**自己**那条行。
// 但未分屏时屏幕上可见的是那条被借来的静态行，非默认分组自己的行是 hidden 的——
// 于是切到第二个分组后两个入口都不可见，用户报为
// 「新建串口分组选到第二个分组发现没有新建串口按钮」。
//
// 判定必须跟着「可见行」走：未分屏 → 静态共享行；已分屏 → 激活列自己的行。
function placeGroupAddButton() {
    if (!addSerialGroupBtn) return;
    const hostRow = getVisibleGroupRow(activeGroupId);
    if (!hostRow) return;
    let actions = hostRow.querySelector('.serial-group-tab-actions');
    if (!actions) {
        actions = document.createElement('div');
        actions.className = 'serial-group-tab-actions';
        hostRow.appendChild(actions);
    }
    if (addSerialGroupBtn.parentElement !== actions) {
        actions.appendChild(addSerialGroupBtn);
    }
}

// 造一个分组自己的 pane 节点（含标签行、操作按钮与内容区）。
//
// 与 createPaneElement 的区别：这个从零建，因为非默认分组的 pane-1 没有静态标记。
// 两者的 DOM 结构必须一致，否则布局层按 id 找容器时会差别对待。
function createGroupPaneElement(groupId, paneId) {
    const id = resolveSerialGroupId(groupId);
    const paneEl = document.createElement('div');
    paneEl.className = 'workspace-pane active';
    paneEl.id = paneId;
    paneEl.dataset.paneId = paneId;

    const header = document.createElement('div');
    header.className = 'main-tabs-header pane-tabs-header';
    const tabsList = document.createElement('div');
    tabsList.className = 'main-tabs-list pane-tabs-list';
    tabsList.id = `${paneId}-tabs-list`;
    tabsList.setAttribute('role', 'tablist');
    // 二级栏的动作按钮组同样只走 createPaneActionButtons（唯一构造路径）。
    const actions = document.createElement('div');
    actions.className = 'pane-tab-actions';
    actions.append(...createPaneActionButtons(paneId));
    header.appendChild(tabsList);
    header.appendChild(actions);
    // 非默认分组列里的主/过滤/图表标签也在这个列表里，右键分屏菜单同样要能用。
    // createPaneElement 与 createGroupPaneElement 是两套并行的 pane 构造器，
    // 两处都必须挂，漏一处就是「有些标签右键没反应」。
    bindPaneTabListEvents(tabsList);

    const content = document.createElement('div');
    content.className = 'main-tabs-content pane-tabs-content';
    content.id = `${paneId}-tabs-content`;

    paneEl.appendChild(header);
    paneEl.appendChild(content);
    return paneEl;
}

function syncGroupWorkspaceVisibility() {
    renderWorkspaceNow();
}

// 从配置里同步分组列表。只在首次加载与外部 config-updated 时调用。
//
// 关键：注册表必须对每个分组 ensureGroup，否则 serial-output-bytes 会以
// unknown-group 把这些分组的全部字节静默丢弃。
function syncSerialGroupsFromConfig(config) {
    const next = normalizeSerialGroupState(config?.serialGroups);
    // 兼容旧配置：followPort 缺失表示「未被用户明确设置」，按默认开启处理。
    next.forEach(group => { if (group && group.followPort !== false) group.followPort = true; });
    if (workspaceModel) {
        // 设置保存的回声只更新业务设置，不能重建或覆盖交互后的布局和成员。
        serialGroups = serialGroups.map(existing => {
            const incoming = next.find(group => group.id === existing.id);
            const merged = incoming ? { ...existing, ...incoming } : existing;
            if (merged && merged.followPort !== false) merged.followPort = true;
            return merged;

        });
        return;
    }
    serialGroups = next;
    // 配置里的 panes / paneSplit 先全量换成新快照：分组可能被外部配置删掉，
    // 只增不删会让快照里留着已经不存在的分组。
    // 必须在下一段 getGroupWorkspaceLayout（经 ensureSerialGroupMainTabDom 间接触发）
    // 之前完成，否则建的还是上一轮那份旧布局。
    groupLayoutSnapshots.clear();
    next.forEach(group => {
        if (Array.isArray(group.panes) && group.panes.length) {
            groupLayoutSnapshots.set(group.id, {
                panes: group.panes,
                paneSplit: group.paneSplit
            });
        }
    });
    next.forEach(group => {
        serialGroupRegistry.ensureGroup(group.id, { portPath: group.portPath });
        serialGroupContext.ensureContext(group.id);
    });
    if (!next.some(group => group.id === activeGroupId)) {
        activeGroupId = next[0].id;
    }
    serialGroupRegistry.setActiveGroup(activeGroupId);
    // 先把每个分组的外层容器建好（默认分组用静态 root，不建）。
    // ensureSerialGroupMainTabDom 需要本分组的 pane 容器已存在才能挂主标签。
    next.forEach(group => {
        ensureSerialGroupWorkspaceDom(group.id);
        ensureSerialGroupMainTabDom(group.id, group.title);
    });
    // 每分组标签恢复必须排在外层容器与主标签都建完之后（容器已建）与
    // applyActiveSerialGroup 之前（别名即将被切到 activeGroupId）。
    restorePerGroupTabsFromConfig(config);
    renderSerialGroupTabBar();
    syncGroupWorkspaceVisibility();
    applyActiveSerialGroup({ fit: false });
}

// 为一个分组建主标签按钮 + 标签面板 + xterm 容器。
//
// 为什么不是在建分组时才建：配置里已经存在的分组（重启后）同样需要这些节点。
// 已存在则直接返回，保证反复调用无副作用。
function ensureSerialGroupMainTabDom(groupId, title) {
    const id = resolveSerialGroupId(groupId);
    const tabId = mainTabId(id);
    const buttonId = mainTabButtonId(id);
    const containerId = serialContainerId(id);
    if (document.getElementById(containerId)) return true;

    // 本分组自己的 pane-1。默认分组 → 'pane-1'，其它 → 'pane-1-<g>'。
    // 以前这里写死 'pane-1'，导致所有分组的主标签都塞进默认分组那一套 pane：
    // 两个分组时标签行里同时挂着两个「Main」。
    const paneId = groupPaneId(id, 1);
    const tabsList = getPaneTabsList(paneId);
    const tabsContent = getPaneTabsContent(paneId);
    if (!tabsList || !tabsContent) return false;

    // 1. 标签按钮。与 index.html 里的静态主标签保持同一结构（title + close）。
    //    默认分组已经有静态按钮，不会走到这里。
    if (!document.getElementById(buttonId)) {
        const button = document.createElement('button');
        button.className = 'main-tab';
        button.type = 'button';
        button.id = buttonId;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', 'false');
        button.setAttribute('aria-controls', tabId);
        button.dataset.target = tabId;
        button.dataset.paneId = paneId;
        const titleEl = document.createElement('span');
        titleEl.className = 'main-tab-title';
        titleEl.textContent = title || `Serial ${serialGroups.length}`;
        button.appendChild(titleEl);
        button.addEventListener('click', () => {
            switchPaneTab(paneId, tabId);
        });
        tabsList.appendChild(button);
    }

    // 2. 标签面板 + 终端容器。容器必须先存在，createSerialRuntime 才能 open()。
    const tabPane = document.createElement('div');
    tabPane.className = 'main-tab-pane';
    tabPane.id = tabId;
    tabPane.setAttribute('role', 'tabpanel');
    tabPane.setAttribute('aria-labelledby', buttonId);
    tabPane.dataset.paneId = paneId;
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.id = containerId;
    tabPane.appendChild(wrapper);
    tabsContent.appendChild(tabPane);

    // 右键菜单必须**逐分组**绑定。
    //
    // bindTerminalContextMenu 只在模块加载期对默认分组的 #serial-container 绑了一次；
    // 新分组的终端容器是后建的，不补这一步就会出现「默认分组能右键、新分组右键没反应」。
    //
    // term 用函数惰性取：此刻本分组的 xterm 实例还没创建（它由 createSerialRuntime
    // 在切换标签时建），直接传 getSerialTerm(id) 会拿到默认分组的 term，
    // 于是右键菜单里的选区/清屏全部作用于错的终端。
    bindTerminalContextMenu({
        terminalType: 'main',
        term: () => getSerialTerm(id),
        element: wrapper,
        getTabState: () => ({ id: tabId, paneId })
    });


    // 3. 把这一个主标签登记进**本分组的**布局，否则 switchPaneTab 会因 tabIds
    //    不含它而直接返回。
    //
    //    这里绝不能走模块级别名 addTabToPane：新建分组时 activeGroupId 还没切过去
    //    （或者在 syncSerialGroupsFromConfig 里就不是本组），那个别名指向默认分组的
    //    布局，于是 tab-main-g-1 被登记到默认分组，g-1 自己的标签行永远为空，
    //    表现为「两个「Main」挤在同一行、g-1 的终端切不过去」。
    //    persist:false —— 布局持久化由 persistWorkspaceLayout 统一负责。
    getGroupWorkspaceManager(id).addTabToPane(tabId, paneId, { activate: false, persist: false });
    return true;
}

function getSerialGroupById(groupId) {
    const id = resolveSerialGroupId(groupId);
    return serialGroups.find(group => group.id === id) || null;
}


// 把某个分组的串口参数回显到左侧设置面板。
//
// 这里全部走 document.getElementById 而不是模块级 const：这个函数会被
// applyActiveSerialGroup 调用，而它可能在模块加载早期就被 syncSerialGroupsFromConfig
// 触发，那时下方的 portSelect / baudSelect 等 const 还没初始化（TDZ）。
//
// 回显期间置 isApplyingSessionGroups：这些都是程序写入控件，不能被当成用户
// 修改而反过来触发 saveSerialModeConfig()——否则切一次分组就会把回显值当
// 新值再写回配置。
function applyGroupSerialOptionsToSidebar(groupId) {
    const group = getSerialGroupById(groupId);
    if (!group) return;
    const options = group.serialOptions || {};
    const display = getGroupDisplay(groupId);
    // 端口列表是异步刷新的。三种情形必须区分：
    //   列表还没建好（只有占位项）—— 保留当前值，否则启动时会清掉刚恢复的选择；
    //   目标端口在列表里 —— 选中它；
    //   列表已就绪但目标端口不在 —— 显式清空。
    // 第三种是用户报的那个缺陷：设备被拔掉后上一组的端口会留在屏幕上，
    // 让用户以为当前分组选的是那个端口。宁可空，不可错。
    const isPortListReady = () => {
        const el = document.getElementById('port-select');
        if (!el) return false;
        return Array.from(el.options).some(option => Boolean(option.value));
    };

    // 回显写入控件时不能反过来触发 saveSerialModeConfig：
    // 否则每切一次分组都会把「屏幕上刚回显的值」再当成用户改动写盘一次。
    const previousGuard = isApplyingSessionGroups;
    isApplyingSessionGroups = true;

    try {
        // 端口：目标在列表里就选中；列表已就绪但不包含目标时必须清空；
        // 列表尚未建好时保留当前值，避免启动阶段把刚恢复的选择误清。
        const portEl = document.getElementById('port-select');
        if (portEl) {
            const wanted = typeof group.portPath === 'string' ? group.portPath : '';
            const hasOption = Boolean(wanted)
                && Array.from(portEl.options).some(option => option.value === wanted);
            if (hasOption) {
                portEl.value = wanted;
            } else if (!wanted || isPortListReady()) {
                // wanted 为空：该分组本来就没选端口，不能把上一组的值留在屏幕上。
                portEl.value = '';
            }
        }

        // 波特率走自定义波特率机制：自定义值必须先有对应 option 才能选中。
        // 与端口不同，波特率**不能**清空——它总有值（回落 115200），
        // 清空反而会让 <select> 停在第一项，与分组实际参数不一致。
        const baudRate = normalizeBaudRate(options.baudRate) || '115200';
        if (typeof previousBaudRate !== 'undefined') previousBaudRate = baudRate;
        const baudEl = document.getElementById('baud-select');
        if (baudEl) {
            const hasOption = Array.from(baudEl.options).some(option => option.value === baudRate);
            if (hasOption) {
                baudEl.value = baudRate;
            } else {
                // 自定义波特率可能还没被渲染进列表：先补建选项再选中，
                // 否则 baudSelect 会静默保留上一组的波特率。
                renderCustomBaudRates([
                    ...normalizeCustomBaudRates(currentConfig?.customBaudRates),
                    baudRate
                ], baudRate);
            }
        }

        const dataBitsEl = document.getElementById('data-bits-select');
        if (dataBitsEl && options.dataBits) dataBitsEl.value = String(options.dataBits);
        const stopBitsEl = document.getElementById('stop-bits-select');
        if (stopBitsEl && options.stopBits) stopBitsEl.value = String(options.stopBits);
        const parityEl = document.getElementById('parity-select');
        if (parityEl && options.parity) parityEl.value = options.parity;
        const newlineEl = document.getElementById('newline-mode-select');
        if (newlineEl) newlineEl.value = display.newlineMode;

        const modeEl = document.getElementById('receive-mode-select');
        if (modeEl) modeEl.value = display.receiveDisplayMode;
        const receiveEncodingEl = document.getElementById('receive-encoding-select');
        if (receiveEncodingEl) {
            receiveEncodingEl.value = display.receiveEncoding;
            // HEX 显示模式下接收编码无意义，必须跟着置灰，否则用户以为改它能生效。
            receiveEncodingEl.disabled = display.receiveDisplayMode === 'hex';
        }
        const sendEncodingEl = document.getElementById('send-encoding-select');
        if (sendEncodingEl) sendEncodingEl.value = display.sendEncoding;
    } finally {
        isApplyingSessionGroups = previousGuard;
    }
}

// 连接按钮与状态提示跟随激活分组：多分组时按钮代表的是当前这一组，
// 不能总是显示默认分组的连接状态。
function refreshConnectButtonState() {
    const groupId = resolveSerialGroupId(activeGroupId);
    const connected = isGroupConnected(groupId);
    const busy = isGroupConnecting(groupId) || isGroupReconnecting(groupId);
    const label = document.getElementById('connect-btn-label');
    if (label) {
        const translationKey = connected ? 'main.disconnect' : 'main.connect';
        label.dataset.i18n = translationKey;
        label.textContent = tr(translationKey);
    }
    const button = document.getElementById('connect-btn');
    button?.classList.toggle('connect-action', !connected);
    button?.classList.toggle('disconnect-action', connected);
    if (button) button.disabled = busy;
    const sidebarButton = document.getElementById('sidebar-connect-btn');
    sidebarButton?.classList.toggle('connect-action', !connected);
    sidebarButton?.classList.toggle('disconnect-action', connected);
    if (sidebarButton) {
        sidebarButton.disabled = busy;
        sidebarButton.title = tr(connected ? 'main.disconnect' : 'main.connect');
        sidebarButton.setAttribute('aria-label', sidebarButton.title);
    }
}

// 连接过程中只禁用**本组**的按钮：另一个分组应该可以同时发起连接。
function setGroupConnectBusy(groupId, busy) {
    const id = resolveSerialGroupId(groupId);
    if (id !== resolveSerialGroupId(activeGroupId)) return;
    const disabled = busy === true;
    const button = document.getElementById('connect-btn');
    if (button) button.disabled = disabled;
    const sidebarButton = document.getElementById('sidebar-connect-btn');
    if (sidebarButton) sidebarButton.disabled = disabled;
}

// 分组标签的视觉状态：active 是「当前选中」，control 是「受控但焦点在 Shell」。
// 两者必须分开：activeGroupId 决定设置栏、发送与连接作用于哪个串口，而焦点可能停在
// 某个 Shell 上。此时分组标签仍是受控组，但用户当前看的是 Shell；若共用同一个 active
// 样式，两个标签会同时亮着，看不出究竟在操作谁。
function resolveGroupTabState(groupId) {
    const isActive = groupId === activeGroupId;
    const focusedIsShell = isShellTabId(workspaceModel?.focusedTabId || focusedWorkspaceTabId);
    return {
        active: isActive && !focusedIsShell,
        control: isActive && focusedIsShell
    };
}

function syncGroupTabVisualState(button) {
    const state = resolveGroupTabState(button.dataset.groupId);
    button.classList.toggle('active', state.active);
    button.classList.toggle('control', state.control);
    // 受控组仍是侧栏设置的作用对象，读屏应把它读成当前项。
    button.setAttribute('aria-selected', String(state.active || state.control));
}

function applyActiveSerialGroup({ fit = true, activateTab = true } = {}) {
    activeGroupId = resolveSerialGroupId(activeGroupId);
    serialGroupRegistry.setActiveGroup(activeGroupId);

    // 必须放在所有标签读写之前：把 `filterTabs` / `chartTabs` 这两个模块级别名
    // 指向本分组的数组。若晚于 switchPaneTab，切换到目标标签时读到的仍是上一个
    // 分组的列表，表现为「切了分组但过滤页数量没变」。
    setActiveGroupTabLists(activeGroupId);

    // 布局别名同理，而且必须早于 switchPaneTab：后者通过 workspaceManager 读 tabIds，
    // 晚切一步就会在上一个分组的布局里找这个主标签，直接返回不切。
    setActiveGroupWorkspace(activeGroupId);

    // 标签栏：active / control 与 aria-selected 必须同步，否则键盘/读屏看到的选中项
    // 与视觉不一致。焦点在 Shell 时分组改用 control 样式，避免两个标签同时高亮。
    if (!workspaceModel) document.querySelectorAll('.serial-group-tab').forEach(syncGroupTabVisualState);

    const groupManager = getGroupWorkspaceManager(activeGroupId);
    const targetTabId = workspaceModel ? groupManager.getActiveTabId(mainTabId(activeGroupId)) : mainTabId(activeGroupId);
    if (activateTab && document.getElementById(targetTabId)) {
        groupManager.switchPaneTab(groupManager.getPaneIdForTabId(targetTabId), targetTabId, { persist: false });
        if (!workspaceModel) focusedWorkspaceTabId = targetTabId;
    }
    // 外侧可见性：未分屏时只显示激活分组那一列（下层只有一套标签行）；
    // 已分屏时并排显示参与分屏的分组。关掉分组后旧容器必须一并隐藏，
    // 否则它仍占着 flex-basis，表现为「关了一个分组但剩下那个只有半宽」。
    // 一次性完成列 / 行 / 按钮 / 面板的收敛（含外层可见性、分组标签行归位、显隐）。
    renderSerialGroupTabBar();
    // 侧栏设置必须跟着切换：否则用户看到的是上一个分组的端口与参数，
    // 却以为改的是当前分组的。连接按钮同理，它代表的是当前这一个分组。
    applyGroupSerialOptionsToSidebar(activeGroupId);
    // 五个显示开关同样属于当前分组（per-group 作用域下各组各一份）。
    // 回显只写 checked，不改变量：变量由 getGroupDisplayPrefs 在前缀/回显读取时同步。
    syncDisplayPrefCheckboxes(getGroupDisplayPrefs(activeGroupId));
    updateSidebarActiveGroupLabel();
    refreshConnectButtonState();
    updateFilterModeStatuses();
    if (fit) fitWorkspaceTerminals();
}

// 更新侧栏顶部「当前控制的分组」标识。
//
// 多分组后左栏全部控件都只作用于 activeGroupId，而端口下拉框在多个分组都选了同一个
// 端口时长得一模一样。这个标识是用户区分「我正在改哪个串口」的唯一恒定依据，
// 因此除了分组名还要带上连接状态，避免误以为在改一个已连接的分组。
function updateSidebarActiveGroupLabel() {
    const nameEl = document.getElementById('sidebar-active-group-name');
    if (!nameEl) return;
    const group = getSerialGroupById(activeGroupId);
    const title = group ? resolveGroupTitleForDisplay(group) : tr('main.mainTerminal');
    nameEl.textContent = title;
    nameEl.title = title;
    const container = document.getElementById('sidebar-active-group');
    if (container) {
        container.dataset.groupId = activeGroupId;
        container.dataset.connected = group?.status === 'connected' ? 'true' : 'false';
    }
    syncAllGroupMainTabTitles();
}

// 分组在标签与侧栏上显示的名字。
//
// 开启「跟随端口」时用端口名，否则用用户起的标题。所有显示位置（分组标签、
// 主终端标签、侧栏指示条、侧栏标题）都必须走这里，否则四处的名字会各说各话。
function resolveGroupTitleForDisplay(group) {
    if (!group) return '';
    return resolveGroupDisplayTitle(group, group.title || group.id || '');
}

// 分组标题在标签、侧栏指示条、侧栏标题上的所有展示点。
//
// 单独抽出来是因为「跟随端口」让标题变成派生值：端口一变，四处都要重画。
// 只改其中一处会出现「标签叫 COM7、侧栏还写 COM6」这种自相矛盾。
function syncGroupTitlesForPortChange(groupId) {
    const id = resolveSerialGroupId(groupId);
    syncAllGroupMainTabTitles();
    renderSerialGroupTabBar();
    if (id === resolveSerialGroupId(activeGroupId)) updateSidebarActiveGroupLabel();
}

// 让每个分组的主标签按钮显示**它自己的分组名**。
//
// 默认分组的主标签来自 index.html 的静态标记，带着 data-i18n="main.mainTerminal"，
// 国际化一跑就被改回「主终端」。于是多分组时会出现「新建的分组叫 COM2、
// 默认分组却叫主终端」这种不一致，用户会觉得两者是两种不同的东西。
//
// 这里统一改成分组名，并移除 data-i18n，避免下一次 applyConfig 又把它覆盖回去。
function syncAllGroupMainTabTitles() {
    serialGroups.forEach(group => {
        const button = document.getElementById(mainTabButtonId(group.id));
        if (!button) return;
        const title = resolveGroupTitleForDisplay(group);
        // 静态按钮的文案是直接文本节点，动态按钮里包了一层 .main-tab-title。
        const titleEl = button.querySelector('.main-tab-title');
        if (titleEl) {
            titleEl.textContent = title;
        } else if (!button.querySelector('.main-tab-close')) {
            button.textContent = title;
        } else {
            // 静态按钮：文本节点 + 关闭占位符，只改文本节点。
            const textNode = Array.from(button.childNodes)
                .find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
            if (textNode) textNode.textContent = title;
            else button.insertBefore(document.createTextNode(title), button.firstChild);
        }
        button.removeAttribute('data-i18n');
        button.title = title;
        // 单组模式下分组标签栏整条隐藏，连接指示只能挂在它自己的主终端标签上。
        button.classList.add('serial-conn-indicator');
        button.classList.toggle('connected', isGroupConnected(group.id));
    });
}

// Startup focus hint; after initialization it mirrors workspaceModel.focusedTabId.
let focusedWorkspaceTabId = null;

// 这个 id 在当前活状态里还成不成立（Shell 在 shellTabs 里，其它叶在某个分组布局的 pane 里）。
function isLiveWorkspaceTabId(tabId) {
    if (!tabId) return false;
    if (workspaceModel) return Boolean(workspaceModel.tabs[tabId]);
    if (getShellTabState(tabId)) return true;
    return serialGroups.some(group => {
        const layout = groupWorkspaceLayouts.get(group.id);
        return Boolean(layout && Array.isArray(layout.panes)
            && layout.panes.some(pane => pane.tabIds.includes(tabId)));
    });
}

// 投影用的焦点：显式焦点还有效就用它，否则回落到激活分组自己的激活叶。
function focusedTabIdForProjection() {
    if (isLiveWorkspaceTabId(focusedWorkspaceTabId)) return focusedWorkspaceTabId;
    return getGroupActiveTabId(activeGroupId);
}

function workspaceTabState() {
    return workspaceModel;
}

function workspaceTabOf(tabId) {
    return tabModel.tabOf(workspaceTabState(), tabId);
}

// 切换到一个 Shell 标签。
//
// 唯一的写入口就是 setFocusedTab：写焦点与所在 pane 的 activeTabId，
// 再让 renderWorkspace 重新收敛。不再有「按宿主分三个分支」这回事——
// 宿主本身就是 plan 的产物，不是渲染的输入。
function switchShellTab(tabId) {
    if (!getShellTabState(tabId)) return false;
    return setFocusedTab(tabId);
}

// 模型层的「激活」写入口。
//
// 只写两个事实：焦点（focusedWorkspaceTabId / 所在 pane 的 activeTabId）。
// 任何「哪一列可见」「哪一行亮」都是派生值，因此绝不在这里写。
function setFocusedTab(tabId) {
    if (workspaceModel) return dispatchWorkspaceAction({ type: 'activate', tabId }).ok;
    if (!isLiveWorkspaceTabId(tabId)) return false;
    focusedWorkspaceTabId = tabId;
    return true;
}

// Shell 的切换已合并进 setFocusedTab：不再有「按宿主分三个分支」的实现，
// 宿主是 plan 的产物而不是渲染的输入。
//
// 不再叠层遮盖 Shell；递归布局协调器只按 plan.panelIds 写面板显隐。

// 重画入口。所有旧调用点（切分组、加分组、关分组、启停分屏）都汇到这里；
// 它只做一件事——请求一次完整渲染。列 / 行 / 按钮 / 面板的收敛全部在
// renderWorkspace() 里，不允许任何调用点再自己搬 DOM。
function renderSerialGroupTabBar() {
    renderWorkspaceNow();
}

// ─────────────────────── 渲染：唯一入口 renderWorkspace ───────────────────────
//
// 职责边界（这是本次重构的核心）：
//   • 输入只有一个：buildRenderPlan(ws) 的结果。渲染层不自己算布局。
//   • 四步都是「比对现状、只改差异」，不重建节点（C1）、父节点没变不 appendChild（C2）、
//     不加任何入场动画（C3）。
//   • 渲染层里不允许出现 split / paneSplit / isFlat / roots / childrenOf / rootFamilyOf。
//     出现即说明模型没把判断做完，应该回到 tab-model.js 补派生，而不是在这里补 if。
//
// 重入闸：收敛过程中会调用布局层的 ensurePaneElements / setActivePane，它们可能再请求
// 一次渲染。合并到当前这一轮，避免「渲染 → 布局回调 → 再渲染」的递归环。
let isRenderingWorkspace = false;
let lastNotifiedWorkspaceFocus = null;

// 请求一次完整渲染。所有交互只调它，不自己动 DOM。
function renderWorkspaceNow() {
    renderWorkspace(workspaceTabState());
    // 焦点可能刚切到或离开某个 Shell，受控组的视觉状态要跟着切换。
    // 无 DOM 的沙箱（如终端操作目标测试）里没有 document，直接跳过。
    // Local active styles belong to the tree; global control highlighting must not overwrite them.
    const tabId = workspaceModel?.focusedTabId || focusedWorkspaceTabId;
    if (tabId !== lastNotifiedWorkspaceFocus) {
        lastNotifiedWorkspaceFocus = tabId;
        window.dispatchEvent(new CustomEvent('workspace-focus-changed', { detail: { tabId } }));
    }
}

let layoutRenderer = null;
function renderWorkspace(ws) {
    if (isRenderingWorkspace || !ws?.layout) return;
    const host = document.getElementById(GROUP_WORKSPACE_CONTAINER_ID);
    if (!host) return;
    isRenderingWorkspace = true;
    try {
        if (!layoutRenderer) layoutRenderer = createLayoutRenderer({
            document, host,
            createPane: (groupId, nodeId) => createGroupPaneElement(groupId || activeGroupId, nodeId),
            getButton: tabId => document.querySelector(`.main-tab[data-target="${tabId}"]`),
            getGroupButton: (member, node) => {
                const info = describeGroupTab({ id: member.tabId,
                    title: resolveGroupTitleForDisplay(getSerialGroupById(member.tabId)) || member.tab.title,
                    active: member.active, connected: isGroupConnected(member.tabId)
                }, { isDefault: member.tabId === REGISTRY_DEFAULT_GROUP_ID });
                const buttonId = `layout-group-tab-${member.id}`;
                let button = document.getElementById(buttonId);
                if (!button) button = buildGroupTabButton({ ...info, buttonId, closeButtonId: `${buttonId}-close` });
                updateGroupTabButtonState(button, info);
                button.dataset.layoutItemId = member.id;
                return button;
            },
            onActivate: (tabId, itemId) => {
                const tab = workspaceModel.tabs[tabId];
                const owner = tabModel.isContainer(tab) ? tabId : tab?.ownerGroupId;
                if (owner && owner !== activeGroupId) {
                    activeGroupId = owner;
                    applyActiveSerialGroup({ fit: false, activateTab: false });
                }
                dispatchWorkspaceAction({ type: 'activate', tabId, itemId });
            },
            onMenu: (tabId, itemId, nodeId) => requestWorkspaceTabContextMenu({
                tabId, itemId, paneId: nodeId, groupId: groupIdForWorkspaceTab(tabId) || activeGroupId }),
            onDragState: dragging => { isDraggingWorkspaceSplitter = dragging; },
            onCollapse: (groupId, collapsed) => dispatchWorkspaceAction({ type: 'collapse-group', groupId, collapsed }),
            requestFrame: callback => requestAnimationFrame(callback),
            cancelFrame: id => cancelAnimationFrame(id),
            onResize: action => dispatchWorkspaceAction(action),
            fit: fitWorkspaceTerminals
        });
        layoutRenderer.render(tabModel.buildRenderPlan(ws));
    } finally { isRenderingWorkspace = false; }
    fitWorkspaceTerminals();
}

function orderButtons(listEl, ordered) {
    const buttons = (ordered || []).filter(button => button?.parentElement === listEl);
    for (let index = buttons.length - 2; index >= 0; index--) {
        if (buttons[index].nextElementSibling !== buttons[index + 1]) listEl.insertBefore(buttons[index], buttons[index + 1]);
    }
}

// One-time legacy import input. Live geometry is always read directly from workspaceModel.
function buildLiveWorkspaceSections() {
    const sections = {
        groups: serialGroups.map((group, index) => {
            const layout = workspaceModel ? getGroupWorkspaceLayout(group.id) : groupWorkspaceLayouts.get(group.id);
            return {
                id: group.id,
                title: group.title,
                order: index,
                collapsed: false,
                panes: layout
                    ? layout.panes.map(pane => ({
                        id: pane.id,
                        tabIds: [...pane.tabIds],
                        activeTabId: pane.activeTabId
                    }))
                    : [],
                paneSplit: layout
                    ? {
                        enabled: layout.splitEnabled === true,
                        orientation: layout.orientation,
                        sizes: { ...(layout.paneSizes || {}) },
                        activePaneId: layout.activePaneId
                    }
                    : { enabled: false, orientation: 'horizontal', sizes: {} }
            };
        }),
        filterTabs: {},
        chartTabs: {},
        shellTabs: shellTabs.map(tab => ({ id: tab.id, title: tab.title,
            hostGroupId: tab.hostGroupId || null, hostPaneId: tab.hostPaneId || null,
            columnMode: tab.columnMode, columnId: tab.columnId })),
        // 焦点是模型状态：显式焦点还有效就用它，否则回落到激活分组自己的激活叶。
        focusedTabId: focusedTabIdForProjection(),
        split: { enabled: false, orientation: 'horizontal', sizes: {} }
    };
    serialGroups.forEach(group => {
        sections.filterTabs[group.id] = filterTabsStore.getList(group.id).map(tab => ({ id: tab.id, title: tab.title }));
        sections.chartTabs[group.id] = chartTabsStore.getList(group.id).map(tab => ({ id: tab.id, title: tab.title }));
    });
    return sections;
}

function describeWorkspaceBusinessTab(tabId) {
    const shell = getShellTabState(tabId);
    if (shell) return { id: tabId, kind: 'shell', title: shell.title };
    for (const group of serialGroups) {
        if (tabId === mainTabId(group.id)) return { id: tabId, kind: 'main', title: group.title };
        const filter = filterTabsStore.getList(group.id).find(tab => tab.id === tabId);
        if (filter) return { id: tabId, kind: 'filter', title: filter.title };
        const chart = chartTabsStore.getList(group.id).find(tab => tab.id === tabId);
        if (chart) return { id: tabId, kind: 'chart', title: chart.title };
    }
    return null;
}

function dispatchWorkspaceAction(action) {
    if (!workspaceModel) return { ok: false, reason: '工作区尚未恢复' };
    const result = tabModel.applyWorkspaceAction(workspaceModel, action);
    if (!result.ok) return result;
    workspaceModel = result.workspace;
    focusedWorkspaceTabId = workspaceModel.focusedTabId;
    renderWorkspaceNow();
    scheduleWorkspaceLayoutSave();
    return result;
}

let workspaceLayoutSaveTimer = null;
function buildWorkspaceConfigSnapshot() {
    const workspaceLayoutState = serializeWorkspaceLayout(workspaceModel);
    const groups = serialGroups.map(group => {
        const { panes, paneSplit, workspaceLayout, ...business } = group;
        return { ...business,
            filterTabs: filterTabsStore.getList(group.id).map(serializeFilterTab),
            chartTabs: chartTabsStore.getList(group.id).map(serializeChartTab) };
    });
    const defaultGroup = groups.find(group => group.id === REGISTRY_DEFAULT_GROUP_ID);
    return { serialGroups: groups, shellTabs: shellTabs.map(tab => ({ id: tab.id, title: tab.title || '',
        profileId: tab.profileId || '' })), workspaceLayoutState, activeSerialGroupId: activeGroupId,
        filterTabs: defaultGroup?.filterTabs || [], chartTabs: defaultGroup?.chartTabs || [] };
}

function flushWorkspaceLayoutSave() {
    if (workspaceLayoutSaveTimer === null) return;
    clearTimeout(workspaceLayoutSaveTimer);
    workspaceLayoutSaveTimer = null;
    if (!workspaceModel || isApplyingConfig || isRestoringWorkspaceSession) return;
    const snapshot = buildWorkspaceConfigSnapshot();
    Object.assign(currentConfig, snapshot);
    ipcRenderer.send('save-config', snapshot);
}

function scheduleWorkspaceLayoutSave() {
    if (!workspaceModel || isApplyingConfig || isRestoringWorkspaceSession) return;
    if (workspaceLayoutSaveTimer !== null) clearTimeout(workspaceLayoutSaveTimer);
    workspaceLayoutSaveTimer = setTimeout(flushWorkspaceLayoutSave, 0);
}

window.addEventListener('beforeunload', flushWorkspaceLayoutSave);


function initializeWorkspaceModel() {
    if (workspaceModel) return false;
    workspaceModel = decodeWorkspaceLayout(importWorkspace(buildLiveWorkspaceSections()), currentConfig?.workspaceLayoutState);
    if (serialGroups.some(group => group.id === currentConfig?.activeSerialGroupId)) activeGroupId = currentConfig.activeSerialGroupId;
    focusedWorkspaceTabId = workspaceModel.focusedTabId;
    // Startup-only import caches must never become a second runtime layout.
    groupWorkspaceLayouts.clear();
    groupLayoutSnapshots.clear();
    shellTabs.forEach(tab => {
        delete tab.hostGroupId; delete tab.hostPaneId; delete tab.columnMode; delete tab.columnId;
    });
    groupWorkspaceManagers.clear();
    setActiveGroupWorkspace(activeGroupId);
    renderWorkspaceNow();
    return true;
}

function buildLiveWorkspace() {
    return workspaceModel;
}

// 只供 CDP 验证脚本调用，不在渲染路径上。
//
// 返回模型算出的渲染计划与页面真实形态的快照，供验证脚本逐项比对。
// 这里只读取真实 DOM（offsetParent + getBoundingClientRect），不写入任何状态，
// 因为判据必须是「用户眼睛能看到什么」，而不是某个属性被赋了什么值。
window.__readTabModelPlan = () => {
    const shown = el => Boolean(el) && el.offsetParent !== null
        && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    const ws = buildLiveWorkspace();
    const plan = ws ? tabModel.buildRenderPlan(ws) : null;
    const stacks = Array.from(document.querySelectorAll('.layout-stack')).filter(shown);
    const headers = stacks.map(element => ({ element, header: element.querySelector('.pane-tabs-header') }))
        .filter(entry => shown(entry.header));
    const buttons = entry => Array.from(entry.header.querySelector('.pane-tabs-list')?.children || []).filter(shown);
    const groupRows = headers.filter(entry => entry.header.classList.contains('group-tab-row'));
    const visiblePanels = Array.from(document.querySelectorAll('.main-tab-pane.active')).filter(shown).map(el => el.id);
    return {
        activeGroupId,
        containerIds: ws ? tabModel.containerIds(ws) : [],
        plan: plan && { root: plan.root, columns: plan.columns.map(column => ({
            columnId: column.columnId, containerId: column.containerId, isFamily: column.isFamily,
            tabIds: column.tabItems.map(tab => tab.id), rows: column.rows.map(row => ({
                paneId: row.paneId, tabIds: row.tabs.map(tab => tab.id), activeTabId: row.activeTabId
            })), panelIds: column.panelIds, panelIdsAll: column.panelIdsAll
        })), panelIds: plan.panelIds },
        live: {
            visibleColumns: stacks.map(element => element.dataset.layoutNodeId),
            groupRowGroupTabs: groupRows.flatMap(entry => buttons(entry).filter(button => button.dataset.groupId).map(button => button.dataset.groupId)),
            groupRowShellTabs: headers.filter(entry => !entry.element.dataset.groupId).flatMap(entry => buttons(entry)
                .filter(button => ws?.tabs[button.dataset.target]?.kind === 'shell').map(button => button.dataset.target)),
            familyRowTabs: ws && tabModel.isFlat(ws) ? headers.flatMap(entry => buttons(entry).map(button => button.dataset.target)) : [],
            overlaidPanels: visiblePanels, visiblePanels,
            subRowCount: headers.filter(entry => !entry.header.classList.contains('group-tab-row') && plan?.root.rowRole !== 'root').length
        },
        error: null,
        sections: JSON.parse(JSON.stringify(buildLiveWorkspaceSections()))
    };
};

// 静态分组行的标签列表只在模块加载时存在一份，委托在这里挂一次即可；
// 动态列的列表在 ensureSerialGroupWorkspaceDom 里建好后各自挂。
bindGroupTabListEvents(document.getElementById(GROUP_TAB_LIST_ID));

// 工作区里**所有已存在的 pane 标签行**一次性全部挂上右键委托。
//
// 为什么不能只写 `pane-1`：静态标记里本来就有两个 pane（`index.html` 的
// `#pane-1` 与 `#pane-2`），而 `createPaneElement` 首行是
// `if (getPaneDom(paneId)) return null` —— 它**只处理新建的 pane**，静态的
// `pane-2` 永远走不到那里。早先这里只硬写了 `pane-1`，于是主终端与过滤页
// 上下分屏后，下方那个 pane 的标签右键没有任何监听（实测 `pcm-1600.txt`：
// `pane-1` 发出 1 次 `show-terminal-context-menu`，`pane-2` 发出 **0** 次）。
//
// 改成按容器扇描而不是逐个写 id：以后再往 `index.html` 里加静态 pane、或者
// 哪个构造路径忘了自己绑，这一扇扫都能补上。`bindPaneTabListEvents` 本身是
// 幂等的（`data-pane-tab-events`），重复调用不会挂两遍监听，所以这里不需要
// 也不应该再维护「哪些已经绑过」的名单。
document.querySelectorAll('#group-workspace .pane-tabs-list').forEach(listEl => {
    bindPaneTabListEvents(listEl);
});

// 静态 pane-1 / pane-2 的动作按钮组用**同一条构造路径**重建。
//
// index.html 里那两份是手写的：按钮之间还有换行缩进产生的空白文本节点，
// 渲染出的间距（实测 8.39px）与非默认分组动态建的（4px）不一样。
// 重建一次就把两者拉到同一起点：同样的元素、同样的顺序、没有文本节点，
// 间距完全由 CSS 的 gap 决定。
//
// `#add-serial-group-inline-btn` 不属于这组按钮（它是全局动作、常任在 pane-1 行），
// 必须在重建后重新插回去，且它的事件监听是在文件末尾对模块级 const 绑的，
// 节点本身不重建就不会丢。
['pane-1', 'pane-2'].forEach(paneId => {
    const actions = document.querySelector(`#${paneId} .pane-tab-actions`);
    if (!actions) return;
    const inlineBtn = actions.querySelector('#add-serial-group-inline-btn');
    fillPaneActionButtons(actions, paneId);
    if (inlineBtn) actions.appendChild(inlineBtn);
});

// 新建 Shell 图标：一级栏与二级栏**永久同时显示**（用户裁决，见 memory-ede39045）。
//
// 历史：这里曾经为了「屏幕上恰好一个入口」而双向写 `button.hidden = isMultiGroup`，
// 但那套互斥判据在「点第二组、再点 Shell」时把两个一级入口一起藏掉（实测 diag1051：
// 按钮自身 hidden 都是 false，真正的封因是它们所在的列被隐藏，见 getVisibleGroupRow）。
// 现在改为：两级的图标都恒显示，可见性不再由形态决定，而是由它们**落在哪一行**保证。
//
// 这里仍然要把历史上写过的 `hidden = true` 洗干净：多分组→单分组、或建过新 pane 之后，
// 旧值会留在 DOM 上，不重写就会「看起来又没显示」。
function syncShellAddButtonVisibility() {
    if (addShellTabBtn) addShellTabBtn.hidden = false;
    // 按 id 后缀扫而不是逐个记引用：组内分屏与新建分组都会现造新 pane。
    document.querySelectorAll('.pane-tab-actions > button').forEach(button => {
        if (!/-new-shell-tab-btn$/.test(button.id || '')) return;
        button.hidden = false;
    });
}


// 让静态新建 Shell 按钮落在**当前可见**的分组标签行里（与 placeGroupAddButton 同一套锚点）。
function placeShellAddButton() {
    if (!addShellTabBtn) return;
    const hostRow = getVisibleGroupRow(activeGroupId);
    if (!hostRow) return;
    let actions = hostRow.querySelector('.serial-group-tab-actions');
    if (!actions) {
        actions = document.createElement('div');
        actions.className = 'serial-group-tab-actions';
        hostRow.appendChild(actions);
    }
    // 同一个 actions 里必须排在「添加串口」左边，否则不同列的首行顺序会不一致。
    if (addShellTabBtn.parentElement !== actions || addShellTabBtn.nextElementSibling !== addSerialGroupBtn) {
        actions.insertBefore(addShellTabBtn, addSerialGroupBtn || actions.firstChild);
    }
}

// 把一个分组标签的模型描述变成真实按钮。
//
// 拆出来是因为分屏时每列的标签要在不同的循环里创建，两处都要同一套结构 ——
// 复制一份意味着「为什么这列能关、那列不能关」这类漂移。
function buildGroupTabButton(tab) {
    const button = document.createElement('button');
    button.className = tab.className;
    button.type = 'button';
    button.id = tab.buttonId;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.active));
    button.dataset.groupId = tab.groupId;

    const titleEl = document.createElement('span');
    titleEl.className = 'main-tab-title';
    titleEl.textContent = tab.title;
    button.appendChild(titleEl);

    // 点击与右键菜单不在这里绑：统一走**事件委托**（见 bindGroupTabListEvents）。
    //
    // 构造时用闭包绑 groupId 的写法在「按钮复用」后就不成立了：闭包里是旧的 tab 对象，
    // 重命名或重新归属之后点击会落到旧语义上。
    // 委托只挂一次、从 dataset 现读 groupId，复用与新造走同一条路径。



    const closeEl = document.createElement('span');
    closeEl.className = 'main-tab-close';
    closeEl.id = tab.closeButtonId;
    closeEl.title = tr('main.closeTab');
    closeEl.appendChild(createMaterialIcon('close'));
    if (!tab.closable) {
        // 默认分组不可关闭，但按钮保留占位：若直接不渲染，标签宽度会在
        // 分组之间跳变，点击位置也会跟着漂移。
        closeEl.classList.add('disabled');
    } else {
        closeEl.addEventListener('click', event => {
            event.stopPropagation();
            closeSerialGroup(tab.groupId, { anchor: button });
        });
    }
    button.appendChild(closeEl);
    // 双击分组标签进入重命名：与右键菜单的「重命名」走同一个目标解析。
    button.addEventListener('dblclick', event => {
        if (event.target.closest('.main-tab-close')) return;
        event.preventDefault();
        event.stopPropagation();
        openRenameTabDialog({ groupId: tab.groupId, title: tab.title });
    });
    return button;
}

// 就地更新一个**已存在**的分组标签按钮的文案与状态类名。
//
// 与 buildGroupTabButton 的分工：那个只在首次出现时造一次结构，这个负责之后每次重绘只改变化
// 的那几个值。两者必须用同一套类名拼法，否则复用后状态会停在旧值上，
// 所以 updateGroupTabButtonState 直接复用模型里的 className 字符串。
function updateGroupTabButtonState(button, tab) {
    button.className = tab.className;
    button.setAttribute('aria-selected', String(tab.active));
    const titleEl = button.querySelector('.main-tab-title');
    if (titleEl && titleEl.textContent !== tab.title) titleEl.textContent = tab.title;
    const closeEl = button.querySelector('.main-tab-close');
    if (closeEl) closeEl.classList.toggle('disabled', !tab.closable);
}


// 分组标签列表上的事件委托。**只挂一次**（模块加载时对静态列表挂，动态列的列表由
// ensureSerialGroupWorkspaceDom 建好后单独挂），所以挂载前会打标记去重。
//
// 为什么必须委托而不是逐按钮绑：renderSerialGroupTabBar 现在复用按钮而不重建，
// 若仍然在构造时用闭包绑 groupId，复用后的按钮会一直持有旧的 groupId。
function bindGroupTabListEvents(listEl) {
    if (!listEl || listEl.dataset.groupTabEvents === '1') return;
    listEl.dataset.groupTabEvents = '1';
    listEl.addEventListener('click', event => {
        if (event.target.closest('.main-tab-close')) return;
        const button = event.target.closest('.serial-group-tab');
        const groupId = button?.dataset.groupId;
        if (groupId) activateSerialGroup(groupId);
    });
    // 分组级分屏的唯一入口。不用工具栏按钮：分屏是低频且带方向的开关（左右 / 上下 /
    // 关闭三选一），排成按钮会占满标签栏——用户在布局图里明确要求分组标签不挤在一起。
    //
    //
    // 这一行里除了分组标签，还可能住着未归属的 Shell（分屏时它的按钮被搬到该列的列首行）。
    // 早先这里直接把「行里的非分组标签」全部归到分组菜单，于是右键 Shell 只能拿到分组级
    // 菜单，`tabId` 为空，「让这个 Shell 独立成列」完全没有入口（实测 diag986 b4：payload
    // 仍是 `{terminalType:'group', tabId:''}`）。现在按**标签自己的类型**分流：
    // Shell 是根级叶、它的列形态是它自己的属性，必须走 `requestWorkspaceTabContextMenu`
    // （那条路会给 `terminalType:'tab'` 并带上 `tabId` / `canDetach`）；
    // 串口主/过滤/图表标签是容器的子项，右键它们的意图才是「移走这个分组」。
    listEl.addEventListener('contextmenu', event => {
        const groupTab = event.target.closest('.serial-group-tab');
        if (groupTab) {
            const groupId = groupTab.dataset.groupId;
            if (!groupId) return;
            event.preventDefault();
            event.stopPropagation();
            requestSerialGroupContextMenu(groupId);
            return;
        }
        const tabBtn = event.target.closest('.main-tab');
        if (!tabBtn) return;
        const tabId = tabBtn.dataset.target || '';
        // 该行属于哪个分组。行 id 形如 serial-group-tab-bar-<groupId>，
        // 但默认分组用的是静态 id serial-group-tab-bar，所以改从 column 上读 dataset。
        const column = listEl.closest('.group-column');
        const columnGroupId = column?.dataset.groupId;
        const owningGroupId = columnGroupId && columnGroupId !== SHELL_COLUMN_GROUP_ID
            ? columnGroupId
            : activeGroupId;
        event.preventDefault();
        event.stopPropagation();
        if (isShellTabId(tabId)) {
            requestWorkspaceTabContextMenu({
                tabId,
                paneId: resolvePaneId(tabBtn.dataset.paneId, tabId),
                groupId: owningGroupId
            });
            return;
        }
        if (!columnGroupId || columnGroupId === SHELL_COLUMN_GROUP_ID) return;
        requestSerialGroupContextMenu(columnGroupId);
    });
}

// 普通标签的右键委托与 groupIdFromPaneId 都定义在文件前段（紧邻 getPaneTabsContent），
// 因为 pane 构造器在加载期就会调它们，定义在这里会来不及。

// 决定「添加串口」按钮显示在哪一层。
//
// 两层各有一个入口：
//
// - 分组栏自己那个静态按钮（#add-serial-group-btn）属于分组层，**永久显示**；
//   单分组时整条分组栏是 hidden，它自然不可见（不是被逐个 hidden 掉的）。
// - pane 标签行那个（#add-serial-group-inline-btn）属于单层，**只在单分组时提供**。
//
// 为什么 inline 仍然要隐：它是「添加串口」的**等价入口**，不是「图标随形态消失」。
// 单分组时一级栏整条不存在，没有它用户首次启动就开不了多串口；
// 多分组时一级栏已经常显，再留一个一模一样的 inline 就是用户报过的「两个添加串口按钮」。
// 这跟「两级都永久显示新建 Shell 图标」不矛盾：后者是同一功能在**两级不同行**都要能直接
// 新建，用户要的就是这个；前者是同一功能在相邻两处的重复按钮。
//
// 注意：这里的 hidden 是否真能隐藏，取决于 CSS 里 [hidden] { display:none !important }，
// 因为全局 button { display: inline-flex } 会覆盖浏览器默认的 [hidden] 样式。
function syncSerialGroupAddButtonLayer() {
    const isMultiGroup = isMultiGroupLayer();
    if (addSerialGroupInlineBtn) {
        addSerialGroupInlineBtn.hidden = isMultiGroup;
    }
    if (addSerialGroupBtn) {
        addSerialGroupBtn.hidden = false;
    }
}


// 「当前屏幕上**真正可见**的那一条一级标签行」。
//
// 判据必须同时满足三件事，缺一就会在某个形态下把按钮放进看不见的容器里：
//   1. 行自己没被 hidden；
//   2. **行所在的列没被 hidden** —— 只判行是历史缺陷：点 Shell 后焦点落在未归属叶上，
//      可见列切到 default，而 activeGroupId 仍是 g-1，于是按钮停在已隐藏的 g-1 列里，
//      用户看到的是「一级标签栏的两个添加按钮都消失了」（实测 diag1051 step3：
//      两个按钮自身 hidden 都是 false，blockedBy 是 `serial-group-workspace-g-1[hidden]`）；
//   3. 真的渲染出了尺寸（column 的 hidden 也可能由 CSS 而非属性驱动）。
//
// 因此不再按 `columnGroupId` 取「那一条」，而是**扫描所有真实可见的行**：调用方要的是
// 「按钮放哪用户看得见」，而不是「某个 id 对应的行在哪」。都没有时才回落到静态行。
function getVisibleGroupRow() {
    const rows = Array.from(document.querySelectorAll('.group-tab-row'));
    const visible = rows.find(row => {
        if (!row || row.hidden === true) return false;
        const column = row.closest('.group-column');
        if (!column || column.hidden === true) return false;
        const rect = row.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    });
    if (visible) return visible;
    return document.getElementById(GROUP_TAB_BAR_ID);
}


function isShellTabId(tabId) {
    return typeof tabId === 'string' && /^tab-shell-\d+$/.test(tabId);
}

// 点击分组标签：切分组就是「看这个分组的串口终端」。
//
// 不再需要 revealSerialGroupActiveTab：显隐只由 plan.panelIds 决定，
// 而这个 plan 的输入是 focusedTabId——把焦点指向该分组的主标签即可。
function activateSerialGroup(groupId) {
    const id = resolveSerialGroupId(groupId);
    if (id === activeGroupId) {
        // 点当前分组时把焦点抬回本分组的主标签（用户想表达的就是「给我看串口终端」）。
        const targetTabId = mainTabId(id);
        if (document.getElementById(targetTabId)) setFocusedTab(targetTabId);
        return;
    }
    activeGroupId = id;
    applyActiveSerialGroup();
}



// 「添加串口」：新建分组后**保持 disconnected**，等用户手动点连接（产品决定）。
function addSerialGroupFromUi() {
    const current = getSerialGroupById(activeGroupId);
    const result = addSerialGroup(serialGroups, { inheritFrom: current || undefined });
    serialGroups = result.groups;
    const groupId = result.groupId;
    serialGroupRegistry.ensureGroup(groupId);
    serialGroupContext.ensureContext(groupId);
    if (workspaceModel) dispatchWorkspaceAction({ type: 'add-group', options: {
        id: groupId, groupId, title: result.group.title, mainId: mainTabId(groupId), paneId: groupPaneId(groupId, 1)
    } });
    // 必须先建外层容器（含本分组的 pane-1）再建主标签：
    // ensureSerialGroupMainTabDom 靠 groupPaneId(groupId, 1) 找 pane 容器，
    // 它不存在时会直接 return false，于是新分组既没有主标签也没有终端。
    ensureSerialGroupWorkspaceDom(groupId);
    ensureSerialGroupMainTabDom(groupId, result.group.title);
    activeGroupId = groupId;
    persistSerialGroups();
    renderSerialGroupTabBar();
    // 多分组时外层要开始并排显示，这个必须在 applyActiveSerialGroup 之前对一次。
    syncGroupWorkspaceVisibility();
    applyActiveSerialGroup();
    setActionStatus(`已添加串口分组 ${result.group.title}`);

    // 新分组是 disconnected，没有任何端口可用，把侧栏焦点交给用户去选端口。
    if (portSelect) portSelect.focus();
    return result.group;
}

function persistSerialGroups() {
    if (workspaceModel) { scheduleWorkspaceLayoutSave(); return; }
    ipcRenderer.send('save-config', { serialGroups });
}

const pendingTabCloseConfirmations = new Set();

let tabCloseDialog = null;

function showTabCloseDialog(options) {
    if (!tabCloseDialog) tabCloseDialog = createAnchoredConfirmDialog({
        document, window, overlay: document.getElementById('tab-close-dialog')
    });
    return tabCloseDialog.show(options);
}

function requestTabCloseConfirmation(tab, kind, close, anchor = tab.btn) {
    const key = `${kind}:${tab.id}`;
    if (pendingTabCloseConfirmations.has(key)) return Promise.resolve(false);
    pendingTabCloseConfirmations.add(key);
    const title = tab.title || tab.btn?.querySelector?.('.main-tab-title')?.textContent || tab.id;
    const detailKey = kind === 'group' ? 'closeGroupTabWarning' : kind === 'shell' ? 'closeShellTabWarning' : 'closeTabWarning';
    if (!anchor && kind === 'group') anchor = Array.from(document.querySelectorAll('.serial-group-tab'))
        .find(button => button.dataset.groupId === tab.id && button.getClientRects().length);
    return Promise.resolve().then(() => showTabCloseDialog({
        anchor,
        title: tr('main.closeTab'),
        message: tr('main.confirmCloseTab', { title }),
        detail: tr(`main.${detailKey}`),
        confirmLabel: tr('main.closeTab'),
        cancelLabel: tr('main.cancel')
    })).then(approved => approved === true ? close() : false).catch(error => {
        setActionStatus(tr('main.closeTabConfirmFailed', { error: error.message || String(error) }));
        return false;
    }).finally(() => pendingTabCloseConfirmations.delete(key));
}

// 关闭一个分组：断开连接 → 释放终端 → 移除节点 → 从列表移除 → 切到邻居。
function closeSerialGroup(groupId, { confirm = true, anchor = null } = {}) {
    const id = resolveSerialGroupId(groupId);
    if (id === REGISTRY_DEFAULT_GROUP_ID) return false;
    const group = getSerialGroupById(id);
    if (!group) return false;

    if (confirm) return requestTabCloseConfirmation(group, 'group', () =>
        getSerialGroupById(id) === group ? closeSerialGroup(id, { confirm: false }) : false, anchor);

    const removalResult = workspaceModel ? tabModel.applyWorkspaceAction(workspaceModel, { type: 'remove-group', groupId: id }) : null;
    if (removalResult && !removalResult.ok) return false;
    const wasControlGroup = activeGroupId === id;
    const nextControlGroupId = resolveGroupAfterClose(serialGroups, id, activeGroupId);
    if (persistFilterTabsTimers.has(id)) {
        clearTimeout(persistFilterTabsTimers.get(id));
        persistFilterTabsTimers.delete(id);
    }
    ipcRenderer.send('disconnect-serial', { groupId: id });
    destroySerialGroupResources(id);
    const tabId = mainTabId(id);
    const buttonId = mainTabButtonId(id);
    const containerId = serialContainerId(id);
    serialRuntimes.release(id);
    serialGroupIo.delete(id);
    serialOutputBuckets.clear(id);
    serialGroupContext.removeContext(id);
    filterTabsStore.removeList(id);
    chartTabsStore.removeList(id);
    // 该分组的布局与布局管理器一起丢掉：留着它们会让下次同名分组继承旧布局，
    // 也会让 groupWorkspaceManagers 一直增长。
    groupWorkspaceLayouts.delete(id);
    groupWorkspaceManagers.delete(id);
    groupLayoutSnapshots.delete(id);
    serialGroupRegistry.removeGroup(id);
    document.getElementById(buttonId)?.remove();
    document.getElementById(tabId)?.remove();
    document.getElementById(containerId)?.remove();
    // 先把静态分组标签行挪回默认分组列。它可能正被 borrow 在**这个即将删除的列**里
    // （未分屏时它就住在激活列首），跟着容器一起 remove 掉后，分组栏会永久消失且静默。
    reclaimSharedGroupTabRow();
    reclaimGroupAddButton();
    // 新建 Shell 按钮同理：它可能正住在这个即将删除的列首行里（分屏时每列一个可选宿主）。
    reclaimShellAddButton();

    if (!workspaceModel) removeTabFromWorkspace(tabId, { fallbackTabId: mainTabId(REGISTRY_DEFAULT_GROUP_ID), persist: false });

    const removal = removeSerialGroup(serialGroups, id);
    serialGroups = removal.groups;
    if (!serialGroups.length) serialGroups = [createDefaultSerialGroupState()];
    activeGroupId = nextControlGroupId || serialGroups[0].id;
    if (removalResult) {
        workspaceModel = removalResult.workspace;
        focusedWorkspaceTabId = workspaceModel.focusedTabId;
    }
    if (wasControlGroup) applyActiveSerialGroup({ fit: false, activateTab: false });

    persistSerialGroups();
    // 先画一轮：把还活着的按钮/面板从旧列里搬出来，并隐藏已删列。
    renderSerialGroupTabBar();
    // 现在旧列里只剩它自己的静态壳，整个拿掉（只删 internal 节点会留下空 flex 条目）。
    document.getElementById(groupWorkspaceContainerId(id))?.remove();
    setActionStatus(`已关闭串口分组 ${group.title}`);
    return true;
}

// 关闭分组后选哪个：优先右邻，没有右邻再左邻（与 serial-group-tabs.js 同一规则）。
function resolveGroupAfterClose(groups, closedGroupId, currentActiveGroupId) {
    const list = Array.isArray(groups) ? groups.filter(group => group && typeof group.id === 'string') : [];
    const closedIndex = list.findIndex(group => group.id === closedGroupId);
    if (closedIndex === -1) return currentActiveGroupId;
    const remaining = list.filter(group => group.id !== closedGroupId);
    if (!remaining.length) return null;
    if (closedGroupId !== currentActiveGroupId) return currentActiveGroupId;
    const nextIndex = Math.min(closedIndex, remaining.length - 1);
    return remaining[nextIndex].id;
}

function updateTabTitles() {
    filterTabs.forEach((tab, index) => {
        const displayIndex = index + 1;
        const closeBtn = tab.btn.querySelector('.main-tab-close');
        const title = tab.title?.trim() || `${tr('main.filter')} ${displayIndex}`;
        const titleEl = document.createElement('span');
        titleEl.className = 'main-tab-title';
        titleEl.textContent = title;
        tab.btn.replaceChildren(titleEl);
        if (tab.dataMode === 'hex') {
            const badge = document.createElement('span');
            badge.className = 'mode-badge hex';
            badge.textContent = 'HEX';
            tab.btn.appendChild(badge);
        }
        tab.btn.appendChild(closeBtn);
    });
    shellTabs.forEach((tab, index) => {
        const closeBtn = tab.btn.querySelector('.main-tab-close');
        const profile = currentConfig?.shellProfiles?.find(item => item.id === tab.profileId);
        const defaultTitle = profile?.name?.trim() || tr('main.shellTitle', { index: index + 1 });
        const title = tab.title?.trim() || defaultTitle;
        const titleEl = document.createElement('span');
        titleEl.className = 'main-tab-title';
        titleEl.textContent = title;
        tab.btn.replaceChildren(titleEl);
        if (tab.textMode) {
            const badge = document.createElement('span');
            badge.className = 'mode-badge text';
            badge.textContent = 'TEXT';
            tab.btn.appendChild(badge);
        }
        tab.btn.appendChild(closeBtn);
    });
    chartTabs.forEach((tab, index) => {
        const closeBtn = tab.btn.querySelector('.main-tab-close');
        const titleEl = document.createElement('span');
        titleEl.className = 'main-tab-title';
        titleEl.textContent = tab.title?.trim() || `${tr('main.chart')} ${index + 1}`;
        tab.btn.replaceChildren(titleEl);
        tab.btn.appendChild(closeBtn);
    });
}

function getMainTabTitle(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    if (id === REGISTRY_DEFAULT_GROUP_ID) return 'Main_Terminal';
    const groups = Array.isArray(currentConfig?.serialGroups) ? currentConfig.serialGroups : [];
    const group = groups.find(item => item && item.id === id);
    return group?.title?.trim() || `Main_Terminal_${id}`;
}

function getFilterTabLogTitle(tabState) {
    if (!tabState) return 'Filter';
    if (tabState.title?.trim()) return tabState.title.trim();
    const index = filterTabs.indexOf(tabState);
    return index >= 0 ? `Filter_${index + 1}` : 'Filter';
}

function getShellTabLogTitle(tabState) {
    if (!tabState) return 'Shell';
    if (tabState.title?.trim()) return tabState.title.trim();
    const index = shellTabs.indexOf(tabState);
    return index >= 0 ? `Shell_${index + 1}` : 'Shell';
}

function writeTabLog(tabId, title, data, groupId = REGISTRY_DEFAULT_GROUP_ID) {
    if (!tabId || typeof data !== 'string' || !data) {
        return;
    }
    // 日志归属它所在的分组：主进程按 groupId 解析端口目录。缺了这个字段，
    // 所有分组的主终端日志都会落进默认分组的端口目录里。
    ipcRenderer.send('write-tab-log', { tabId, title, data, groupId: resolveSerialGroupId(groupId) });
}

function writeMainTabLog(data, groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    writeTabLog(mainTabId(id), getMainTabTitle(id), data, id);
}

function writeFilterTabLog(tabState, data, groupId = REGISTRY_DEFAULT_GROUP_ID) {
    if (!tabState) return;
    writeTabLog(tabState.id, getFilterTabLogTitle(tabState), data, groupId);
}

// Shell 标签不属于任何串口分组：主进程按 tab-shell- 前缀把它固定归入 _shell 目录，
// 所以这里故意不传 groupId。
function writeShellTabLog(tabState, data) {
    if (!tabState) return;
    writeTabLog(tabState.id, getShellTabLogTitle(tabState), data);
}

function getDefaultShellProfileId() {
    const profiles = Array.isArray(currentConfig?.shellProfiles) ? currentConfig.shellProfiles : [];
    if (!profiles.length) return '';
    const defaultId = currentConfig?.defaultShellProfileId || '';
    if (defaultId) {
        const found = profiles.find(p => p.id === defaultId);
        if (found) return found.id;
    }
    return '';
}

function persistShellTabs() {
    scheduleWorkspaceLayoutSave();
}

function createShellTab(initialState = {}, targetPaneId = null) {
    const tabId = typeof initialState.id === 'string' && initialState.id ? initialState.id : `tab-shell-${getNextShellTabId()}`;
    syncNextShellTabId(tabId);
    const resolvedPaneId = targetPaneId || initialState.paneId || getActivePane()?.id || 'pane-1';
    const profileId = typeof initialState.profileId === 'string' && initialState.profileId
        ? initialState.profileId
        : (typeof initialState.shellType === 'string' ? initialState.shellType : '');

    const tabList = getPaneTabsList(resolvedPaneId);
    const tabBtn = document.createElement('button');
    tabBtn.className = 'main-tab';
    tabBtn.type = 'button';
    tabBtn.setAttribute('role', 'tab');
    tabBtn.setAttribute('aria-selected', 'false');
    tabBtn.id = `${tabId}-button`;
    tabBtn.setAttribute('aria-controls', tabId);
    tabBtn.dataset.target = tabId;
    tabBtn.dataset.paneId = resolvedPaneId;
    const shellTitle = document.createElement('span');
    shellTitle.className = 'main-tab-title';
    shellTitle.textContent = tr('main.shell');
    const shellClose = document.createElement('span');
    shellClose.className = 'main-tab-close';
    shellClose.title = tr('main.closeTab');
    shellClose.appendChild(createMaterialIcon('close'));
    tabBtn.append(shellTitle, shellClose);
    tabBtn.onclick = (e) => {
        if (e.target.closest('.main-tab-close')) return;
        // 激活只改模型焦点，不改变 Shell 的业务归属或所在区域。
        switchShellTab(tabId);
    };
    tabBtn.querySelector('.main-tab-close').onclick = () => {
        closeShellTab(tabId);
    };
    tabBtn.ondblclick = (e) => {
        if (!e.target.closest('.main-tab-close')) {
            const tabState = shellTabs.find(tab => tab.id === tabId);
            if (tabState) openRenameTabDialog(tabState);
        }
    };
    tabList.appendChild(tabBtn);

    const tabContent = getPaneTabsContent(resolvedPaneId);
    const tabPane = document.createElement('div');
    tabPane.className = 'main-tab-pane';
    tabPane.id = tabId;
    tabPane.setAttribute('role', 'tabpanel');
    tabPane.setAttribute('aria-labelledby', tabBtn.id);
    tabPane.dataset.paneId = resolvedPaneId;

    const terminalWrapper = document.createElement('div');
    terminalWrapper.className = 'terminal-wrapper';
    terminalWrapper.id = `terminal-${tabId}`;
    tabPane.appendChild(terminalWrapper);
    tabContent.appendChild(tabPane);

    const term = new Terminal({
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: true,
        scrollback: currentConfig ? (currentConfig.scrollbackLimit || 20000) : 20000
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    enableTerminalUnicode11(term);
    term.open(terminalWrapper);
    observeTerminalSearchChanges(term);

    if (currentConfig) {
        term.options = {
            fontSize: currentConfig.fontSize,
            fontWeight: currentConfig.fontWeight,
            fontFamily: TERMINAL_FONT_FAMILY(currentConfig),
            theme: getTerminalTheme(currentConfig)
        };
    }

    const tabState = {
        id: tabId,
        paneId: resolvedPaneId,
        title: initialState.title || '',
        profileId,
        term,
        fitAddon,
        searchAddon,
        element: tabPane,
        btn: tabBtn,
        sessionReady: false,
        sessionCreateTimer: null,
        mouseModeSequenceCarry: '',
        mouseInputSequenceCarry: '',
        shellMouseTrackingMode: undefined,
        textMode: false,
        hostGroupId: typeof initialState.hostGroupId === 'string' && initialState.hostGroupId
            ? initialState.hostGroupId
            : null,
        // 下列旧位置字段只在初始化导入时读取，模型初始化后立即删除。
        hostPaneId: typeof initialState.hostPaneId === 'string' && initialState.hostPaneId
            ? initialState.hostPaneId
            : null,
        // 兼容旧配置的专列/列记忆；运行态位置只由 layout.root 决定。
        columnId: (() => {
            if (typeof initialState.columnId === 'string' && initialState.columnId) return initialState.columnId;
            const columnGroupId = resolveGroupIdFromPaneId(resolvedPaneId);
            return serialGroups.some(group => group.id === columnGroupId) ? columnGroupId : null;
        })(),
        closed: false
    };

    term.attachCustomKeyEventHandler(createTerminalKeyHandler(term, 'shell'));
    term.onData((data) => {
        if (tabState.textMode) {
            data = stripShellMouseReports(tabState, data);
            if (!data) return;
        }
        ipcRenderer.send('shell-tab-input', { tabId, data });
    });
    term.onBinary((data) => {
        ipcRenderer.send('shell-tab-binary-input', {
            tabId,
            bytes: Array.from(data, character => character.charCodeAt(0) & 0xff)
        });
    });
    bindTerminalContextMenu({
        terminalType: 'shell',
        term,
        element: terminalWrapper,
        getTabState: () => tabState
    });
    bindShellTextModeWheel(tabState, terminalWrapper);

    shellTabs.push(tabState);
    if (workspaceModel) {
        dispatchWorkspaceAction({ type: 'add-leaf', groupId: resolveGroupIdFromPaneId(resolvedPaneId),
            paneId: resolvedPaneId, options: { id: tabId, kind: 'shell', title: tabState.title }, activate: !isRestoringWorkspaceSession });
        delete tabState.hostGroupId; delete tabState.hostPaneId; delete tabState.columnMode; delete tabState.columnId;
    }
    updateTabTitles();
    // 恢复前由旧位置导入；初始化后 add-leaf 已按单/多组规则登记真实成员。
    renderWorkspaceNow();
    if (!isRestoringWorkspaceSession) {
        // 焦点与每格 active 由统一模型动作维护。
        setFocusedTab(tabId);
        persistShellTabs();
        persistWorkspaceLayout();
        setActionStatus(tr('main.shellStarting'));
    }

    tabState.sessionCreateTimer = setTimeout(() => {
        tabState.sessionCreateTimer = null;
        if (tabState.closed || !shellTabs.includes(tabState)) return;
        fitAddon.fit();
        ipcRenderer.invoke('create-shell-tab-session', { tabId, cols: term.cols, rows: term.rows, profileId })
            .then(() => {
                if (tabState.closed || !shellTabs.includes(tabState)) {
                    ipcRenderer.send('close-shell-tab-session', { tabId });
                    return;
                }
                tabState.sessionReady = true;
                ipcRenderer.send('resize-shell-tab', { tabId, cols: term.cols, rows: term.rows });
            })
            .catch((error) => {
                if (tabState.closed) return;
                term.writeln(`\r\n[ERROR] ${tr('main.shellStartFailed', { error: error?.message || error })}\r\n`);
            });
    }, 50);
}

function closeShellTab(tabId, { confirm = true } = {}) {
    const index = shellTabs.findIndex(t => t.id === tabId);
    if (index === -1) return false;
    const tab = shellTabs[index];
    if (confirm) return requestTabCloseConfirmation(tab, 'shell', () =>
        shellTabs.includes(tab) && !tab.closed ? closeShellTab(tabId, { confirm: false }) : false);
    const fallbackTabId = getGroupActiveTabId(activeGroupId, mainTabId(activeGroupId));
    if (workspaceModel && !dispatchWorkspaceAction({ type: 'close', tabId, fallbackTabId }).ok) return false;
    tab.closed = true;
    if (tab.sessionCreateTimer !== null) {
        clearTimeout(tab.sessionCreateTimer);
        tab.sessionCreateTimer = null;
    }
    ipcRenderer.send('flush-tab-log', { tabId });
    unobserveTerminalSearchChanges(tab.term);
    tab.term.dispose();
    tab.element.remove();
    tab.btn.remove();
    shellTabs.splice(index, 1);
    ipcRenderer.send('close-shell-tab-session', { tabId });
    // 模型 close 事务已处理真实成员和焦点；业务对象只负责释放终端/PTY。
    if (focusedWorkspaceTabId === tabId) focusedWorkspaceTabId = null;
    persistShellTabs();
    updateTabTitles();
    // 独立列是否还存在、要不要拆，全由 renderWorkspace 按 plan 决定。
    renderWorkspaceNow();
    // 启动兼容路径没有模型时才补回退；活动模型已在 close 事务内选择。
    if (!workspaceModel && !focusedWorkspaceTabId) {
        const fallbackTabId = mainTabId(activeGroupId);
        if (document.getElementById(fallbackTabId)) setFocusedTab(fallbackTabId);
    }
    persistWorkspaceLayout();
    setActionStatus(tr('main.shellClosed'));
    return true;
}

function restoreShellSessions() {
    shellTabs.forEach(tab => {
        tab.mouseModeSequenceCarry = '';
        invalidateTerminalSearch(tab.term, 'reset', { clearAnchor: true });
        tab.term.reset();
        tab.term.writeln(`\r\n[${tr('main.shellStarting')}]\r\n`);
        ipcRenderer.invoke('create-shell-tab-session', { tabId: tab.id, cols: tab.term.cols, rows: tab.term.rows, profileId: tab.profileId || '' })
            .then(() => {
                tab.sessionReady = true;
                ipcRenderer.send('resize-shell-tab', { tabId: tab.id, cols: tab.term.cols, rows: tab.term.rows });
            })
            .catch((error) => {
                tab.term.writeln(`\r\n[ERROR] ${tr('main.shellStartFailed', { error: error?.message || error })}\r\n`);
            });
    });
}

function createFilterTab(initialState = {}, targetPaneId = null) {
    const tabId = typeof initialState.id === 'string' && initialState.id ? initialState.id : `tab-filter-${getNextTabId()}`;
    syncNextFilterTabId(tabId);
    const resolvedPaneId = targetPaneId || initialState.paneId || getActivePane()?.id || 'pane-1';
    const ownerGroupId = groupIdFromPaneId(resolvedPaneId) || activeGroupId;
    const owningTabs = filterTabsStore.getList(ownerGroupId);
    
    // 1. Create Tab Button
    const tabList = getPaneTabsList(resolvedPaneId);
    const tabBtn = document.createElement('button');
    tabBtn.className = 'main-tab';
    tabBtn.type = 'button';
    tabBtn.setAttribute('role', 'tab');
    tabBtn.setAttribute('aria-selected', 'false');
    tabBtn.id = `${tabId}-button`;
    tabBtn.setAttribute('aria-controls', tabId);
    tabBtn.dataset.target = tabId;
    tabBtn.dataset.paneId = resolvedPaneId;
    
    // The initial title will be updated by updateTabTitles() right after
    const filterTitle = document.createElement('span');
    filterTitle.className = 'main-tab-title';
    filterTitle.textContent = tr('main.filter');
    const filterClose = document.createElement('span');
    filterClose.className = 'main-tab-close';
    filterClose.title = tr('main.closeTab');
    filterClose.appendChild(createMaterialIcon('close'));
    tabBtn.append(filterTitle, filterClose);
    
    tabBtn.onclick = (e) => {
        if (e.target.closest('.main-tab-close')) return;
        switchPaneTab(tabBtn.dataset.paneId || getPaneIdForTabId(tabId), tabId);
    };
    tabBtn.ondblclick = (e) => {
        if (!e.target.closest('.main-tab-close')) {
            const tabState = owningTabs.find(tab => tab.id === tabId);
            if (tabState) openRenameTabDialog(tabState);
        }
    };
    
    tabBtn.querySelector('.main-tab-close').onclick = () => {
        closeFilterTab(tabId);
    };
    
    tabList.appendChild(tabBtn);
    
    // 2. Create Tab Pane
    const tabContent = getPaneTabsContent(resolvedPaneId);
    const tabPane = document.createElement('div');
    tabPane.className = 'main-tab-pane';
    tabPane.id = tabId;
    tabPane.setAttribute('role', 'tabpanel');
    tabPane.setAttribute('aria-labelledby', tabBtn.id);
    tabPane.dataset.paneId = resolvedPaneId;
    
    const filterHeader = document.createElement('div');
    filterHeader.className = "filter-header";
    filterHeader.innerHTML = `
        <div class="filter-input-wrapper">
            <input type="text" class="filter-input" placeholder="${tr('main.filterText')}" style="width: 100%; padding-right: 24px;">
            <button type="button" class="filter-dropdown-btn" title="${tr('main.sendHistory')}"><span class="material-icon-placeholder" data-material-icon="arrow_drop_down"></span></button>
            <div class="filter-history-dropdown"></div>
        </div>
        <div class="filter-toggles" style="display: flex; gap: 4px; margin-right: 8px;">
            <button type="button" class="filter-toggle-btn filter-case-btn" title="${tr('main.matchCase')}"><span class="material-icon-placeholder" data-material-icon="match_case"></span></button>
            <button type="button" class="filter-toggle-btn filter-word-btn" title="${tr('main.wholeWord')}"><span class="material-icon-placeholder" data-material-icon="match_word"></span></button>
            <button type="button" class="filter-toggle-btn filter-regex-btn" title="${tr('main.useRegex')}"><span class="material-icon-placeholder" data-material-icon="regular_expression"></span></button>
            <button type="button" class="filter-toggle-btn filter-sent-only-btn" title="${trFallback('main.showSentOnly', 'Only show sent data')}"><span class="material-icon-placeholder" data-material-icon="send"></span></button>
        </div>
        <span class="filter-mode-status" role="status"></span>
    `;
    window.MaterialIcons.upgrade(filterHeader);
    
    const terminalWrapper = document.createElement('div');
    terminalWrapper.className = 'terminal-wrapper';
    terminalWrapper.id = `terminal-${tabId}`;
    
    tabPane.appendChild(filterHeader);
    tabPane.appendChild(terminalWrapper);
    tabContent.appendChild(tabPane);
    
    // 3. Initialize Terminal
    const term = new Terminal({
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: true,
        scrollback: currentConfig ? (currentConfig.scrollbackLimit || 20000) : 20000
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    enableTerminalUnicode11(term);
    term.open(terminalWrapper);
    observeTerminalSearchChanges(term);
    
    if (currentConfig) {
        term.options = {
            fontSize: currentConfig.fontSize,
            fontWeight: currentConfig.fontWeight,
            fontFamily: TERMINAL_FONT_FAMILY(currentConfig),
            theme: getTerminalTheme(currentConfig)
        };
    }
    
    // 4. Setup State and Events
    const tabState = {
        id: tabId,
        paneId: resolvedPaneId,
        term,
        fitAddon,
        searchAddon,
        filterRegex: null,
        title: initialState.title || '',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
        filterText: '',
        // 未指定数据模式时跟随激活分组：过滤页新建时用户正在看哪个分组，
        // 就按那个分组的显示模式。
        dataMode: initialState.dataMode === 'hex' ? 'hex' : (initialState.dataMode === 'text' ? 'text' : getGroupDisplay(activeGroupId).receiveDisplayMode),
        contextLine: null,
        contextLine: null,
        showSentOnly: initialState.showSentOnly === true,
        element: tabPane,
        btn: tabBtn
    };
    
    const input = filterHeader.querySelector('.filter-input');
    const dropdownBtn = filterHeader.querySelector('.filter-dropdown-btn');
    const caseBtn = filterHeader.querySelector('.filter-case-btn');
    const wordBtn = filterHeader.querySelector('.filter-word-btn');
    const regexBtn = filterHeader.querySelector('.filter-regex-btn');
    const sentOnlyBtn = filterHeader.querySelector('.filter-sent-only-btn');
    const dropdownMenu = filterHeader.querySelector('.filter-history-dropdown');
    const modeStatus = filterHeader.querySelector('.filter-mode-status');
    tabState.modeStatus = modeStatus;

    input.addEventListener('focus', () => {
        suppressMainInputFocus = true;
    });

    input.addEventListener('blur', () => {
        setTimeout(() => {
            suppressMainInputFocus = document.activeElement?.classList?.contains('filter-input') === true;
        }, 0);
    });
    
    // History dropdown logic
    function renderDropdown() {
        const history = currentConfig ? (currentConfig.filterHistory || []) : [];
        dropdownMenu.innerHTML = '';
        
        if (history.length === 0) {
            dropdownMenu.innerHTML = `<div class="filter-history-item" style="color: #666; cursor: default;">${tr('common.noHistory')}</div>`;
            return;
        }
        
        history.forEach(item => {
            const div = document.createElement('div');
            div.className = 'filter-history-item';
            div.textContent = item;
            div.onclick = () => {
                input.value = item;
                updateRegex();
                dropdownMenu.classList.remove('open');
            };
            dropdownMenu.appendChild(div);
        });
    }

    dropdownBtn.onclick = (e) => {
        e.stopPropagation();
        const isShowing = dropdownMenu.classList.contains('open');

        // Hide all other dropdowns
        document.querySelectorAll('.filter-history-dropdown').forEach(d => d.classList.remove('open'));

        if (!isShowing) {
            renderDropdown();
            dropdownMenu.classList.add('open');
        }
    };

    const outsideClickListener = (e) => {
        if (!filterHeader.contains(e.target)) {
            dropdownMenu.classList.remove('open');
        }
    };
    
    // Close dropdown when clicking outside
    document.addEventListener('click', outsideClickListener);

    // Store listener to remove it later
    tabState.outsideClickListener = outsideClickListener;

    // Case Match Button Logic
    caseBtn.onclick = (e) => {
        e.stopPropagation();
        tabState.caseSensitive = !tabState.caseSensitive;
        if (tabState.caseSensitive) {
            caseBtn.classList.add('active');
        } else {
            caseBtn.classList.remove('active');
        }
        updateRegex();
    };

    wordBtn.onclick = (e) => {
        e.stopPropagation();
        tabState.wholeWord = !tabState.wholeWord;
        wordBtn.classList.toggle('active', tabState.wholeWord);
        updateRegex();
    };

    // Regex Button Logic
    regexBtn.onclick = (e) => {
        e.stopPropagation();
        tabState.useRegex = !tabState.useRegex;
        if (tabState.useRegex) {
            regexBtn.classList.add('active');
        } else {
            regexBtn.classList.remove('active');
        }
        updateRegex();
    };

    // “仅显示发送内容”：开启后本标签页只接收发送回显，不再接收串口数据，
    // 便于把它当成发送历史面板使用；同时暂停接收模式徽标的提示。
    function applySentOnlyMode(enabled) {
        tabState.showSentOnly = enabled;
        sentOnlyBtn.classList.toggle('active', enabled);
        tabPane.classList.toggle('sent-only', enabled);
        if (tabState.modeStatus) tabState.modeStatus.textContent = enabled
            ? trFallback('main.sentOnly', 'SENT')
            : tabState.dataMode.toUpperCase();
    }

    sentOnlyBtn.onclick = (e) => {
        e.stopPropagation();
        applySentOnlyMode(!tabState.showSentOnly);
        persistFilterTabs({ groupId: ownerGroupId });
    };

    tabState.sentOnlyBtn = sentOnlyBtn;
    tabState.applySentOnlyMode = applySentOnlyMode;

    function updateRegex() {
        tabState.filterText = input.value;
        if (!input.value) {
            tabState.filterRegex = null;
            input.style.borderColor = 'var(--border-color)';
            persistFilterTabs({ groupId: ownerGroupId });
            return;
        }
        try {
            const flags = tabState.caseSensitive ? '' : 'i';
            let pattern = input.value;
            if (!tabState.useRegex) {
                // Escape regex characters if regex mode is off
                pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
            if (tabState.wholeWord) {
                pattern = `\\b(?:${pattern})\\b`;
            }
            tabState.filterRegex = new RegExp(pattern, flags);
            input.style.borderColor = 'var(--border-color)';
        } catch (e) {
            tabState.filterRegex = null;
            input.style.borderColor = 'var(--danger-color)';
        }
        persistFilterTabs({ debounce: true, groupId: ownerGroupId });
    }

    tabState.updateRegex = updateRegex;
    tabState.caseBtn = caseBtn;
    tabState.wordBtn = wordBtn;
    tabState.regexBtn = regexBtn;
    
    function saveFilterHistory(val) {
        if (!val) return;
        let history = currentConfig.filterHistory || [];
        // Remove if exists to move it to the top
        history = history.filter(item => item !== val);
        history.unshift(val);
        // Keep max 20
        if (history.length > 20) history = history.slice(0, 20);
        
        currentConfig.filterHistory = history;
        ipcRenderer.send('save-config', { filterHistory: history });
    }

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            updateRegex();
            saveFilterHistory(input.value.trim());
            dropdownMenu.classList.remove('open');
        }
    });

    input.addEventListener('blur', () => {
        // Save on blur if there's text
        if (input.value.trim()) {
            saveFilterHistory(input.value.trim());
        }
    });
    
    input.addEventListener('input', updateRegex);
    
    // Setup copy/paste for filter terminal
    term.attachCustomKeyEventHandler(createTerminalKeyHandler(term, 'serial'));
    bindTerminalContextMenu({
        terminalType: 'filter',
        term,
        element: terminalWrapper,
        getTabState: () => tabState
    });
    bindTerminalWheel(term, terminalWrapper);

    if (typeof initialState.filterText === 'string') {
        input.value = initialState.filterText;
    }
    if (initialState.caseSensitive) {
        tabState.caseSensitive = true;
        caseBtn.classList.add('active');
    }
    if (initialState.wholeWord) {
        tabState.wholeWord = true;
        wordBtn.classList.add('active');
    }
    if (initialState.useRegex) {
        tabState.useRegex = true;
        regexBtn.classList.add('active');
    }
    updateRegex();
    applySentOnlyMode(tabState.showSentOnly);
    
    owningTabs.push(tabState);
    updateTabTitles();
    updateFilterModeStatuses();
    addTabToOwningGroupPane(tabId, resolvedPaneId, { activate: false, persist: false });
    if (!isRestoringWorkspaceSession) {
        switchPaneTab(resolvedPaneId, tabId, { persist: false });
        persistFilterTabs({ groupId: ownerGroupId });
        persistGroupWorkspaceLayout(ownerGroupId);
        setActionStatus(`已创建过滤标签页：${tabBtn.textContent.trim()}`);
    }
    
    // Fit terminal after a short delay to ensure DOM is rendered
    tabState.fitTimer = setTimeout(() => {
        tabState.fitTimer = null;
        if (!tabState.closed) fitAddon.fit();
    }, 50);
}

function destroyFilterTab(tab) {
    if (tab.closed) return;
    tab.closed = true;
    const cleanup = [
        () => { if (tab.fitTimer != null) clearTimeout(tab.fitTimer); },
        () => ipcRenderer.send('flush-tab-log', { tabId: tab.id }),
        () => unobserveTerminalSearchChanges(tab.term),
        () => { if (tab.outsideClickListener) document.removeEventListener('click', tab.outsideClickListener); },
        () => tab.term.dispose(), () => tab.element.remove(), () => tab.btn.remove()
    ];
    cleanup.forEach(release => {
        try { release(); } catch (error) { console.error(`Failed to destroy filter ${tab.id}:`, error); }
    });
}

function clearSerialGroupAsyncState(groupId) {
    serialConnectRequests.delete(groupId);
    serialConnectionSessions.delete(groupId);
    serialWriteChains.delete(groupId);
    serialConnectingGroups.delete(groupId);
    serialReconnectingGroups.delete(groupId);
    resetQuickTriggerReceive(groupId);
    const waiters = serialDisconnectWaiters.get(groupId);
    serialDisconnectWaiters.delete(groupId);
    waiters?.forEach(resolve => resolve(false));
}

function destroySerialGroupResources(groupId) {
    if (serialRuntimes.get(groupId)) {
        if (getGroupDisplay(groupId).receiveDisplayMode === 'hex') getHexFormatter(groupId).flush();
        else flushTextReceive(groupId);
    }
    filterTabsStore.getList(groupId).forEach(destroyFilterTab);
    chartTabsStore.getList(groupId).forEach(destroyChartTab);
    filterTabsStore.getList(groupId).length = 0;
    chartTabsStore.getList(groupId).length = 0;
    ipcRenderer.send('flush-tab-log', { tabId: mainTabId(groupId) });
    clearSerialGroupAsyncState(groupId);
    if (groupId !== REGISTRY_DEFAULT_GROUP_ID) serialInputBoundGroups.delete(groupId);
}

function closeFilterTab(tabId, { confirm = true } = {}) {
    const groupId = groupIdForWorkspaceTab(tabId) || activeGroupId;
    const tabs = filterTabsStore.getList(groupId);
    const index = tabs.findIndex(t => t.id === tabId);
    if (index < 0) return false;
    const tab = tabs[index];
    if (confirm) return requestTabCloseConfirmation(tab, 'filter', () =>
        filterTabsStore.getList(groupId).includes(tab) && !tab.closed ? closeFilterTab(tabId, { confirm: false }) : false);
    destroyFilterTab(tab);
    tabs.splice(index, 1);
    getGroupWorkspaceManager(groupId).removeTab(tabId, { fallbackTabId: mainTabId(groupId), persist: false });
    persistFilterTabs({ groupId });
    updateTabTitles();
    persistGroupWorkspaceLayout(groupId);
    setActionStatus('已关闭过滤标签页');
    return true;
}

const persistFilterTabsTimers = new Map();

function serializeFilterTab(tab) {
    return { id: tab.id, title: tab.title || '', filterText: tab.filterText || '',
        caseSensitive: tab.caseSensitive, wholeWord: tab.wholeWord, useRegex: tab.useRegex,
        dataMode: tab.dataMode, showSentOnly: tab.showSentOnly === true,
        paneId: workspaceModel ? getTabPaneId(tab.id) : tab.paneId || getTabPaneId(tab.id) };
}

function persistFilterTabs({ debounce = false, groupId = activeGroupId } = {}) {
    if (isApplyingConfig) return;
    if (workspaceModel) { scheduleWorkspaceLayoutSave(); return; }
    const id = normalizeGroupId(groupId);
    const save = () => {
        persistFilterTabsTimers.delete(id);
        if (!serialGroups.some(group => group.id === id)) return;
        const savedTabs = filterTabsStore.getList(id).map(tab => ({
            id: tab.id,
            title: tab.title || '',
            filterText: tab.filterText || '',
            caseSensitive: tab.caseSensitive,
            wholeWord: tab.wholeWord,
            useRegex: tab.useRegex,
            dataMode: tab.dataMode,
            showSentOnly: tab.showSentOnly === true,
            paneId: tab.paneId || getTabPaneId(tab.id)
        }));
        // 顶层 filterTabs 仅是默认组的兼容镜像。
        const target = serialGroups.find(group => group && group.id === id);
        if (target) target.filterTabs = savedTabs;
        if (currentConfig && id === REGISTRY_DEFAULT_GROUP_ID) currentConfig.filterTabs = savedTabs;
        ipcRenderer.send('save-config', { serialGroups, ...(id === REGISTRY_DEFAULT_GROUP_ID ? { filterTabs: savedTabs } : {}) });
    };
    if (persistFilterTabsTimers.has(id)) {
        clearTimeout(persistFilterTabsTimers.get(id));
        persistFilterTabsTimers.delete(id);
    }
    if (debounce) {
        persistFilterTabsTimers.set(id, setTimeout(save, 250));
        return;
    }
    save();
}

function updateShellTextMode(tabState) {
    if (!tabState?.btn) return;
    tabState.btn.classList.toggle('shell-text-mode', Boolean(tabState.textMode));
    tabState.btn.title = tabState.textMode ? tr('main.shellTextModeEnabled') : '';
    updateTabTitles();
}

const chartSettingsDialog = document.getElementById('chart-settings-dialog');
const chartParserMode = document.getElementById('chart-parser-mode');
const chartEncoding = document.getElementById('chart-encoding');
const chartLineMarker = document.getElementById('chart-line-marker');
const chartKeySeparator = document.getElementById('chart-key-separator');
const chartTemplateInput = document.getElementById('chart-template-input');
const chartRegexInput = document.getElementById('chart-regex-input');
const chartSampleLine = document.getElementById('chart-sample-line');
const chartSampleStatus = document.getElementById('chart-sample-status');
const chartFieldsList = document.getElementById('chart-fields-list');
const chartFieldsToggle = document.getElementById('chart-fields-toggle');
const chartFieldsSelectedCount = document.getElementById('chart-fields-selected-count');
const chartYAxisMode = document.getElementById('chart-y-axis-mode');
const chartYMin = document.getElementById('chart-y-min');
const chartYMax = document.getElementById('chart-y-max');
const chartYMargin = document.getElementById('chart-y-margin');
const chartYIncludeZero = document.getElementById('chart-y-include-zero');
const chartWindowDuration = document.getElementById('chart-window-duration');
const chartMaxPoints = document.getElementById('chart-max-points');
const chartMaxDuration = document.getElementById('chart-max-duration');
const chartParsingGuideDialog = document.getElementById('chart-parsing-guide-dialog');
const chartParsingGuideOpen = document.getElementById('chart-parsing-guide-open');
const chartParsingGuideClose = document.getElementById('chart-parsing-guide-close');
const chartParsingGuideDone = document.getElementById('chart-parsing-guide-done');
const chartExportDialog = document.getElementById('chart-export-dialog');
const chartExportStatus = document.getElementById('chart-export-status');
const chartExportWindow = document.getElementById('chart-export-window');
const chartExportAll = document.getElementById('chart-export-all');
let chartSettingsState = null;
let chartExportState = null;
let chartParsingGuideTrigger = null;

function serializeChartTab(tab) {
    return {
        id: tab.id,
        paneId: workspaceModel ? getTabPaneId(tab.id) : tab.paneId || getTabPaneId(tab.id),
        title: tab.title || '',
        encoding: tab.encoding || 'utf8',
        parserMode: tab.parserMode || 'key-value',
        sampleLine: tab.sampleLine || '',
        lineMarker: tab.lineMarker || '',
        keyValueSeparator: ['=', ':', 'auto'].includes(tab.keyValueSeparator) ? tab.keyValueSeparator : 'auto',
        template: tab.template || '',
        pattern: tab.pattern || '',
        fields: (tab.fields || []).map(field => ({ ...field })),
        windowDurationMs: tab.windowDurationMs || 60000,
        maxPoints: tab.maxPoints || 200000,
        maxDurationMs: tab.maxDurationMs || 1800000,
        yAxisMode: tab.yAxisMode === 'fixed' ? 'fixed' : 'auto',
        yMin: tab.yMin,
        yMax: tab.yMax,
        yIncludeZero: tab.yIncludeZero === true,
        yMargin: tab.yMargin ?? 0.08
    };
}

function updateChartStats(tab) {
    if (!tab.stats || !tab.model || !tab.view?.viewRange) return;
    const [start, end] = tab.view.viewRange;
    const estimated = tab.summaryHistory;
    tab.stats.replaceChildren();
    tab.model.fields.forEach(field => {
        const stats = estimated ? tab.model.overviewStats(field.key, start, end) : tab.model.stats(field.key, start, end);
        if (!stats) return;
        const precision = field.precision ?? 2;
        const unit = field.displayUnit ? ` ${field.displayUnit}` : '';
        const item = document.createElement('span');
        item.className = 'chart-series-stat';
        item.innerHTML = `<span class="chart-series-swatch"></span><strong></strong> cur ${Number(stats.current).toFixed(precision)}${unit} · min ${Number(stats.min).toFixed(precision)} · max ${Number(stats.max).toFixed(precision)} · avg ${Number(stats.average).toFixed(precision)}`;
        item.querySelector('.chart-series-swatch').style.backgroundColor = field.color;
        item.querySelector('strong').textContent = field.label || field.key;
        tab.stats.appendChild(item);
    });
    if (estimated) {
        const note = document.createElement('span');
        note.className = 'chart-stats-estimated';
        note.textContent = tr('main.chartStatsEstimated');
        tab.stats.appendChild(note);
    }
}

function clearChartDataSession(tab) {
    tab.stream?.reset();
    tab.parserWorker?.reset();
    tab.parserError = '';
    tab.parserDropped = 0;
    tab.summaryHistory = false;
    tab.model?.clear();
    tab.stats?.replaceChildren();
    tab.view?.setData([[], ...(tab.model?.fields || []).map(() => [])]);
    updateChartStatus(tab);
}

function closeChartExport() {
    chartExportState = null;
    chartExportDialog.classList.add('hidden');
}

function openChartExport(tab) {
    if (!tab.model?.samples.length) {
        setActionStatus(tr('main.chartNoExportData'));
        return;
    }
    chartExportState = tab;
    const range = tab.view?.viewRange;
    const windowSamples = range ? tab.model.query(range[0], range[1]) : [];
    chartExportWindow.disabled = windowSamples.length === 0;
    chartExportAll.disabled = tab.model.samples.length === 0;
    chartExportStatus.textContent = windowSamples.length
        ? tr('main.chartExportWindowCount', { count: windowSamples.length }) + (tab.summaryHistory ? tr('main.chartExportSummaryWarning') : '')
        : tr('main.chartExportNoWindowData');
    chartExportDialog.classList.remove('hidden');
    (chartExportWindow.disabled ? chartExportAll : chartExportWindow).focus();
}

async function exportChartSamples(scope, targetTab = chartExportState) {
    const tab = targetTab;
    if (!tab?.model) return;
    const range = tab.view?.viewRange;
    const samples = scope === 'window' && range ? tab.model.query(range[0], range[1]) : tab.model.samples;
    if (!samples.length) return;
    const suffix = scope === 'window' ? tr('main.chartExportWindow') : tr('main.chartExportAll');
    const result = await ipcRenderer.invoke('save-chart-csv', {
        title: `${tab.title || tr('main.chart')} ${suffix}`,
        content: buildChartCsv(samples, tab.model.fields)
    });
    if (result?.filePath) setActionStatus(`${tr('main.chartExported')}: ${result.filePath}`);
    if (tab === chartExportState) closeChartExport();
}

function persistChartTabs(groupId = activeGroupId) {
    if (isApplyingConfig) return;
    if (workspaceModel) { scheduleWorkspaceLayoutSave(); return; }
    const id = normalizeGroupId(groupId);
    const savedTabs = chartTabsStore.getList(id).map(serializeChartTab);
    const target = serialGroups.find(group => group && group.id === id);
    if (target) target.chartTabs = savedTabs;
    if (currentConfig && id === REGISTRY_DEFAULT_GROUP_ID) currentConfig.chartTabs = savedTabs;
    ipcRenderer.send('save-config', { serialGroups, ...(id === REGISTRY_DEFAULT_GROUP_ID ? { chartTabs: savedTabs } : {}) });
}

function getChartParserConfig(tab) {
    return {
        mode: tab.parserMode,
        marker: tab.lineMarker,
        keyValueSeparator: tab.keyValueSeparator,
        template: tab.template,
        pattern: tab.pattern,
        fields: tab.fields
    };
}

function updateChartStatus(tab) {
    if (!tab.status) return;
    tab.status.classList.toggle('error', Boolean(tab.parserError));
    if (tab.parserError) {
        tab.status.textContent = tab.parserError;
        return;
    }
    if (tab.paused) {
        tab.status.textContent = tr('main.chartPaused');
        return;
    }
    if (!tab.fields?.some(field => field.role === 'series' && field.visible !== false)) {
        tab.status.textContent = tr('main.chartNoFields');
        return;
    }
    if (!tab.model?.samples.length) {
        tab.status.textContent = tr('main.chartWaiting');
        return;
    }
    const details = [`${tab.model.samples.length.toLocaleString()} ${tr('main.chartSamples')}`];
    if (tab.parserDropped) details.push(`${tab.parserDropped.toLocaleString()} ${tr('main.chartDropped')}`);
    if (tab.summaryHistory) details.push(tr('main.chartSummaryHistory'));
    tab.status.textContent = details.join(' · ');
}

function toggleChartPaused(tab) {
    tab.paused = !tab.paused;
    tab.stream?.reset();
    tab.parserWorker?.reset();
    tab.parserError = '';
    tab.parserDropped = 0;
    tab.pauseButton.title = tr(tab.paused ? 'main.chartResume' : 'main.chartPause');
    tab.pauseButton.replaceChildren(createMaterialIcon(tab.paused ? 'play_arrow' : 'pause'));
    updateChartStatus(tab);
}

function updateChartLiveLock(tab, locked) {
    tab.liveLocked = locked === true;
    if (!tab.lockButton) return;
    tab.lockButton.classList.toggle('active', tab.liveLocked);
    tab.lockButton.setAttribute('aria-pressed', tab.liveLocked ? 'true' : 'false');
    tab.lockButton.title = tr(tab.liveLocked ? 'main.chartUnlockLive' : 'main.chartLockLive');
    tab.lockButton.replaceChildren(createMaterialIcon(tab.liveLocked ? 'lock' : 'lock_open'));
}

function toggleChartLiveLock(tab) {
    if (!tab.view) return;
    tab.view.setLocked(!tab.view.locked);
}

function scheduleChartRender(tab) {
    if (!tab || tab.closed || tab.renderFrame !== null || !isTabActive(tab.id)) return;
    tab.renderFrame = requestAnimationFrame(() => {
        tab.renderFrame = null;
        if (!tab.view || !tab.model) return;
        tab.view.setData(tab.model.toAlignedData(), tab.model.toOverviewAlignedData());
        updateChartStatus(tab);
        updateChartStats(tab);
    });
}

function configureChartTab(tab) {
    tab.stream?.dispose();
    tab.parserWorker?.close();
    tab.view?.destroy();
    tab.plotArea.replaceChildren();
    tab.timelineHost.replaceChildren();
    tab.model = null;
    tab.parserWorker = null;
    tab.view = null;
    tab.parserError = '';
    tab.parserDropped = 0;
    tab.summaryHistory = false;
    const activeFields = (tab.fields || []).filter(field => field.role === 'sequence' || field.visible !== false);
    if (!activeFields.some(field => field.role !== 'sequence')) {
        updateChartStatus(tab);
        return;
    }
    tab.status.classList.remove('error');
    tab.model = new ChartDataModel({ fields: activeFields, maxPoints: tab.maxPoints, maxDurationMs: tab.maxDurationMs });
    tab.parserWorker = new ChartParserIpcClient({
        config: { ...getChartParserConfig(tab), fields: activeFields },
        onSamples: samples => {
            if (tab.closed) return;
            tab.parserError = '';
            let changed = false;
            samples.forEach(sample => { if (tab.model?.append(sample)) changed = true; });
            if (changed) scheduleChartRender(tab);
            else updateChartStatus(tab);
        },
        onError: error => {
            if (tab.closed) return;
            tab.parserError = error.message;
            updateChartStatus(tab);
        },
        onStats: stats => {
            tab.parserDropped = stats.dropped;
            updateChartStatus(tab);
        }
    });
    tab.stream = new SerialTextStream({
        encoding: tab.encoding,
        onRecord: record => {
            if (tab.closed || tab.paused || record.partial) return;
            tab.parserWorker?.push(record);
        }
    });
    tab.view = new ChartView({
        uPlot,
        mainHost: tab.plotArea,
        timelineHost: tab.timelineHost,
        navigator: tab.navigator,
        fields: activeFields,
        windowDurationMs: tab.windowDurationMs,
        yAxis: { mode: tab.yAxisMode, min: tab.yMin, max: tab.yMax, includeZero: tab.yIncludeZero, margin: tab.yMargin },
        locked: tab.liveLocked,
        onFollowChange: following => tab.liveButton.classList.toggle('hidden', following),
        onLockChange: locked => updateChartLiveLock(tab, locked),
        onDataModeChange: summaryHistory => {
            tab.summaryHistory = summaryHistory;
            updateChartStatus(tab);
        },
        onViewRangeChange: () => updateChartStats(tab)
    });
    updateChartLiveLock(tab, tab.liveLocked);
    updateChartStatus(tab);
}

function createChartTab(initialState = {}, targetPaneId = null) {
    const tabId = typeof initialState.id === 'string' && initialState.id ? initialState.id : `tab-chart-${getNextChartTabId()}`;
    syncNextChartTabId(tabId);
    const resolvedPaneId = targetPaneId || initialState.paneId || getActivePane()?.id || 'pane-1';
    const ownerGroupId = groupIdFromPaneId(resolvedPaneId) || activeGroupId;
    const tabBtn = document.createElement('button');
    tabBtn.className = 'main-tab';
    tabBtn.type = 'button';
    tabBtn.id = `${tabId}-button`;
    tabBtn.setAttribute('role', 'tab');
    tabBtn.setAttribute('aria-controls', tabId);
    tabBtn.setAttribute('aria-selected', 'false');
    tabBtn.dataset.target = tabId;
    tabBtn.dataset.paneId = resolvedPaneId;
    const title = document.createElement('span');
    title.className = 'main-tab-title';
    title.textContent = tr('main.chart');
    const close = document.createElement('span');
    close.className = 'main-tab-close';
    close.title = tr('main.closeTab');
    close.appendChild(createMaterialIcon('close'));
    tabBtn.append(title, close);
    getPaneTabsList(resolvedPaneId).appendChild(tabBtn);

    const tabPane = document.createElement('div');
    tabPane.className = 'main-tab-pane chart-tab';
    tabPane.id = tabId;
    tabPane.setAttribute('role', 'tabpanel');
    tabPane.setAttribute('aria-labelledby', tabBtn.id);
    tabPane.dataset.paneId = resolvedPaneId;
    tabPane.innerHTML = `
        <div class="chart-toolbar">
            <div class="chart-status" role="status"></div>
            <div class="chart-toolbar-actions">
                <button class="secondary chart-settings-btn" type="button" title="${tr('main.chartSettings')}"><span class="material-icon-placeholder" data-material-icon="settings"></span></button>
                <button class="secondary chart-pause-btn" type="button" title="${tr('main.chartPause')}"><span class="material-icon-placeholder" data-material-icon="pause"></span></button>
                <button class="secondary chart-clear-btn" type="button" title="${tr('main.chartClear')}"><span class="material-icon-placeholder" data-material-icon="delete_sweep"></span></button>
                <button class="secondary chart-export-btn" type="button" title="${tr('main.chartExport')}"><span class="material-icon-placeholder" data-material-icon="save"></span></button>
                <button class="secondary chart-lock-btn" type="button" title="${tr('main.chartLockLive')}"><span class="material-icon-placeholder" data-material-icon="lock_open"></span></button>
                <button class="secondary chart-live-btn hidden" type="button"><span class="material-icon-placeholder" data-material-icon="update"></span><span>${tr('main.chartLive')}</span></button>
            </div>
        </div>
        <div class="chart-series-stats"></div>
        <div class="chart-main-host"></div>
        <div class="chart-timeline-shell">
            <div class="chart-timeline-host"></div>
            <div class="chart-navigator"><div class="chart-navigator-window" role="slider" tabindex="0" aria-label="Chart time window" hidden><span class="chart-navigator-handle start"></span><span class="chart-navigator-handle end"></span></div></div>
        </div>`;
    window.MaterialIcons.upgrade(tabPane);
    getPaneTabsContent(resolvedPaneId).appendChild(tabPane);

    const tab = {
        id: tabId, paneId: resolvedPaneId, title: initialState.title || '', element: tabPane, btn: tabBtn,
        encoding: initialState.encoding || receiveEncoding || 'utf8', parserMode: initialState.parserMode || 'key-value',
        sampleLine: initialState.sampleLine || '', lineMarker: initialState.lineMarker || '',
        keyValueSeparator: ['=', ':', 'auto'].includes(initialState.keyValueSeparator) ? initialState.keyValueSeparator : 'auto', template: initialState.template || '', pattern: initialState.pattern || '',
        fields: Array.isArray(initialState.fields) ? initialState.fields.map(field => ({ ...field })) : [],
        windowDurationMs: initialState.windowDurationMs || 60000, maxPoints: initialState.maxPoints || 200000,
        maxDurationMs: initialState.maxDurationMs || 1800000, paused: false, closed: false, renderFrame: null,
        yAxisMode: initialState.yAxisMode === 'fixed' ? 'fixed' : 'auto', yMin: Number(initialState.yMin ?? 0), yMax: Number(initialState.yMax ?? 100),
        yIncludeZero: initialState.yIncludeZero === true, yMargin: Number(initialState.yMargin ?? 0.08),
        parserWorker: null, parserError: '', parserDropped: 0, summaryHistory: false,
        status: tabPane.querySelector('.chart-status'), stats: tabPane.querySelector('.chart-series-stats'), plotArea: tabPane.querySelector('.chart-main-host'),
        timelineHost: tabPane.querySelector('.chart-timeline-host'), navigator: tabPane.querySelector('.chart-navigator'),
        liveButton: tabPane.querySelector('.chart-live-btn'), pauseButton: tabPane.querySelector('.chart-pause-btn'), lockButton: tabPane.querySelector('.chart-lock-btn'), liveLocked: false
    };
    tabBtn.onclick = event => {
        if (!event.target.closest('.main-tab-close')) switchPaneTab(tabBtn.dataset.paneId || getPaneIdForTabId(tabId), tabId);
    };
    close.onclick = () => closeChartTab(tabId);
    tabBtn.ondblclick = event => { if (!event.target.closest('.main-tab-close')) openRenameTabDialog(tab); };
    tabPane.querySelector('.chart-settings-btn').onclick = () => openChartSettings(tab);
    tab.pauseButton.onclick = () => toggleChartPaused(tab);
    tabPane.querySelector('.chart-clear-btn').onclick = () => {
        clearChartDataSession(tab);
    };
    tabPane.querySelector('.chart-export-btn').onclick = () => openChartExport(tab);
    tab.liveButton.onclick = () => tab.view?.returnToLive();
    tab.lockButton.onclick = () => toggleChartLiveLock(tab);
    bindChartContextMenu(tab);

    chartTabsStore.getList(ownerGroupId).push(tab);
    updateTabTitles();
    addTabToOwningGroupPane(tabId, resolvedPaneId, { activate: false, persist: false });
    if (tab.fields.length) configureChartTab(tab);
    else updateChartStatus(tab);
    if (!isRestoringWorkspaceSession) {
        switchPaneTab(resolvedPaneId, tabId, { persist: false });
        persistChartTabs(ownerGroupId);
        persistGroupWorkspaceLayout(ownerGroupId);
        setTimeout(() => openChartSettings(tab), 0);
    }
    return tab;
}

function destroyChartTab(tab) {
    if (tab.closed) return;
    tab.closed = true;
    const cleanup = [
        () => { if (tab.renderFrame !== null) cancelAnimationFrame(tab.renderFrame); tab.renderFrame = null; },
        () => { if (chartSettingsState === tab) closeChartSettings(); },
        () => { if (chartExportState === tab) closeChartExport(); },
        () => tab.stream?.dispose(), () => tab.parserWorker?.close(), () => tab.view?.destroy(),
        () => tab.element.remove(), () => tab.btn.remove()
    ];
    cleanup.forEach(release => {
        try { release(); } catch (error) { console.error(`Failed to destroy chart ${tab.id}:`, error); }
    });
}

function closeChartTab(tabId, { confirm = true } = {}) {
    const groupId = groupIdForWorkspaceTab(tabId) || activeGroupId;
    const tabs = chartTabsStore.getList(groupId);
    const index = tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return false;
    const tab = tabs[index];
    if (confirm) return requestTabCloseConfirmation(tab, 'chart', () =>
        chartTabsStore.getList(groupId).includes(tab) && !tab.closed ? closeChartTab(tabId, { confirm: false }) : false);
    destroyChartTab(tab);
    tabs.splice(index, 1);
    getGroupWorkspaceManager(groupId).removeTab(tabId, { fallbackTabId: mainTabId(groupId), persist: false });
    persistChartTabs(groupId);
    updateTabTitles();
    persistGroupWorkspaceLayout(groupId);
    return true;
}

function renderChartFieldCandidates(fields) {
    chartFieldsList.replaceChildren();
    if (!fields.length) {
        const empty = document.createElement('div');
        empty.className = 'chart-fields-empty';
        empty.textContent = tr('main.chartNoFields');
        chartFieldsList.appendChild(empty);
        updateChartFieldSelectionState();
        return;
    }
    fields.forEach(field => {
        const row = document.createElement('div');
        row.className = 'chart-field-row';
        row.dataset.key = field.key;
        row.setAttribute('role', 'row');
        row.innerHTML = `<label class="chart-field-visible-cell"><input class="chart-field-visible" type="checkbox" ${field.visible ? 'checked' : ''}><span class="visually-hidden"></span></label>
            <span class="chart-field-key" role="cell"></span><input class="chart-field-label" type="text"><input class="chart-field-color" type="color">
            <span class="chart-field-value"></span><input class="chart-field-unit" type="text">
            <select class="chart-field-display-unit"><option value="">-</option><option value="us">us</option><option value="ms">ms</option><option value="s">s</option></select>
            <input class="chart-field-precision" type="number" min="0" max="8" title="${tr('main.chartPrecision')}">`;
        row.querySelector('.chart-field-key').textContent = field.key;
        row.querySelector('.chart-field-visible').setAttribute('aria-label', `${tr('main.chartFieldVisible')}: ${field.key}`);
        row.querySelector('.chart-field-value').textContent = String(field.sampleValue);
        row.querySelector('.chart-field-unit').value = field.sourceUnit || '';
        row.querySelector('.chart-field-label').value = field.label || field.key;
        row.querySelector('.chart-field-color').value = field.color || '#4fc3f7';
        row.querySelector('.chart-field-display-unit').value = field.displayUnit || '';
        row.querySelector('.chart-field-precision').value = field.precision ?? 2;
        row._field = field;
        chartFieldsList.appendChild(row);
    });
    updateChartFieldSelectionState();
}

function updateChartFieldSelectionState() {
    const checkboxes = Array.from(chartFieldsList.querySelectorAll('.chart-field-visible'));
    const selected = checkboxes.filter(checkbox => checkbox.checked).length;
    const selectable = Math.min(16, checkboxes.length);
    chartFieldsSelectedCount.textContent = tr('main.chartFieldsSelected', { count: selected, max: 16 });
    chartFieldsSelectedCount.classList.toggle('limit', selected >= 16);
    chartFieldsToggle.checked = selectable > 0 && selected === selectable;
    chartFieldsToggle.indeterminate = selected > 0 && selected < selectable;
    chartFieldsToggle.disabled = checkboxes.length === 0;
}

function mergeChartFieldPreferences(fields, savedFields = []) {
    const savedByKey = new Map(savedFields.map(field => [field.key, field]));
    return fields.map(field => {
        const saved = savedByKey.get(field.key);
        return saved ? { ...field, ...saved, sampleValue: field.sampleValue, type: field.type, sourceUnit: saved.sourceUnit || field.sourceUnit } : field;
    });
}

function readChartDialogConfig() {
    return {
        mode: chartParserMode.value,
        marker: chartLineMarker.value,
        keyValueSeparator: chartKeySeparator.value,
        template: chartTemplateInput.value,
        pattern: chartRegexInput.value
    };
}

function updateChartSettingsMode() {
    document.getElementById('chart-separator-group').classList.toggle('hidden', chartParserMode.value !== 'key-value');
    document.getElementById('chart-template-group').classList.toggle('hidden', chartParserMode.value !== 'template');
    document.getElementById('chart-regex-group').classList.toggle('hidden', chartParserMode.value !== 'regex');
    document.querySelectorAll('.chart-y-fixed').forEach(element => element.classList.toggle('hidden', chartYAxisMode.value !== 'fixed'));
    const fixedYAxis = chartYAxisMode.value === 'fixed';
    chartYMargin.disabled = fixedYAxis;
    chartYIncludeZero.disabled = fixedYAxis;
    chartYIncludeZero.closest('.chart-checkbox-setting')?.classList.toggle('disabled', fixedYAxis);
}

let chartDiscoveryTimer = null;
let chartDiscoveryRequest = 0;

async function discoverChartDialogFields() {
    const request = ++chartDiscoveryRequest;
    try {
        chartSampleStatus.textContent = tr('main.chartParsingSample');
        chartSampleStatus.className = 'input-validation';
        const fields = mergeChartFieldPreferences(
            await discoverChartFieldsInWorker(chartSampleLine.value, readChartDialogConfig()),
            chartSettingsState?.fields || []
        );
        if (request !== chartDiscoveryRequest || !chartSettingsState) return;
        renderChartFieldCandidates(fields);
        chartSampleStatus.textContent = fields.length ? tr('main.chartFieldsFound', { count: fields.length }) : tr('main.chartNoFields');
        chartSampleStatus.className = `input-validation ${fields.length ? 'valid' : 'invalid'}`;
    } catch (error) {
        if (request !== chartDiscoveryRequest || !chartSettingsState) return;
        renderChartFieldCandidates([]);
        chartSampleStatus.textContent = error.message;
        chartSampleStatus.className = 'input-validation invalid';
    }
}

function openChartSettings(tab) {
    if (!tab || tab.closed) return;
    chartDiscoveryRequest++;
    chartSettingsState = tab;
    chartParserMode.value = tab.parserMode;
    chartEncoding.value = tab.encoding;
    chartLineMarker.value = tab.lineMarker;
    chartKeySeparator.value = tab.keyValueSeparator;
    chartTemplateInput.value = tab.template;
    chartRegexInput.value = tab.pattern;
    chartSampleLine.value = tab.sampleLine;
    chartYAxisMode.value = tab.yAxisMode;
    chartYMin.value = tab.yMin;
    chartYMax.value = tab.yMax;
    chartYMargin.value = Math.round(tab.yMargin * 100);
    chartYIncludeZero.checked = tab.yIncludeZero;
    chartWindowDuration.value = Math.round(tab.windowDurationMs / 1000);
    chartMaxPoints.value = tab.maxPoints;
    chartMaxDuration.value = Math.round(tab.maxDurationMs / 60000);
    updateChartSettingsMode();
    if (tab.sampleLine) discoverChartDialogFields();
    else renderChartFieldCandidates(tab.fields || []);
    chartSettingsDialog.classList.remove('hidden');
    chartSampleLine.focus();
}

function closeChartSettings() {
    chartDiscoveryRequest++;
    clearTimeout(chartDiscoveryTimer);
    chartDiscoveryTimer = null;
    chartSettingsState = null;
    chartSettingsDialog.classList.add('hidden');
}

function openChartParsingGuide() {
    chartParsingGuideTrigger = document.activeElement;
    chartParsingGuideDialog.classList.remove('hidden');
    chartParsingGuideClose.focus();
}

function closeChartParsingGuide() {
    chartParsingGuideDialog.classList.add('hidden');
    chartParsingGuideTrigger?.focus();
    chartParsingGuideTrigger = null;
}

async function saveChartSettings() {
    const tab = chartSettingsState;
    if (!tab) return;
    const fields = Array.from(chartFieldsList.querySelectorAll('.chart-field-row')).map(row => {
        const field = row._field;
        const visible = row.querySelector('.chart-field-visible').checked;
        return {
            ...field,
            visible,
            role: field.role === 'sequence' && !visible ? 'sequence' : 'series',
            label: row.querySelector('.chart-field-label').value.trim() || field.key,
            color: row.querySelector('.chart-field-color').value,
            sourceUnit: row.querySelector('.chart-field-unit').value.trim(),
            displayUnit: row.querySelector('.chart-field-display-unit').value,
            precision: Math.max(0, Math.min(8, Number(row.querySelector('.chart-field-precision').value) || 0))
        };
    });
    const activeFields = fields.filter(field => field.role === 'series' && field.visible);
    const invalidUnit = activeFields.some(field => field.displayUnit && field.sourceUnit !== field.displayUnit && (!['us', 'ms', 's'].includes(field.sourceUnit) || !['us', 'ms', 's'].includes(field.displayUnit)));
    const yMin = Number(chartYMin.value);
    const yMax = Number(chartYMax.value);
    const invalidYAxis = chartYAxisMode.value === 'fixed' && (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMin >= yMax);
    if (!activeFields.length || activeFields.length > 16 || invalidUnit || invalidYAxis) {
        chartSampleStatus.textContent = !activeFields.length
            ? tr('main.chartSelectField')
            : activeFields.length > 16
                ? tr('main.chartTooManyFields', { max: 16 })
                : invalidUnit
                    ? tr('main.chartInvalidUnit')
                    : tr('main.chartInvalidYAxis');
        chartSampleStatus.className = 'input-validation invalid';
        return;
    }
    try {
        const discovered = await discoverChartFieldsInWorker(chartSampleLine.value, readChartDialogConfig());
        if (!discovered.length || activeFields.some(field => !discovered.some(candidate => candidate.key === field.key))) {
            throw new Error(tr('main.chartSampleInvalid'));
        }
    } catch (error) {
        if (tab.closed || tab !== chartSettingsState) return;
        chartSampleStatus.textContent = error.message;
        chartSampleStatus.className = 'input-validation invalid';
        return;
    }
    if (tab.closed || tab !== chartSettingsState) return;
    tab.parserMode = chartParserMode.value;
    tab.encoding = chartEncoding.value;
    tab.lineMarker = chartLineMarker.value;
    tab.keyValueSeparator = chartKeySeparator.value;
    tab.template = chartTemplateInput.value;
    tab.pattern = chartRegexInput.value;
    tab.sampleLine = chartSampleLine.value;
    tab.fields = fields;
    tab.yAxisMode = chartYAxisMode.value;
    tab.yMin = yMin;
    tab.yMax = yMax;
    tab.yIncludeZero = chartYIncludeZero.checked;
    tab.yMargin = Math.max(0, Math.min(1, Number(chartYMargin.value) / 100 || 0));
    tab.windowDurationMs = Math.max(1000, Math.min(86400000, Number(chartWindowDuration.value) * 1000 || 60000));
    tab.maxPoints = Math.max(1000, Math.min(1000000, Number(chartMaxPoints.value) || 200000));
    tab.maxDurationMs = Math.max(60000, Math.min(86400000, Number(chartMaxDuration.value) * 60000 || 1800000));
    configureChartTab(tab);
    persistChartTabs(groupIdForWorkspaceTab(tab.id) || activeGroupId);
    closeChartSettings();
    scheduleChartRender(tab);
}

[chartParserMode, chartLineMarker, chartKeySeparator, chartTemplateInput, chartRegexInput, chartSampleLine].forEach(element => {
    element?.addEventListener('input', () => {
        updateChartSettingsMode();
        clearTimeout(chartDiscoveryTimer);
        chartDiscoveryTimer = setTimeout(discoverChartDialogFields, 150);
    });
});
chartYAxisMode?.addEventListener('change', updateChartSettingsMode);
chartFieldsList?.addEventListener('change', event => {
    if (event.target.classList.contains('chart-field-visible')) updateChartFieldSelectionState();
});
chartFieldsToggle?.addEventListener('change', () => {
    const checkboxes = Array.from(chartFieldsList.querySelectorAll('.chart-field-visible'));
    checkboxes.forEach((checkbox, index) => { checkbox.checked = chartFieldsToggle.checked && index < 16; });
    updateChartFieldSelectionState();
});
document.getElementById('chart-settings-close')?.addEventListener('click', closeChartSettings);
document.getElementById('chart-settings-cancel')?.addEventListener('click', closeChartSettings);
document.getElementById('chart-settings-save')?.addEventListener('click', saveChartSettings);
chartParsingGuideOpen?.addEventListener('click', openChartParsingGuide);
chartParsingGuideClose?.addEventListener('click', closeChartParsingGuide);
chartParsingGuideDone?.addEventListener('click', closeChartParsingGuide);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !chartParsingGuideDialog?.classList.contains('hidden')) closeChartParsingGuide();
});
document.getElementById('chart-export-close')?.addEventListener('click', closeChartExport);
chartExportWindow?.addEventListener('click', () => exportChartSamples('window'));
chartExportAll?.addEventListener('click', () => exportChartSamples('all'));

// 把「右键的是哪一类标签」解析成重命名弹窗需要的目标对象。
//
// 分组标签没有自己的 tabState，所以用一个只带 groupId / title 的轻量对象承载；
// saveRenamedTab 见 groupId 走分组保存分支。其余三类标签直接用它们的运行时状态，
// 弹窗改的就是 title 字段本身。
function resolveRenameTarget({ terminalType, tabId, contextGroupId }) {
    const groupId = resolveSerialGroupId(contextGroupId);
    if (terminalType === 'group') {
        const group = getSerialGroupById(groupId);
        if (!group) return null;
        // 显示跟随端口时输入框里放的是端口名；把它作为初始文本，用户关掉开关后
        // 仍能看到并编辑自己原来的命名。
        return {
            groupId,
            title: group.followPort === true && group.portPath ? group.portPath : (group.title || '')
        };
    }
    if (terminalType === 'filter') {
        return filterTabsStore.getList(groupId).find(tab => tab.id === tabId) || null;
    }
    if (terminalType === 'chart') {
        return chartTabsStore.getList(groupId).find(tab => tab.id === tabId) || null;
    }
    if (terminalType === 'shell') {
        return getShellTabState(tabId);
    }
    // 'main' 与 'tab'：主终端标签的标题就是分组名，等价于重命名分组。
    const group = getSerialGroupById(groupId);
    if (!group) return null;
    return {
        groupId,
        title: group.followPort === true && group.portPath ? group.portPath : (group.title || '')
    };
}

function openRenameTabDialog(tabState) {
    if (!tabState) return;
    renameTabState = tabState;
    // 分组标签走另一条保存路径，靠 groupId 识别；其他标签没有端口可跟。
    const groupId = tabState.groupId || '';
    const group = groupId ? getSerialGroupById(groupId) : null;
    const followsPort = group?.followPort === true;
    renameTabInput.value = tabState.title || '';
    if (renameTabFollowPortRow) renameTabFollowPortRow.classList.toggle('hidden', !group);
    if (renameTabFollowPortInput) renameTabFollowPortInput.checked = followsPort;
    // 跟随端口时输入框锁定但**不清空**已填文本：用户关掉开关要能马上接着编辑，
    // 清空会把他之前起的名字直接丢掉。
    renameTabInput.readOnly = followsPort;
    if (renameTabValidation) renameTabValidation.textContent = '';
    renameTabDialog.classList.remove('hidden');
    // 锁定时不给输入框焦点，否则用户会以为能输入却没反应；焦点交给开关本身。
    if (followsPort && renameTabFollowPortInput) renameTabFollowPortInput.focus();
    else {
        renameTabInput.focus();
        renameTabInput.select();
    }
}

function closeRenameTabDialog() {
    renameTabState = null;
    renameTabDialog.classList.add('hidden');
}

function saveRenamedTab() {
    if (!renameTabState) return;
    const target = renameTabState;
    const text = renameTabInput.value.trim();
    const followPort = Boolean(renameTabFollowPortInput?.checked);

    // 分组标签：标题与「跟随端口」都落到分组配置上，改完四处显示点一起刷新。
    if (target.groupId) {
        const result = renameSerialGroup(serialGroups, target.groupId, text, { followPort });
        if (result.changed) {
            serialGroups = result.groups;
            persistSerialGroups();
            syncGroupTitlesForPortChange(target.groupId);
        }
        closeRenameTabDialog();
        return;
    }

    target.title = text;
    updateTabTitles();
    const groupId = groupIdForWorkspaceTab(target.id);
    if (groupId && filterTabsStore.getList(groupId).includes(target)) persistFilterTabs({ groupId });
    if (shellTabs.includes(target)) persistShellTabs();
    if (groupId && chartTabsStore.getList(groupId).includes(target)) persistChartTabs(groupId);
    closeRenameTabDialog();
}

document.getElementById('rename-tab-dialog-close').addEventListener('click', closeRenameTabDialog);
document.getElementById('rename-tab-dialog-cancel').addEventListener('click', closeRenameTabDialog);
document.getElementById('rename-tab-dialog-save').addEventListener('click', saveRenamedTab);
renameTabInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') saveRenamedTab();
    if (event.key === 'Escape') closeRenameTabDialog();
});

// 「跟随端口」开关：勾上立刻锁定输入框，但**保留已输入文本**；取消勾选恢复可编辑。
// 输入框此时显示的还是用户自己起的名字，锁只是防止误改，不能把内容清掉。
renameTabFollowPortInput?.addEventListener('change', () => {
    const followsPort = renameTabFollowPortInput.checked;
    renameTabInput.readOnly = followsPort;
    if (renameTabValidation) {
        renameTabValidation.textContent = followsPort
            ? trFallback('main.followPortNameHint', 'Tab name will follow the selected serial port')
            : '';
    }
    if (!followsPort) {
        renameTabInput.focus();
        renameTabInput.select();
    }
});

// pane-1 / pane-2 的动作按钮的 click **不再在这里绑**：它们由 createPaneActionButtons 在
// 构造时绑好，静态那两份在加载期也会被同一函数重建。这里再绑一次会让一次点击创建
// 两个标签（监听器叠加），是真实回归而不是测试问题。

function bindWorkspaceContentActivation() {
    const activate = event => {
        const panel = event.target.closest?.('.main-tab-pane');
        if (!panel || !panel.classList.contains('active') || !workspaceModel) return;
        const tab = workspaceModel.tabs[panel.id];
        if (!tab) return;
        const groupId = tab.kind === 'shell' ? null : groupIdForWorkspaceTab(tab.id);
        if (workspaceModel.focusedTabId !== tab.id && !setFocusedTab(tab.id)) return;
        if (groupId && activeGroupId !== groupId) {
            activeGroupId = groupId;
            // 面板已经可见，只更新控制上下文，不能重新选择该组的另一个标签。
            applyActiveSerialGroup({ fit: false, activateTab: false });
        }
    };
    document.addEventListener('click', activate);
    document.addEventListener('focusin', activate);
}


window.addEventListener('main-tab-changed', (e) => {
    const tabId = e.detail.tabId;
    setTimeout(() => {
        if (workspaceModel && !tabModel.buildRenderPlan(workspaceModel).panelIds.includes(tabId)) return;
        fitWorkspaceTerminals();
    }, 0);
});

function createTerminalKeyHandler(targetTerm, terminalType = 'serial') {
    return (arg) => {
        if (arg.type !== 'keydown') return true;

        const ctrlKey = arg.ctrlKey;
        const key = arg.key.toLowerCase();

        if (ctrlKey && key === 'c') {
            if (targetTerm.hasSelection()) {
                navigator.clipboard.writeText(targetTerm.getSelection());
                return false;
            }
            return true;
        }

        if (ctrlKey && key === 'v') {
            if (terminalType === 'shell') return false;
            navigator.clipboard.readText().then(text => {
                if (!text) return;
                sendSerialRequest({ mode: 'text', content: text, source: 'paste' }, SEND_LIMITS.paste);
            });
            return false;
        }

        return true;
    };
}

// Smart Copy/Paste Handling
serialTerm.attachCustomKeyEventHandler(createTerminalKeyHandler(serialTerm, 'serial'));
ipcRenderer.on('terminal-context-menu-action', (event, payload) => {
    suppressMainInputFocus = true;
    handleTerminalContextMenuAction(payload)
        .catch(console.error)
        .finally(() => {
            setTimeout(() => {
                suppressMainInputFocus = document.activeElement?.classList?.contains('filter-input') === true;
            }, 0);
        });
});

let mainInputHistory = [];
let mainInputHistoryIndex = -1;
let mainInputHistoryDraft = null;
let mainInputHistoryLimit = 20;
const mainInputDrafts = { text: '', hex: '' };
let mainInputMode = 'text';

function validateSendContent(mode, content, encoding, maxBytes) {
    if (mode === 'hex') return parseHexInput(content, { maxBytes });
    if (!content) return { ok: false, code: 'EMPTY_INPUT', message: 'Input is empty', position: 0 };
    const result = buildSerialWriteBuffer({ mode: 'text', content, encoding }, { maxBytes });
    return result.ok ? { ...result, normalized: content } : result;
}

function formatValidation(result, mode, appendCrLf = false) {
    if (!result.ok) {
        const suffix = result.token ? `: ${result.token}` : (Number.isInteger(result.position) ? ` @ ${result.position + 1}` : '');
        return trFallback(`main.hexError.${result.code}`, result.message || result.code) + suffix;
    }
    const count = result.byteCount + (appendCrLf ? 2 : 0);
    return mode === 'hex'
        ? trFallback('main.hexValidBytes', 'Valid Hex, {count} bytes', { count })
        : trFallback('main.textCountBytes', '{chars} characters, {count} bytes', { chars: String(result.normalized).length, count });
}

async function sendSerialRequest(request, maxBytes = SEND_LIMITS.main, { silent = false } = {}) {
    // 写入必须带上它所属的分组：主进程按 groupId 找会话，缺了就是往默认分组写。
    const targetGroupId = resolveSerialGroupId(request?.groupId);
    if (!isGroupConnected(targetGroupId)) {
        const result = { ok: false, code: 'SERIAL_NOT_OPEN', message: trFallback('main.serialNotOpen', 'Serial port is not connected') };
        if (!silent) setActionStatus(result.message);
        return result;
    }
    // 发送编码与换行模式按**写入目标分组**取：两个分组可以各用一种发送编码，
    // 不能用默认分组的缓存值。
    const targetRegistry = serialGroupRegistry.getGroup(targetGroupId);
    const targetDisplay = getGroupDisplay(targetGroupId);
    const profileRequest = {
        ...request,
        mode: request.mode === 'hex' ? 'hex' : 'text',
        encoding: targetDisplay.sendEncoding,
        appendCrLf: request.source === 'terminal' ? false : request.appendCrLf === true
    };
    const validation = validateSendContent(profileRequest.mode, profileRequest.content, profileRequest.encoding, maxBytes - (profileRequest.appendCrLf ? 2 : 0));
    if (!validation.ok) {
        if (!silent) setActionStatus(formatValidation(validation, profileRequest.mode));
        return validation;
    }
    try {
        const requestSessionId = getGroupSessionId(targetGroupId);
        const writeRequest = {
            groupId: targetGroupId,
            mode: profileRequest.mode, content: profileRequest.content,
            encoding: profileRequest.encoding, appendCrLf: profileRequest.appendCrLf,
            source: request.source || 'renderer', terminalEnter: request.terminalEnter === true,
            newlineMode: request.newlineMode || targetDisplay.newlineMode, sessionId: requestSessionId
        };
        const pendingWrite = (serialWriteChains.get(targetGroupId) || Promise.resolve()).then(() => {
            if (serialGroupRegistry.getGroup(targetGroupId) !== targetRegistry || !isGroupConnected(targetGroupId) || requestSessionId !== getGroupSessionId(targetGroupId)) {
                return { ok: false, code: 'STALE_SERIAL_SESSION', message: 'Serial connection has changed' };
            }
            return ipcRenderer.invoke('serial-write', writeRequest);
        });
        serialWriteChains.set(targetGroupId, pendingWrite.catch(() => undefined));
        const result = await pendingWrite;
        if (serialGroupRegistry.getGroup(targetGroupId) !== targetRegistry || requestSessionId !== getGroupSessionId(targetGroupId)) return { ok: false, code: 'STALE_SERIAL_SESSION' };
        if (result.ok && profileRequest.mode === 'text' && scrollToBottomOnSend) scrollMainTerminalToBottom(targetGroupId);
        if (result.ok) {
            renderSentRecord({
                timestamp: formatTimestamp(),
                mode: profileRequest.mode,
                bytes: validation.bytes
                    ? Buffer.concat([validation.bytes, profileRequest.appendCrLf ? Buffer.from([0x0d, 0x0a]) : Buffer.alloc(0)])
                    : Buffer.alloc(result.bytesWritten || 0),
                // appendCrLf 真正写入的是 CRLF，回显文本必须包含它，否则字节数与可见内容不自洽。
                text: profileRequest.mode === 'text'
                    ? `${profileRequest.content}${profileRequest.appendCrLf ? '\r\n' : ''}`
                    : undefined
            }, targetGroupId);
        }
        if (!silent) setActionStatus(result.ok
            ? trFallback('main.bytesSent', 'Sent {count} bytes', { count: result.bytesWritten })
            : trFallback('main.serialWriteFailed', 'Write failed: {error}', { error: result.message || result.code }));
        return result;
    } catch (error) {
        const result = { ok: false, code: 'SERIAL_WRITE_FAILED', message: error?.message || String(error) };
        if (!silent) setActionStatus(trFallback('main.serialWriteFailed', 'Write failed: {error}', { error: result.message }));
        return result;
    }
}

function putTextInMainInput(text, mode = mainInputMode) {
    switchMainInputMode(mode, { persist: true });
    mainSendInput.value = text;
    mainInputDrafts[mode] = text;
    updateMainInputState();
    setMainInputPanelVisible(true, true);
    focusMainInput();
}

function updateMainInputHeight() {
    if (!mainSendInput) return;
    mainSendInput.style.height = 'auto';
    mainSendInput.style.height = `${Math.min(mainSendInput.scrollHeight, 180)}px`;
}

function setLastSentPreview(text) {
    if (!mainSendLast) return;
    if (!text) {
        mainSendLast.textContent = tr('main.lastSentNone');
        return;
    }
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const [firstLine = ''] = normalized.split('\n');
    const preview = `${firstLine}${normalized.includes('\n') ? '…' : ''}`;
    mainSendLast.textContent = tr('main.lastSent', { value: preview || tr('common.none') });
}

function setMainInputPanelVisible(visible, persist = true) {
    if (!mainInputPanel) return;
    mainInputPanel.classList.toggle('hidden', !visible);
    toggleMainInputBtn?.classList.toggle('active', visible);
    sidebarInputBtn?.classList.toggle('active', visible);
    fitWorkspaceTerminals();

    if (persist) {
        saveMainInputSettings();
    }

}

function setSidebarCollapsed(collapsed, persist = true) {
    hideQuickSendDisconnectedToast();
    const isCollapsed = collapsed === true;
    sidebar?.classList.toggle('sidebar-collapsed', isCollapsed);
    if (sidebarExpandBtn) {
        sidebarExpandBtn.title = tr(isCollapsed ? 'main.expandSidebar' : 'main.collapseSidebar');
        sidebarExpandBtn.setAttribute('aria-label', sidebarExpandBtn.title);
    }
    if (persist && !isApplyingConfig) {
        ipcRenderer.send('save-config', { sidebarCollapsed: isCollapsed });
    }
    if (!isCollapsed && document.getElementById('tab-search')?.classList.contains('active') && searchInput?.value) {
        refreshSearchCount();
    }
    fitWorkspaceTerminals();
}

function toggleShellSidebar() {
    if (!shellSidebar) return;
    const isHidden = shellSidebar.classList.contains('hidden');
    shellSidebar.classList.toggle('hidden', !isHidden);
    toggleShellSidebarBtn?.classList.toggle('active', isHidden);
    sidebarShellBtn?.classList.toggle('active', isHidden);
}

let shellQuickCommands = [];
let editingShellQuickCommandId = '';

function createShellQuickCommandId() {
    return `shell-quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeShellQuickCommand(item = {}) {
    return {
        id: typeof item.id === 'string' && item.id ? item.id : createShellQuickCommandId(),
        label: typeof item.label === 'string' ? item.label.trim().slice(0, 60) : '',
        command: typeof item.command === 'string' ? item.command : '',
        appendEnter: item.appendEnter !== false
    };
}

function saveShellQuickCommands() {
    if (isApplyingConfig) return;
    ipcRenderer.send('save-config', {
        shellQuickCommands: shellQuickCommands.map(normalizeShellQuickCommand)
    });
}

function getActiveShellTab() {
    // Shell 的发送目标属于工作区焦点，不是串口控制组的局部选择。
    const tabId = workspaceModel ? workspaceModel.focusedTabId : focusedWorkspaceTabId;
    return shellTabs.find(tab => tab.id === tabId) || null;
}

function sendShellQuickCommand(item) {
    const shellTab = getActiveShellTab();
    if (!shellTab) {
        setActionStatus(trFallback('main.shellQuickCommandNeedsShell', 'Activate a Shell tab first'));
        return;
    }
    if (!shellTab.sessionReady) {
        setActionStatus(trFallback('main.shellQuickCommandNotReady', 'The active Shell is not ready'));
        return;
    }
    const data = `${item.command}${item.appendEnter ? '\r' : ''}`;
    if (!data) return;
    ipcRenderer.send('shell-tab-input', { tabId: shellTab.id, data });
    shellTab.term.focus();
    setActionStatus(trFallback('main.shellQuickCommandSent', 'Sent Shell command: {label}', {
        label: item.label || item.command
    }));
}

function renderShellQuickCommands() {
    if (!shellQuickCommandList || !shellQuickCommandEmpty) return;
    shellQuickCommandList.innerHTML = '';
    shellQuickCommandEmpty.classList.toggle('hidden', shellQuickCommands.length > 0);
    shellQuickCommands.forEach(item => {
        const row = document.createElement('div');
        row.className = 'shell-quick-command-item';
        row.dataset.commandId = item.id;
        row.setAttribute('role', 'listitem');

        const sendButton = document.createElement('button');
        sendButton.type = 'button';
        sendButton.className = 'shell-quick-command-send';
        sendButton.title = item.command;
        const label = document.createElement('span');
        label.className = 'shell-quick-command-label';
        label.textContent = item.label || item.command;
        sendButton.appendChild(label);
        if (item.appendEnter) {
            const enterBadge = document.createElement('span');
            enterBadge.className = 'shell-quick-command-enter-badge';
            enterBadge.textContent = 'ENTER';
            sendButton.appendChild(enterBadge);
        }
        sendButton.addEventListener('click', () => sendShellQuickCommand(item));

        const actions = document.createElement('div');
        actions.className = 'shell-quick-command-actions';
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'shell-quick-command-action';
        editButton.title = trFallback('main.editShellQuickCommand', 'Edit Shell quick command');
        editButton.setAttribute('aria-label', editButton.title);
        editButton.appendChild(createMaterialIcon('edit'));
        editButton.addEventListener('click', () => openShellQuickCommandDialog(item.id));
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'shell-quick-command-action delete';
        deleteButton.title = trFallback('main.deleteShellQuickCommand', 'Delete Shell quick command');
        deleteButton.setAttribute('aria-label', deleteButton.title);
        deleteButton.appendChild(createMaterialIcon('delete'));
        deleteButton.addEventListener('click', () => {
            shellQuickCommands = shellQuickCommands.filter(entry => entry.id !== item.id);
            saveShellQuickCommands();
            renderShellQuickCommands();
        });
        actions.append(editButton, deleteButton);
        row.append(sendButton, actions);
        shellQuickCommandList.appendChild(row);
    });
}

function updateShellQuickCommandValidation() {
    const valid = Boolean(shellQuickCommandContentInput?.value);
    if (shellQuickCommandSaveBtn) shellQuickCommandSaveBtn.disabled = !valid;
    if (shellQuickCommandValidation) {
        shellQuickCommandValidation.textContent = valid
            ? ''
            : trFallback('main.shellCommandRequired', 'Enter a Shell command');
    }
}

function openShellQuickCommandDialog(itemId = '') {
    const item = shellQuickCommands.find(entry => entry.id === itemId) || null;
    editingShellQuickCommandId = item?.id || '';
    shellQuickCommandDialogTitle.textContent = trFallback(
        item ? 'main.editShellQuickCommand' : 'main.addShellQuickCommand',
        item ? 'Edit Shell Quick Command' : 'Add Shell Quick Command'
    );
    shellQuickCommandLabelInput.value = item?.label || '';
    shellQuickCommandContentInput.value = item?.command || '';
    shellQuickCommandAppendEnterInput.checked = item?.appendEnter !== false;
    const saveLabel = shellQuickCommandSaveBtn.querySelector('span:last-child');
    if (saveLabel) saveLabel.textContent = trFallback(item ? 'main.updateItem' : 'main.addToList', item ? 'Update Item' : 'Add to List');
    shellQuickCommandSaveBtn.querySelector('svg[data-material-icon]')?.replaceWith(createMaterialIcon(item ? 'edit' : 'add'));
    shellQuickCommandDialog.classList.remove('hidden');
    updateShellQuickCommandValidation();
    requestAnimationFrame(() => (item ? shellQuickCommandContentInput : shellQuickCommandLabelInput).focus());
}

function closeShellQuickCommandDialog() {
    shellQuickCommandDialog?.classList.add('hidden');
    editingShellQuickCommandId = '';
}

function saveShellQuickCommandFromDialog() {
    const command = shellQuickCommandContentInput.value;
    if (!command) return updateShellQuickCommandValidation();
    const item = normalizeShellQuickCommand({
        id: editingShellQuickCommandId || createShellQuickCommandId(),
        label: shellQuickCommandLabelInput.value || command.split(/\r?\n/, 1)[0],
        command,
        appendEnter: shellQuickCommandAppendEnterInput.checked
    });
    const index = shellQuickCommands.findIndex(entry => entry.id === editingShellQuickCommandId);
    if (index >= 0) shellQuickCommands[index] = item;
    else shellQuickCommands.push(item);
    saveShellQuickCommands();
    renderShellQuickCommands();
    closeShellQuickCommandDialog();
}

async function loadShellProfiles() {
    if (!shellProfileBtns) return;
    try {
        const result = await ipcRenderer.invoke('get-shell-profiles');
        const profiles = result.profiles || result;
        const defaultId = result.defaultId || '';
        shellProfileBtns.innerHTML = '';
        if (!profiles || !profiles.length) {
            const empty = document.createElement('div');
            empty.className = 'shell-profile-empty';
            empty.textContent = tr('main.noShellProfiles') || 'No shell profiles configured';
            shellProfileBtns.appendChild(empty);
            return;
        }
        profiles.forEach(profile => {
            const isDefault = profile.id === defaultId;
            const btn = document.createElement('button');
            btn.className = 'secondary shell-new-btn';
            btn.title = `${profile.name} (${profile.executable})${isDefault ? ' — ' + (tr('main.defaultProfile') || 'Default') : ''}`;
            const profileName = document.createElement('span');
            profileName.textContent = profile.name;
            btn.appendChild(profileName);
            if (isDefault) {
                const defaultIcon = createMaterialIcon('check_circle');
                defaultIcon.classList.add('default-profile-icon');
                defaultIcon.title = tr('main.defaultProfile') || 'Default';
                btn.appendChild(defaultIcon);
            }
            btn.addEventListener('click', () => {
                createShellTab({ profileId: profile.id, title: profile.name }, getActivePane()?.id || 'pane-1');
            });
            shellProfileBtns.appendChild(btn);
        });
    } catch (error) {
        console.error('Failed to load shell profiles:', error);
    }
}

function bindShellSidebarEvents() {
    toggleShellSidebarBtn?.addEventListener('click', () => {
        toggleShellSidebar();
        if (shellSidebar && !shellSidebar.classList.contains('hidden')) {
            loadShellProfiles();
        }
    });

    shellSidebarCloseBtn?.addEventListener('click', () => {
        if (shellSidebar) {
            shellSidebar.classList.add('hidden');
            toggleShellSidebarBtn?.classList.remove('active');
            sidebarShellBtn?.classList.remove('active');
        }
    });

    shellManageProfilesBtn?.addEventListener('click', () => {
        ipcRenderer.send('open-prefs', { focusTab: 'shell-profiles' });
    });

    shellQuickCommandAddBtn?.addEventListener('click', () => openShellQuickCommandDialog());
    shellQuickCommandDialogCloseBtn?.addEventListener('click', closeShellQuickCommandDialog);
    shellQuickCommandDialogCancelBtn?.addEventListener('click', closeShellQuickCommandDialog);
    shellQuickCommandSaveBtn?.addEventListener('click', saveShellQuickCommandFromDialog);
    shellQuickCommandContentInput?.addEventListener('input', updateShellQuickCommandValidation);
    shellQuickCommandDialog?.addEventListener('click', event => {
        if (event.target === shellQuickCommandDialog) closeShellQuickCommandDialog();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !shellQuickCommandDialog?.classList.contains('hidden')) {
            closeShellQuickCommandDialog();
        }
    });

    shellAutoCrlfCb?.addEventListener('change', () => {
        ipcRenderer.send('update-shell-options', {
            autoCRLF: shellAutoCrlfCb?.checked
        });
    });

    shellClearOnRestartCb?.addEventListener('change', () => {
        ipcRenderer.send('update-shell-options', {
            clearOnRestart: shellClearOnRestartCb?.checked
        });
    });
}

function showSidebarTab(tabId, persist = true) {
    const normalizedTabId = ['tab-settings', 'tab-search', 'tab-send'].includes(tabId) ? tabId : 'tab-settings';
    const button = document.querySelector(`.sidebar-tab[data-target="${normalizedTabId}"]`);
    const pane = document.getElementById(normalizedTabId);
    if (!button || !pane) return false;
    document.querySelectorAll('.sidebar-tab-pane').forEach(tabPane => {
        tabPane.classList.toggle('active', tabPane === pane);
    });
    document.querySelectorAll('.sidebar-tab').forEach(tabButton => {
        const selected = tabButton === button;
        tabButton.classList.toggle('active', selected);
        tabButton.setAttribute('aria-selected', String(selected));
    });
    if (currentConfig) currentConfig.activeSidebarTab = normalizedTabId;
    if (persist && !isApplyingConfig) ipcRenderer.send('save-config', { activeSidebarTab: normalizedTabId });
    if (normalizedTabId === 'tab-search' && !sidebar?.classList.contains('sidebar-collapsed') && searchInput?.value) {
        refreshSearchCount();
    }
    return true;
}

function getNextChartTabId() {
    return nextChartTabId++;
}

function syncNextChartTabId(tabId) {
    const match = String(tabId || '').match(/^tab-chart-(\d+)$/);
    if (!match) return;
    const numericId = Number(match[1]);
    if (Number.isFinite(numericId) && numericId >= nextChartTabId) nextChartTabId = numericId + 1;
}

function bindSidebarToolbarEvents() {
    document.querySelectorAll('.sidebar-tab').forEach(button => {
        button.addEventListener('click', () => showSidebarTab(button.dataset.target));
    });
    document.getElementById('open-prefs')?.addEventListener('click', () => {
        ipcRenderer.send('open-prefs');
    });
    const toggle = () => setSidebarCollapsed(!sidebar?.classList.contains('sidebar-collapsed'));
    sidebarExpandBtn?.addEventListener('click', toggle);
    sidebarCollapseBtn?.addEventListener('click', toggle);
    sidebarConnectBtn?.addEventListener('click', () => connectBtn?.click());
    sidebarClearBtn?.addEventListener('click', () => document.getElementById('clear-btn')?.click());
    sidebarPrefsBtn?.addEventListener('click', () => document.getElementById('open-prefs')?.click());
    sidebarInputBtn?.addEventListener('click', () => toggleMainInputBtn?.click());
    sidebarShellBtn?.addEventListener('click', () => toggleShellSidebarBtn?.click());
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function focusMainInput() {
    if (!mainSendInput) return;
    if (suppressMainInputFocus) return;
    mainSendInput.focus();
    const len = mainSendInput.value.length;
    mainSendInput.setSelectionRange(len, len);
}

function normalizeMainInputHistoryLimit(value) {
    const limit = Number.parseInt(value, 10);
    return Number.isFinite(limit) ? Math.min(200, Math.max(0, limit)) : 20;
}

function normalizeMainInputHistory(history, limit = mainInputHistoryLimit) {
    if (!Array.isArray(history) || limit <= 0) return [];
    return history.filter(item => item && typeof item === 'object' && typeof item.content === 'string' && item.content)
        .map(item => ({ mode: item.mode === 'hex' ? 'hex' : 'text', content: item.content }))
        .slice(-limit);
}

function formatMainInputHistoryPreview(entry) {
    const normalized = String(entry.content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const [firstLine = ''] = normalized.split('\n');
    const suffix = normalized.includes('\n') ? '...' : '';
    return `[${entry.mode.toUpperCase()}] ${firstLine || tr('common.emptyContent')}${suffix}`;
}

function saveMainInputHistory() {
    if (isApplyingConfig) return;
    if (currentConfig) currentConfig.mainInputHistory = mainInputHistory;
    ipcRenderer.send('save-config', { mainInputHistory });
}

function renderMainInputHistoryMenu() {
    if (!mainInputHistoryMenu || !mainInputHistoryBtn) return;
    mainInputHistoryMenu.innerHTML = '';
    mainInputHistoryBtn.disabled = mainInputHistory.length === 0;
    if (!mainInputHistory.length) {
        mainInputHistoryMenu.classList.add('hidden');
        return;
    }

    mainInputHistory.slice().reverse().forEach(entry => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'main-input-history-item';
        item.textContent = formatMainInputHistoryPreview(entry);
        item.title = entry.content;
        item.addEventListener('click', () => {
            mainInputHistoryMenu.classList.add('hidden');
            mainInputHistoryIndex = -1;
            mainInputHistoryDraft = null;
            putTextInMainInput(entry.content, entry.mode);
        });
        mainInputHistoryMenu.appendChild(item);
    });
}

function toggleMainInputHistoryMenu() {
    if (!mainInputHistoryMenu || !mainInputHistory.length) return;
    mainInputHistoryMenu.classList.toggle('hidden');
}

function normalizeShortcutKeyName(key) {
    if (key === ' ') return 'Space';
    if (key === 'ArrowUp') return 'Up';
    if (key === 'ArrowDown') return 'Down';
    if (key === 'ArrowLeft') return 'Left';
    if (key === 'ArrowRight') return 'Right';
    if (key.length === 1) return key.toUpperCase();
    return key;
}

function shortcutFromEvent(event) {
    const key = normalizeShortcutKeyName(event.key);
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(key);
    return parts.join('+');
}

function normalizeShortcutSettings(shortcuts = {}) {
    const normalized = { ...DEFAULT_SHORTCUTS };
    Object.keys(DEFAULT_SHORTCUTS).forEach(action => {
        if (typeof shortcuts[action] === 'string') normalized[action] = shortcuts[action].trim();
    });
    return normalized;
}

function isEditableShortcutTarget(target) {
    if (!target) return false;
    if (target === mainSendInput || target === searchInput) return false;
    if (target.closest?.('.xterm')) return false;
    return target.matches?.('input, textarea, select, [contenteditable="true"]') === true;
}

function getShortcutAction(combo) {
    return Object.entries(activeShortcuts).find(([, value]) => value && value === combo)?.[0] || '';
}

function handleAppShortcut(event) {
    const combo = shortcutFromEvent(event);
    if (!combo) return;
    const action = getShortcutAction(combo);
    if (!action) return;
    if (isEditableShortcutTarget(event.target)) return;

    event.preventDefault();
    event.stopPropagation();

    switch (action) {
        case 'sendMainInput':
            sendMainInputBuffer();
            break;
        case 'toggleSendHistory':
            toggleMainInputHistoryMenu();
            break;
        case 'historyPrevious':
            navigateMainInputHistory(1);
            break;
        case 'historyNext':
            navigateMainInputHistory(-1);
            break;
        case 'focusSearch':
            focusSearchWithActiveSelection();
            break;
        case 'clearActiveTerminal':
            clearActiveTerminal();
            break;
        case 'refreshPorts':
            refreshPorts();
            break;
        case 'toggleSerialConnection':
            toggleSerialConnection();
            break;
    }
}

function pushMainInputHistory(entry) {
    if (!entry?.content) return;
    if (mainInputHistoryLimit <= 0) return;
    const normalizedEntry = { mode: entry.mode === 'hex' ? 'hex' : 'text', content: entry.content };
    const existingIndex = mainInputHistory.findIndex(item => item.mode === normalizedEntry.mode && item.content === normalizedEntry.content);
    if (existingIndex >= 0) {
        mainInputHistory.splice(existingIndex, 1);
    }
    mainInputHistory.push(normalizedEntry);
    mainInputHistory = normalizeMainInputHistory(mainInputHistory, mainInputHistoryLimit);
    mainInputHistoryIndex = -1;
    mainInputHistoryDraft = null;
    renderMainInputHistoryMenu();
    saveMainInputHistory();
}

function navigateMainInputHistory(direction) {
    if (!mainInputHistory.length) return;

    if (mainInputHistoryIndex === -1) {
        mainInputHistoryDraft = getMainInputRequest();
    }

    const nextIndex = mainInputHistoryIndex + direction;
    if (nextIndex < -1 || nextIndex >= mainInputHistory.length) {
        return;
    }

    mainInputHistoryIndex = nextIndex;
    const entry = mainInputHistoryIndex === -1 ? mainInputHistoryDraft : mainInputHistory[mainInputHistory.length - 1 - mainInputHistoryIndex];
    switchMainInputMode(entry.mode, { persist: true });
    mainSendInput.value = entry.content;
    mainInputDrafts[entry.mode] = entry.content;
    updateMainInputHeight();
    const appendCrLf = mainSendAppendCrlfCb?.checked === true;
    const validation = validateSendContent(mainInputMode, entry.content, sendEncoding, SEND_LIMITS.main - (appendCrLf ? 2 : 0));
    mainInputValidation.textContent = formatValidation(validation, mainInputMode, appendCrLf);
    mainInputValidation.classList.toggle('valid', validation.ok);
    mainInputValidation.classList.toggle('invalid', !validation.ok && entry.content.length > 0);
    mainSendBtn.disabled = !validation.ok;
    mainAddQuickSendBtn.disabled = !validation.ok;
    mainSendInput.placeholder = mainInputMode === 'hex' ? 'AA 55 01 FF' : tr('main.sendInputPlaceholder');
    focusMainInput();
}

function isMainInputCaretOnFirstLine() {
    const caretStart = mainSendInput.selectionStart ?? 0;
    return !mainSendInput.value.slice(0, caretStart).includes('\n');
}

function isMainInputCaretOnLastLine() {
    const caretEnd = mainSendInput.selectionEnd ?? 0;
    return !mainSendInput.value.slice(caretEnd).includes('\n');
}

function clearMainInput() {
    mainSendInput.value = '';
    mainInputHistoryIndex = -1;
    mainInputHistoryDraft = null;
    updateMainInputState();
}

function getMainInputRequest() {
    // 发送输入框发送的是**激活分组**的端口，所以编码与换行模式取激活分组的值。
    const display = getGroupDisplay(activeGroupId);
    return {
        // **必须显式带上 groupId。** `sendSerialRequest` 缺省会回落默认分组，
        // 于是「切到串口 2 组后按发送」会把数据写到串口 1 组（实测 diag981：
        // activeGroupId 已是 g-2，`serial-write` payload 的 groupId 仍是 'default'）。
        groupId: activeGroupId,
        mode: mainInputMode,
        content: mainSendInput.value,
        encoding: display.sendEncoding,
        newlineMode: display.newlineMode,
        appendCrLf: mainSendAppendCrlfCb?.checked === true
    };
}

function updateMainInputState() {
    updateMainInputHeight();
    const request = getMainInputRequest();
    mainInputDrafts[request.mode] = request.content;
    const validation = validateSendContent(request.mode, request.content, request.encoding, SEND_LIMITS.main - (request.appendCrLf ? 2 : 0));
    mainInputValidation.textContent = formatValidation(validation, request.mode, request.appendCrLf);
    mainInputValidation.classList.toggle('valid', validation.ok);
    mainInputValidation.classList.toggle('invalid', !validation.ok && request.content.length > 0);
    mainSendBtn.disabled = !validation.ok;
    mainAddQuickSendBtn.disabled = !validation.ok;
    mainSendInput.placeholder = request.mode === 'hex' ? 'AA 55 01 FF' : tr('main.sendInputPlaceholder');
}

function switchMainInputMode(mode, { persist = true } = {}) {
    const normalized = mode === 'hex' ? 'hex' : 'text';
    const oldMode = mainInputMode;
    if (oldMode !== normalized) mainInputDrafts[oldMode] = mainSendInput.value;
    mainInputMode = normalized;
    mainSendInput.value = mainInputDrafts[normalized];
    if (mainSendHexCb) mainSendHexCb.checked = normalized === 'hex';
    updateMainInputState();
    if (persist && !isApplyingConfig) saveMainInputSettings();
}

async function sendMainInputBuffer() {
    const request = { ...getMainInputRequest(), source: 'main-input' };
    if (!request.content) {
        focusMainInput();
        return;
    }
    const result = await sendSerialRequest(request, SEND_LIMITS.main);
    if (result.ok) {
        pushMainInputHistory({ mode: request.mode, content: request.content });
        const preview = request.mode === 'hex' ? parseHexInput(request.content).normalized : request.content;
        setLastSentPreview(preview);
    }
    focusMainInput();
}

function buildQuickSendLabel(content) {
    const normalized = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const [firstLine = ''] = normalized.split('\n');
    if (!firstLine) return tr('main.quickSendDefaultLabel');
    return firstLine.length > 8 ? `${firstLine.slice(0, 8)}...` : firstLine;
}

function addMainInputToQuickSend() {
    const content = mainSendInput?.value;
    if (!content) {
        focusMainInput();
        return;
    }

    quickSendList.push({
        id: createQuickSendId(),
        label: buildQuickSendLabel(content),
        mode: mainInputMode,
        appendCrLf: mainSendAppendCrlfCb?.checked === true,
        content,
        sidebarShortcut: {
            enabled: false,
            text: '',
            backgroundColor: ''
        },
        autoTrigger: {
            enabled: false,
            text: '',
            useRegex: false,
            caseSensitive: false,
            wholeWord: false
        }
    });
    renderQuickSendLists();
    saveQuickSendList();
    setActionStatus('已将当前输入加入快捷发送');
    focusMainInput();
}

function saveMainInputSettings() {
    ipcRenderer.send('save-config', {
        mainInputSettings: {
            visible: !mainInputPanel?.classList.contains('hidden'),
            sendOnEnter: mainSendOnEnterCb?.checked !== false,
            mode: mainInputMode,
            appendCrLf: mainSendAppendCrlfCb?.checked === true,
            historyLimit: mainInputHistoryLimit
        }
    });
}

function bindMainInputEvents() {
    if (!mainSendInput) return;

    document.addEventListener('keydown', handleAppShortcut, true);

    mainSendInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && mainSendOnEnterCb?.checked) {
            event.preventDefault();
            sendMainInputBuffer();
            return;
        }

        if (event.key === 'ArrowUp' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && isMainInputCaretOnFirstLine()) {
            event.preventDefault();
            navigateMainInputHistory(1);
            return;
        }

        if (event.key === 'ArrowDown' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && isMainInputCaretOnLastLine()) {
            event.preventDefault();
            navigateMainInputHistory(-1);
            return;
        }
    });

    mainSendInput.addEventListener('input', updateMainInputState);
    mainSendBtn.addEventListener('click', sendMainInputBuffer);
    mainAddQuickSendBtn?.addEventListener('click', addMainInputToQuickSend);
    mainSendHexCb?.addEventListener('change', () => switchMainInputMode(mainSendHexCb.checked ? 'hex' : 'text'));
    mainSendAppendCrlfCb?.addEventListener('change', () => {
        updateMainInputState();
        saveMainInputSettings();
    });
    mainInputHistoryBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleMainInputHistoryMenu();
    });
    document.addEventListener('click', (event) => {
        if (mainInputHistoryMenu?.classList.contains('hidden')) return;
        if (mainInputHistoryMenu.contains(event.target) || mainInputHistoryBtn?.contains(event.target)) return;
        mainInputHistoryMenu.classList.add('hidden');
    });
    mainSendOnEnterCb?.addEventListener('change', saveMainInputSettings);
    toggleMainInputBtn?.addEventListener('click', () => {
        const visible = mainInputPanel?.classList.contains('hidden');
        setMainInputPanelVisible(visible, true);
    });

    updateMainInputState();
    setLastSentPreview('');
}

function applyMainInputConfig(config) {
    const settings = config.mainInputSettings || {};
    mainInputHistoryLimit = normalizeMainInputHistoryLimit(settings.historyLimit);
    mainInputHistory = normalizeMainInputHistory(config.mainInputHistory, mainInputHistoryLimit);
    renderMainInputHistoryMenu();
    setMainInputPanelVisible(settings.visible !== false, false);
    if (mainSendOnEnterCb) {
        mainSendOnEnterCb.checked = settings.sendOnEnter !== false;
    }
    if (mainSendAppendCrlfCb) mainSendAppendCrlfCb.checked = settings.appendCrLf === true;
    switchMainInputMode(settings.mode, { persist: false });
}

bindMainInputEvents();
bindWorkspacePaneTransitionFit();
bindWorkspaceContentActivation();
bindShellSidebarEvents();
bindSidebarToolbarEvents();

function getSerialOptionsFromUi() {
    // 侧栏控件反映的是**激活分组**，所以这里从该分组读四个显示参数，
    // 而不是从默认分组的模块级缓存读——否则切到 g-1 改编码会写回默认分组。
    const display = getGroupDisplay(activeGroupId);
    return {
        // 不能兑底到 `currentConfig.lastSerialOptions.path`：那是**默认分组**的端口。
        // 新分组尚未选端口时用它兑底，会把默认分组的端口写进新分组，
        // 于是切一下分组就把「端口按分组隔离」静默破掉了。宁可空，不可错。
        path: document.getElementById('port-select')?.value || '',
        baudRate: typeof getBaudRate === 'function' ? getBaudRate() : (currentConfig?.lastSerialOptions?.baudRate || '9600'),
        dataBits: document.getElementById('data-bits-select')?.value || '8',
        stopBits: document.getElementById('stop-bits-select')?.value || '1',
        parity: document.getElementById('parity-select')?.value || 'none',
        receiveDisplayMode: display.receiveDisplayMode,
        receiveEncoding: display.receiveEncoding,
        sendEncoding: display.sendEncoding,
        newlineMode: display.newlineMode
    };
}

// 把侧栏当前的串口参数持久化。
//
// 两条写入路径：`lastSerialOptions` 是全局默认值（新建分组时继承它）；
// `serialGroups[activeGroupId].serialOptions` 是**该分组自己的**一份。
// 只写前者会让「切到 g-1 改波特率」重启后变成「默认分组的波特率也变了」。
function persistActiveGroupSerialOptions() {
    const options = getSerialOptionsFromUi();
    const target = serialGroups.find(group => group && group.id === activeGroupId);
    if (!target) return options;
    target.serialOptions = {
        ...target.serialOptions,
        baudRate: options.baudRate,
        dataBits: options.dataBits,
        stopBits: options.stopBits,
        parity: options.parity,
        receiveDisplayMode: options.receiveDisplayMode,
        receiveEncoding: options.receiveEncoding,
        sendEncoding: options.sendEncoding,
        newlineMode: options.newlineMode
    };
    target.portPath = options.path || target.portPath || '';
    persistSerialGroups();
    return options;
}

function saveSerialModeConfig() {
    if (isApplyingConfig) return;
    const lastSerialOptions = persistActiveGroupSerialOptions();
    const customBaudRates = normalizeCustomBaudRates(currentConfig?.customBaudRates);
    if (currentConfig) {
        currentConfig.lastSerialOptions = lastSerialOptions;
        currentConfig.customBaudRates = customBaudRates;
    }
    ipcRenderer.send('save-config', { lastSerialOptions, customBaudRates });
}

function switchSendEncoding(nextEncoding, { persist = true, refresh = true, groupId = REGISTRY_DEFAULT_GROUP_ID } = {}) {
    const id = resolveSerialGroupId(groupId);
    const normalized = SUPPORTED_ENCODINGS.has(nextEncoding) ? nextEncoding : 'utf8';
    setGroupDisplay(id, { sendEncoding: normalized });
    // 侧栏控件与发送校验/预览只服务激活分组，切非激活分组时不去碰它们。
    if (id === activeGroupId) {
        if (sendEncodingSelect) sendEncodingSelect.value = normalized;
        if (refresh) refreshSendConsumers();
    }
    if (persist && !isApplyingConfig) saveSendEncoding();
}

function refreshSendConsumers() {
    updateMainInputState();
    if (typeof updateAutoSendValidation === 'function') {
        updateAutoSendValidation();
        updateAutoSendState();
    }
    if (typeof updateQuickSendValidation === 'function') updateQuickSendValidation();
    if (typeof renderQuickSendLists === 'function') renderQuickSendLists();
}

function saveSendEncoding() {
    const lastSerialOptions = getSerialOptionsFromUi();
    const config = { lastSerialOptions };
    if (autoSendEnableCb) {
        config.autoSendSettings = getAutoSendSettings();
        appliedAutoSendKey = JSON.stringify(config.autoSendSettings);
    }
    if (currentConfig) {
        currentConfig.lastSerialOptions = lastSerialOptions;
        if (config.autoSendSettings) currentConfig.autoSendSettings = config.autoSendSettings;
    }
    ipcRenderer.send('save-config', config);
}

receiveModeSelect?.addEventListener('change', () => switchReceiveMode(receiveModeSelect.value, { groupId: activeGroupId }));
receiveEncodingSelect?.addEventListener('change', () => switchReceiveEncoding(receiveEncodingSelect.value, { groupId: activeGroupId }));
sendEncodingSelect?.addEventListener('change', () => switchSendEncoding(sendEncodingSelect.value, { groupId: activeGroupId }));
document.getElementById('newline-mode-select')?.addEventListener('change', event => {
    setGroupDisplay(activeGroupId, { newlineMode: event.target.value });
    saveSerialModeConfig();
});

// Reset replaces the workspace; a preferences update must never do so.
function restoreWorkspaceConfig(config) {
    if (workspaceLayoutSaveTimer !== null) clearTimeout(workspaceLayoutSaveTimer);
    workspaceLayoutSaveTimer = null;
    isRestoringWorkspaceSession = true;
    try {
        shellTabs.slice().forEach(tab => closeShellTab(tab.id, { confirm: false }));
        serialGroups.slice().forEach(group => {
            ipcRenderer.send('disconnect-serial', { groupId: group.id });
            if (group.id !== REGISTRY_DEFAULT_GROUP_ID) closeSerialGroup(group.id, { confirm: false });
            else {
                destroySerialGroupResources(group.id);
                serialGroupRegistry.invalidateSession(group.id);
                resetTextReceive(group.id);
                serialOutputBuckets.clear(group.id);
                serialTerm.clear();
                bindGroupTerminalInput(group.id);
            }
        });
        workspaceModel = null;
        groupWorkspaceManagers.clear();
        groupWorkspaceLayouts.clear();
        groupLayoutSnapshots.clear();
        lastAppliedWorkspaceLayoutKey = '';
        activeGroupId = REGISTRY_DEFAULT_GROUP_ID;
        applyConfig(config);
    } finally {
        isRestoringWorkspaceSession = false;
    }
}

function applyConfig(config) {
    isApplyingConfig = true;
    try {
    currentConfig = config;
    setSidebarCollapsed(config.sidebarCollapsed === true, false);
    showSidebarTab(config.activeSidebarTab, false);
    sidebarShellBtn?.classList.toggle('active', shellSidebar && !shellSidebar.classList.contains('hidden'));
    activeShortcuts = normalizeShortcutSettings(config.shortcuts);
    let sendEncodingChanged = false;
    currentLanguage = getLanguage(config.language);
    highlightRules = config.highlightRules || [];
    compiledHighlightRules = compileHighlightRules(highlightRules);
    highlightColors = config.highlightColors;
    const normalizedWorkspaceLayout = normalizeWorkspaceLayout(config.workspaceLayout);
    const normalizedWorkspaceLayoutKey = JSON.stringify(normalizedWorkspaceLayout);
    
    // Update local color settings
    timestampColor = config.timestampColor || '#808080';
    lineNoColor = config.lineNoColor || '#67986f';
    mouseWheelScrollLines = normalizeIntegerSetting(config.mouseWheelScrollLines, 'mouseWheelScrollLines');
    scrollToBottomOnSend = config.scrollToBottomOnSend !== false;
    // 作用域本身留到分组列表同步之后再应用（见 syncSerialGroupsFromConfig 之后）：
    // 从 global 切到 per-group 时需要向**重建后**的分组列表种入当前全局值，
    // 在这里提前改会把值写进一份马上被丢弃的旧列表。
    // 先把它记在 `pendingDisplayPrefScope`，由同步流程消费。
    pendingDisplayPrefScope = normalizeDisplayPrefScope(config.displayPrefScope);
    // 顶层键是**全局那一份**（与改造前的持久化位置完全一致，旧配置不需要迁移）。
    // 这里保留各字段原有的默认回退语义：echoSentData 缺省为 true，其余缺省为 false。
    Object.assign(globalDisplayPrefs, normalizeDisplayPrefs({
        showTimestamp: config.showTimestamp === true,
        showLineNumbers: config.showLineNumbers === true,
        echoSentData: config.echoSentData !== false,
        echoSentDataBothFormats: config.echoSentDataBothFormats === true,
        echoSentDataInFilterTabs: config.echoSentDataInFilterTabs !== false
    }));
    echoSentDataHighlightColor = config.echoSentDataHighlightColor || '#1e3a5f';
    // 全局值与作用域刚被改写，缓存必须作废，否则本轮后续读取仍拿旧偏好。
    invalidateDisplayPrefsCache();
    
    logIncludeTimestamp = config.logIncludeTimestamp === true;
    logIncludeLineNumbers = config.logIncludeLineNumbers === true;

    const options = buildSerialTerminalOptions(config);
    applyTerminalWallpaper(config);
    // 字体/字号/主题要下发到**每个分组的**串口终端，不能只改默认分组：
    // 非默认分组的 runtime 是惰性建的，建的时候走 buildSerialTerminalOptions(currentConfig)，
    // 而此后用户改设置时若只写 serialTerm，已建好的其他分组会停在旧字体上。
    // 实测（diag981）：新建分组日志终端的 fontFamily 与设置不一致。
    serialRuntimes.listGroupIds().forEach(groupId => {
        const runtime = serialRuntimes.get(groupId);
        if (!runtime || !runtime.term) return;
        runtime.term.options = options;
        invalidateTerminalSearch(runtime.term, 'options');
    });
    
    // Apply options to all filter tabs（按分组取存储，不能用模块级别名）
    serialGroups.forEach(group => {
        filterTabsStore.getList(group.id).forEach(tab => {
            tab.term.options = options;
            invalidateTerminalSearch(tab.term, 'options');
            tab.fitAddon.fit();
        });
    });
    shellTabs.forEach(tab => {
        tab.term.options = options;
        invalidateTerminalSearch(tab.term, 'options');
        tab.fitAddon.fit();
    });
    chartTabs.forEach(tab => tab.view?.resize());
    refreshSearchCount();
    redrawActiveSearchDecoration();
    
    document.body.style.background = config.background;
    document.documentElement.style.setProperty('--chart-log-background', config.background || '#000000');

    document.querySelectorAll('[data-i18n]').forEach(el => {
        let translated = tr(el.dataset.i18n);
        if (el.closest('button')?.querySelector('svg[data-material-icon="add"]')) {
            translated = translated.replace(/^\s*\+\s*/, '');
        }
        el.textContent = translated === el.dataset.i18n && el.dataset.i18nFallback
            ? el.dataset.i18nFallback
            : translated;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = tr(el.dataset.i18nTitle);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = tr(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        const translated = tr(el.dataset.i18nAriaLabel);
        if (translated !== el.dataset.i18nAriaLabel) el.setAttribute('aria-label', translated);
    });
    applySearchHistoryConfig(config);
    
    // Restore Serial Settings
    if (config.lastSerialOptions) {
        const previousSendEncoding = sendEncoding;
        restoreBaudRateConfig(config);
        
        const db = document.getElementById('data-bits-select');
        if (db) db.value = config.lastSerialOptions.dataBits;
        
        const sb = document.getElementById('stop-bits-select');
        if (sb) sb.value = config.lastSerialOptions.stopBits;
        
        const par = document.getElementById('parity-select');
        if (par) par.value = config.lastSerialOptions.parity;
        
        const nl = document.getElementById('newline-mode-select');
        if (nl) nl.value = config.lastSerialOptions.newlineMode;
        // 启动时的 lastSerialOptions 是**默认分组**的初值（新分组继承它）。
        // 必须走 setGroupDisplay 而不是直接给模块级 let 赋值，否则上下文里的
        // 默认分组状态会停在 createDefaultState() 的初始值上，后续读上下文时不一致。
        setGroupDisplay(REGISTRY_DEFAULT_GROUP_ID, { newlineMode: config.lastSerialOptions.newlineMode || 'crlf' });
        switchReceiveEncoding(config.lastSerialOptions.receiveEncoding, { persist: false });
        switchReceiveMode(config.lastSerialOptions.receiveDisplayMode, { persist: false });
        switchSendEncoding(config.lastSerialOptions.sendEncoding, { persist: false, refresh: false });
        sendEncodingChanged = previousSendEncoding !== sendEncoding;
        
        // Refresh ports to update selection based on config
        refreshPorts();
    }

    applyMainInputConfig(config);
    const hexSettingsKey = JSON.stringify(config.hexDisplaySettings || {});
    if (appliedHexSettingsKey && appliedHexSettingsKey !== hexSettingsKey) flushAllHexFormatters();
    configureAllHexFormatters(config.hexDisplaySettings || {});
    appliedHexSettingsKey = hexSettingsKey;
    const autoSendChanged = applyAutoSendConfig(config.autoSendSettings || {});
    applyQuickSendAutoTriggerConfig(config.quickSendAutoTriggerEnabled);
    quickSendGroups = Array.isArray(config.quickSendGroups) ? config.quickSendGroups.map(normalizeQuickSendGroup) : [];
    quickSendUngroupedCollapsed = config.quickSendUngroupedCollapsed === true;
    quickSendList = Array.isArray(config.quickSendList) ? config.quickSendList.map(normalizeQuickSendItem) : [];
    sidebarQuickSendOrder = Array.isArray(config.sidebarQuickSendOrder)
        ? config.sidebarQuickSendOrder.filter(id => typeof id === 'string')
        : [];
    normalizeSidebarQuickSendOrder();
    renderQuickSendLists();
    updateQuickSendValidation();
    if (sendEncodingChanged || autoSendChanged) {
        updateAutoSendValidation();
        updateAutoSendState();
    }

    shellQuickCommands = Array.isArray(config.shellQuickCommands)
        ? config.shellQuickCommands.map(normalizeShellQuickCommand)
        : [];
    renderShellQuickCommands();

    // Preload shell profiles for the sidebar
    loadShellProfiles();

    // 按布局里**实际存在的** pane 建队列，不再写死 pane-1 / pane-2。
    // 分屏到第 3 个及以后 pane 时，写死的队列会让那些 pane 上的标签拿不到 id，
    // 结果是恢复出来的标签全挤在 pane-1，或者干脆丢掉。
    const layoutTabToPaneMap = new Map();
    const layoutTabIdsByPane = {};
    normalizedWorkspaceLayout.panes.forEach(pane => {
        layoutTabIdsByPane[pane.id] = [];
        if (Array.isArray(pane.tabIds)) {
            pane.tabIds.forEach(tabId => {
                if (typeof tabId === 'string') {
                    layoutTabToPaneMap.set(tabId, pane.id);
                    layoutTabIdsByPane[pane.id].push(tabId);
                }
            });
        }
    });
    const primaryPaneId = normalizedWorkspaceLayout.panes[0]?.id || 'pane-1';
    const makePaneQueue = pattern => {
        const queue = {};
        Object.keys(layoutTabIdsByPane).forEach(paneId => {
            queue[paneId] = layoutTabIdsByPane[paneId].filter(id => pattern.test(id));
        });
        return queue;
    };

    if (!workspaceModel && filterTabs.length === 0 && Array.isArray(config.filterTabs) && config.filterTabs.length > 0) {
        isRestoringWorkspaceSession = true;
        try {
            const paneFilterQueue = makePaneQueue(/^tab-filter-\d+$/);
            config.filterTabs.forEach(tabConfig => {
                const requestedPaneId = tabConfig.paneId || layoutTabToPaneMap.get(tabConfig.id) || primaryPaneId;
                const targetPaneId = getPaneTabsList(requestedPaneId) ? requestedPaneId : 'pane-1';
                if (!tabConfig.id) {
                    const queue = paneFilterQueue[targetPaneId] || [];
                    const nextId = queue.shift();
                    if (nextId) {
                        tabConfig.id = nextId;
                    }
                }
                createFilterTab(tabConfig, targetPaneId);
            });
        } finally {
            isRestoringWorkspaceSession = false;
        }
    }

    if (!workspaceModel && shellTabs.length === 0 && Array.isArray(config.shellTabs) && config.shellTabs.length > 0) {
        isRestoringWorkspaceSession = true;
        try {
            const paneShellQueue = makePaneQueue(/^tab-shell-\d+$/);
            config.shellTabs.forEach(tabConfig => {
                const requestedPaneId = tabConfig.paneId || layoutTabToPaneMap.get(tabConfig.id) || primaryPaneId;
                const targetPaneId = getPaneTabsList(requestedPaneId) ? requestedPaneId : 'pane-1';
                if (!tabConfig.id) {
                    const queue = paneShellQueue[targetPaneId] || [];
                    const nextId = queue.shift();
                    if (nextId) {
                        tabConfig.id = nextId;
                    }
                }
                createShellTab(tabConfig, targetPaneId);
            });
        } finally {
            isRestoringWorkspaceSession = false;
        }
        restoreShellSessions();
    }

    if (!workspaceModel && chartTabs.length === 0 && Array.isArray(config.chartTabs) && config.chartTabs.length > 0) {
        isRestoringWorkspaceSession = true;
        try {
            const paneChartQueue = makePaneQueue(/^tab-chart-\d+$/);
            config.chartTabs.forEach(tabConfig => {
                const requestedPaneId = tabConfig.paneId || layoutTabToPaneMap.get(tabConfig.id) || primaryPaneId;
                const targetPaneId = getPaneTabsList(requestedPaneId) ? requestedPaneId : 'pane-1';
                if (!tabConfig.id) tabConfig.id = paneChartQueue[targetPaneId]?.shift();
                createChartTab(tabConfig, targetPaneId);
            });
        } finally {
            isRestoringWorkspaceSession = false;
        }
    }


    if (!workspaceModel && normalizedWorkspaceLayoutKey !== lastAppliedWorkspaceLayoutKey) {
        restoreWorkspaceLayout(normalizedWorkspaceLayout, { persist: true });
        lastAppliedWorkspaceLayoutKey = JSON.stringify(cloneWorkspaceLayout(workspaceLayout));
    }

    // 分组列表与分组容器：放在布局恢复之后，确保 pane 的 tabs-list/tabs-content
    // 已经在 DOM 里。首次加载时这里会把 serialGroups 从配置里同步进来；
    // 之后 config-updated（含我们自己的 persistSerialGroups 回声）会重同步一次。
    if (!isApplyingSessionGroups) syncSerialGroupsFromConfig(config);

    // 作用域必须等分组列表同步完再落地：global → per-group 时要往这份新列表里种值。
    flushPendingDisplayPrefScope();

    // 侧栏的五个显示开关必须跟**当前激活分组**。
    // 必须晚于 syncSerialGroupsFromConfig 与 flushPendingDisplayPrefScope：
    // per-group 作用域下值存在分组对象上。
    syncDisplayPrefCheckboxes(getGroupDisplayPrefs(activeGroupId));


    initializeWorkspaceModel();

    serialFitAddon.fit();

    fitWorkspaceTerminals();
    } finally {
        isApplyingConfig = false;
    }
}

/*
// Mode Switching
window.setMode = (mode) => {
    currentMode = mode;
    
    // UI Updates
    document.getElementById('mode-terminal').classList.toggle('active', mode === 'terminal');
    document.getElementById('mode-serial').classList.toggle('active', mode === 'serial');
    
    document.getElementById('serial-controls').style.display = mode === 'serial' ? 'flex' : 'none';
    document.getElementById('terminal-container').style.display = mode === 'terminal' ? 'block' : 'none';
    document.getElementById('serial-container').style.display = mode === 'serial' ? 'block' : 'none';
    
    // Refit the visible terminal
    setTimeout(() => {
        if (mode === 'terminal') fitAddon.fit();
        else serialFitAddon.fit();
    }, 0);
};
*/

// Config IPC
ipcRenderer.invoke('get-config').then(config => {
    applyConfig(config);
    showWelcomeGuideForCurrentVersion(config);
});
ipcRenderer.on('config-updated', (event, config, change = {}) => {
    if (change.scope === 'reset-workspace') restoreWorkspaceConfig(config);
    else applyConfig(config);
});

function hideScheduledUpdateToast(animate = true) {
    if (scheduledUpdateToastTimer) clearTimeout(scheduledUpdateToastTimer);
    scheduledUpdateToastTimer = null;
    const toast = scheduledUpdateToast;
    if (!toast) return;
    if (scheduledUpdateToastRemoveTimer) clearTimeout(scheduledUpdateToastRemoveTimer);
    scheduledUpdateToastRemoveTimer = null;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (!animate || reduceMotion) {
        toast.remove();
        scheduledUpdateToast = null;
        return;
    }
    toast.classList.add('scheduled-update-toast-hiding');
    scheduledUpdateToastRemoveTimer = setTimeout(() => {
        toast.remove();
        if (scheduledUpdateToast === toast) scheduledUpdateToast = null;
        scheduledUpdateToastRemoveTimer = null;
    }, 180);
}

function showScheduledUpdateToast({ version = '' } = {}) {
    hideScheduledUpdateToast(false);
    const toast = document.createElement('div');
    toast.className = 'scheduled-update-toast';
    toast.setAttribute('role', 'status');

    const content = document.createElement('div');
    content.className = 'scheduled-update-toast-content';
    const title = document.createElement('div');
    title.className = 'scheduled-update-toast-title';
    title.textContent = trFallback('main.updateToastTitle', 'New version available');
    const message = document.createElement('div');
    message.className = 'scheduled-update-toast-message';
    message.textContent = trFallback(
        'main.updateToastMessage',
        'Version {version} is available. Update it from Settings > About.',
        { version }
    );
    content.append(title, message);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'scheduled-update-toast-close';
    closeButton.title = trFallback('main.closeUpdateToast', 'Close');
    closeButton.setAttribute('aria-label', closeButton.title);
    closeButton.appendChild(createMaterialIcon('close'));
    closeButton.onclick = () => hideScheduledUpdateToast();

    toast.append(content, closeButton);
    document.body.appendChild(toast);
    scheduledUpdateToast = toast;
    scheduledUpdateToastTimer = setTimeout(hideScheduledUpdateToast, 5000);
}

ipcRenderer.on('scheduled-update-available', (_event, info) => showScheduledUpdateToast(info));

ipcRenderer.on('shell-tab-output', (event, payload = {}) => {
    const tab = getShellTabState(payload.tabId);
    if (tab && typeof payload.data === 'string') {
        const translatedData = translateConptyMouseMode(tab, payload.data);
        tab.term.write(translatedData, () => {
            if (tab.textMode) setShellTextMode(tab, true);
        });
        writeShellTabLog(tab, payload.data);
    }
});

ipcRenderer.on('shell-tab-exit', (event, payload = {}) => {
    const tab = getShellTabState(payload.tabId);
    if (tab) {
        tab.sessionReady = false;
        tab.term.writeln(`\r\n[${tr('main.shellExited', { code: payload.exitCode ?? 0 })}]\r\n`);
        tab.btn?.classList.add('exited');
    }
});

// Serial Logic
// 主终端的键盘输入属于**它自己所属的分组**：每个分组的主终端各绑一次。
//
// 以前只给默认分组的 serialTerm 绑了 onData，于是切到 Serial 2 后往它的终端里打字
// 要么没反应，要么用默认分组的编码发出去。
function bindGroupTerminalInput(groupId) {
    const id = resolveSerialGroupId(groupId);
    if (serialInputBoundGroups.has(id)) return false;
    const runtime = serialRuntimes.get(id);
    if (!runtime) return false;
    serialInputBoundGroups.add(id);
    runtime.term.onData((data) => {
        // 只看**本分组**的连接态：用全局 isConnected 会让 Serial 2 已连接却打不进去。
        if (!isGroupConnected(id)) return;
        const display = getGroupDisplay(id);
        sendSerialRequest({
            groupId: id,
            mode: 'text', content: data, encoding: display.sendEncoding, source: 'terminal',
            terminalEnter: data === '\r', newlineMode: display.newlineMode
        }, SEND_LIMITS.terminal).then(result => {
            if (result.ok) runtime.term.write(data === '\r' ? '\r\n' : data);
        });
    });
    return true;
}

// 默认分组的终端在模块加载期就已就位，直接绑上。其它分组在创建终端时再绑。
bindGroupTerminalInput(REGISTRY_DEFAULT_GROUP_ID);
ipcRenderer.on('serial-output-bytes', (event, payload = {}) => {
    // P2：入站字节的归属判定统一走分组注册表。旧写法只比一个裸的 serialSessionId，
    // 没有分组概念，多串口下无法区分「这是哪个分组的字节」。
    const groupId = resolveSerialGroupId(payload.groupId);
    const verdict = serialGroupRegistry.accepts({ groupId, sessionId: payload.sessionId });
    if (!verdict.accepted) return;
    // serialSessionId 只代表默认分组。其它分组的会话号改由注册表按分组持有，
    // 否则 g-2 的一条入站消息就会覆盖默认分组的会话号，让默认分组的写入被误判为过期。
    if (Number.isInteger(payload.sessionId) && groupId === REGISTRY_DEFAULT_GROUP_ID) {
        serialSessionId = payload.sessionId;
    }
    const bytes = payload.bytes instanceof Uint8Array ? payload.bytes : Uint8Array.from(payload.bytes || []);
    if (!bytes.length) return;
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const receivedAt = Number.isFinite(payload.receivedAt) ? payload.receivedAt : Date.now();
    // 图表页同样按分组各一份：取本组自己的图表页，不再限定激活分组。
    // 未激活分组的图表在后台继续收数据，切回去时曲线才是连续的。
    chartTabsStore.getList(groupId).forEach(tab => tab.stream?.write(buffer, receivedAt));
    // 复用同一个 Buffer 视图，避免为同一段字节重复包装。
    queueSerialOutput(buffer, groupId);
});
ipcRenderer.on('serial-error', (event, err, meta = {}) => {
    const groupId = resolveSerialGroupId(meta?.groupId);
    if (!getSerialGroupById(groupId)) return;
    if (Number.isInteger(meta.sessionId) && serialConnectionSessions.get(groupId) !== meta.sessionId) return;
    const runtime = serialRuntimes.get(groupId);
    if (!runtime) return;
    const errMsg = '\r\n\x1b[31m[ERROR] ' + err + '\x1b[0m\r\n';
    runtime.term.write(errMsg);
    writeMainTabLog(errMsg, groupId);
    if (!isActiveSerialGroup(groupId)) return;
    filterTabs.forEach(tab => {
        tab.term.write(errMsg);
        writeFilterTabLog(tab, errMsg, groupId);
    });
});

const THROUGHPUT_BAR_COUNT = 30;

function formatThroughput(bytesPerSecond) {
    if (bytesPerSecond >= 1024 * 1024) {
        return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    if (bytesPerSecond >= 1024) {
        return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    }
    return `${bytesPerSecond} B/s`;
}

function ensureThroughputSvg(chartEl, type) {
    if (!chartEl.querySelector('svg')) {
        chartEl.innerHTML = ''; // clear any existing
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.style.overflow = "visible";
        svg.style.display = "block";

        const area = document.createElementNS(svgNS, "path");
        area.setAttribute("class", `throughput-area ${type}`);
        area.setAttribute("fill", type === 'rx' ? 'var(--accent-color)' : 'var(--warning-color)');
        area.setAttribute("opacity", "0.2");
        area.setAttribute("stroke", "none");

        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("class", `throughput-line ${type}`);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", type === 'rx' ? 'var(--accent-color)' : 'var(--warning-color)');
        path.setAttribute("stroke-width", "2");
        path.setAttribute("vector-effect", "non-scaling-stroke");
        path.setAttribute("stroke-linejoin", "round");

        svg.appendChild(area);
        svg.appendChild(path);
        chartEl.appendChild(svg);
    }
}

function renderThroughputChart(chartEl, history) {
    const values = history.slice(-THROUGHPUT_BAR_COUNT);
    while (values.length < THROUGHPUT_BAR_COUNT) {
        values.unshift(0);
    }
    const maxValue = Math.max(1, ...values);

    const svg = chartEl.querySelector('svg');
    if (!svg) return;
    const path = svg.querySelector('.throughput-line');
    const area = svg.querySelector('.throughput-area');

    let d = "";
    let areaD = "";
    const step = 100 / (THROUGHPUT_BAR_COUNT - 1);

    values.forEach((value, index) => {
        const normalized = value === 0 ? 0 : (value / maxValue) * 100;
        const x = index * step;
        // Invert Y axis, keep within 2-100 to avoid stroke clipping at top
        const y = 100 - (normalized * 0.98);

        if (index === 0) {
            d += `M ${x},${y} `;
            areaD += `M ${x},100 L ${x},${y} `;
        } else {
            d += `L ${x},${y} `;
            areaD += `L ${x},${y} `;
        }
    });

    if (areaD) {
        areaD += `L 100,100 Z`;
        area.setAttribute("d", areaD);
    }
    if (d) {
        path.setAttribute("d", d);
    }
}

function updateThroughputPanel({ connected, rxHistory, txHistory, rxBytesPerSecond, txBytesPerSecond }) {
    throughputPanel.classList.toggle('inactive', !connected);
    throughputRxRate.textContent = formatThroughput(rxBytesPerSecond || 0);
    throughputTxRate.textContent = formatThroughput(txBytesPerSecond || 0);
    if (sidebarThroughputRx) sidebarThroughputRx.textContent = formatThroughput(rxBytesPerSecond || 0);
    if (sidebarThroughputTx) sidebarThroughputTx.textContent = formatThroughput(txBytesPerSecond || 0);
    sidebarThroughputCompact?.classList.toggle('inactive', !connected);
    renderThroughputChart(throughputRxChart, rxHistory || []);
    renderThroughputChart(throughputTxChart, txHistory || []);
}

ipcRenderer.on('serial-throughput-update', (event, payload = {}) => {
    // 吞吐面板只有一个，显示的是**激活分组**的数据。以前它不管 groupId，
    // 于是后台分组的流量会把当前分组的速率/曲线冲掉。
    const groupId = resolveSerialGroupId(payload.groupId);
    if (groupId !== resolveSerialGroupId(activeGroupId)) return;
    updateThroughputPanel(payload);
});

function updateSerialConnectionState(connected) {
    isConnected = connected;
    if (connected) {
        quickSendDisconnectedClicks = new WeakMap();
        hideQuickSendDisconnectedToast();
    }
    const label = document.getElementById('connect-btn-label');
    if (label) {
        const translationKey = connected ? 'main.disconnect' : 'main.connect';
        label.dataset.i18n = translationKey;
        label.textContent = tr(translationKey);
    }
    connectBtn.classList.toggle('connect-action', !connected);
    connectBtn.classList.toggle('disconnect-action', connected);
    sidebarConnectBtn?.classList.toggle('connect-action', !connected);
    sidebarConnectBtn?.classList.toggle('disconnect-action', connected);
    if (sidebarConnectBtn) {
        sidebarConnectBtn.title = tr(connected ? 'main.disconnect' : 'main.connect');
        sidebarConnectBtn.setAttribute('aria-label', sidebarConnectBtn.title);
    }
    setActionStatus(connected ? tr('main.connected') : tr('main.disconnected'));
}

// 断开**指定分组**的串口。
//
// 默认参数必须用 REGISTRY_DEFAULT_GROUP_ID 而不是 activeGroupId：模块顶层有立即求值表达式，
// 用 activeGroupId 会触发 TDZ。真正「当前分组」的调用点在 toggleSerialConnection 里显式传入。
function disconnectSerial(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const targetGroupId = resolveSerialGroupId(groupId);
    serialConnectRequests.delete(targetGroupId);
    serialConnectingGroups.delete(targetGroupId);
    const isDefaultGroup = targetGroupId === REGISTRY_DEFAULT_GROUP_ID;
    // 递增会话号作废迟到的数据，同时让分组注册表同步失效（否则注册表仍认为旧会话有效）。
    const nextSessionId = serialGroupRegistry.invalidateSession(targetGroupId);
    serialWriteChains.delete(targetGroupId);
    resetQuickTriggerReceive(targetGroupId);
    if (isDefaultGroup) {
        // 默认组的兼容状态与自动发送保持旧生命周期。
        serialSessionId = nextSessionId;
        stopAutoSendRuntime();
        chartTabs.forEach(tab => {
            tab.stream?.flush();
            tab.stream?.reset();
        });
        updateSerialConnectionState(false);
    } else {
        // 非默认分组的图表数据按它自己那一份清；flush 要在读显示模式之前做。
        if (getGroupDisplay(targetGroupId).receiveDisplayMode === 'hex') getHexFormatter(targetGroupId).flush();
        else flushTextReceive(targetGroupId);
        chartTabsStore.getList(targetGroupId).forEach(tab => {
            tab.stream?.flush();
            tab.stream?.reset();
        });
    }
    refreshConnectButtonState();
    // 连接状态变了，分组标签的指示竖线要立刻跟着变色。
    renderSerialGroupTabBar();
    syncAllGroupMainTabTitles();
    ipcRenderer.send('disconnect-serial', { groupId: targetGroupId });
}

// 按分组等待断开事件：换波特率重连时只能等自己那一组，不能等「任何一个分组断开」。
function waitForSerialDisconnected(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const targetGroupId = resolveSerialGroupId(groupId);
    return new Promise(resolve => {
        let waiters = serialDisconnectWaiters.get(targetGroupId);
        if (!waiters) {
            waiters = [];
            serialDisconnectWaiters.set(targetGroupId, waiters);
        }
        waiters.push(resolve);
    });
}

ipcRenderer.on('serial-disconnected', (event, message, meta = {}) => {
    const groupId = resolveSerialGroupId(meta?.groupId);
    if (!getSerialGroupById(groupId) || !serialGroupRegistry.getGroup(groupId)) return;
    const matchesRequest = meta.requestId !== undefined && serialConnectRequests.get(groupId) === meta.requestId;
    const matchesSession = Number.isInteger(meta.sessionId) && serialConnectionSessions.get(groupId) === meta.sessionId;
    if ((meta.requestId !== undefined || Number.isInteger(meta.sessionId)) && !matchesRequest && !matchesSession) return;
    if (matchesRequest || !serialConnectRequests.has(groupId)) {
        serialConnectRequests.delete(groupId);
        serialConnectingGroups.delete(groupId);
    }
    const isDefaultGroup = groupId === REGISTRY_DEFAULT_GROUP_ID;
    serialGroupRegistry.invalidateSession(groupId);
    serialWriteChains.delete(groupId);
    resetQuickTriggerReceive(groupId);
    // 断开的判定必须按**它自己所属的分组**读：关掉 g-2 时默认分组可能还是 text，
    // 用模块级缓存会 flush 错分组的 formatter。
    if (getGroupDisplay(groupId).receiveDisplayMode === 'hex') getHexFormatter(groupId).flush();
    else flushTextReceive(groupId);
    if (isDefaultGroup) {
        // 全局连接状态、自动发送与 chartTabs 别名只属于默认分组：
        // 关掉 g-2 不应该让默认分组的界面显示成「已断开」。
        serialSessionId = getGroupSessionId(groupId);
        stopAutoSendRuntime();
        chartTabs.forEach(tab => {
            tab.stream?.flush();
            tab.stream?.reset();
        });
        updateSerialConnectionState(false);
    } else {
        // 非默认分组断开：清掉它自己那一份图表数据，不能碰 chartTabs 别名。
        chartTabsStore.getList(groupId).forEach(tab => {
            tab.stream?.flush();
            tab.stream?.reset();
        });
    }
    // 侧栏连接按钮显示的是激活分组，任何一组断开都要重算。
    refreshConnectButtonState();
    // 被动断开（设备拔掉/出错）同样要刷新分组标签的连接指示。
    renderSerialGroupTabBar();
    syncAllGroupMainTabTitles();
    const runtime = serialRuntimes.get(groupId);
    if (message && runtime) {
        const notice = `\r\n\x1b[33m[INFO] ${message}\x1b[0m\r\n`;
        runtime.term.write(notice);
        writeMainTabLog(notice, groupId);
        if (isActiveSerialGroup(groupId)) {
            filterTabs.forEach(tab => {
                tab.term.write(notice);
                writeFilterTabLog(tab, notice, groupId);
            });
        }
        if (isDefaultGroup) setActionStatus(message);
    }
    if (isDefaultGroup) ipcRenderer.send('flush-tab-logs');
    // 唤醒等待**这一组**断开的重连流程；其它组的等待者必须留着。
    const waiters = serialDisconnectWaiters.get(groupId);
    if (waiters) {
        serialDisconnectWaiters.delete(groupId);
        waiters.forEach(resolve => resolve());
    }
});

ipcRenderer.on('all-tabs-log-saved', (event, payload = {}) => {
    const count = Array.isArray(payload.paths) ? payload.paths.length : 0;
    setActionStatus(count > 0 ? `已保存 ${count} 个标签页日志文件` : '标签页日志已保存');
});

ipcRenderer.on('log-error', (event, payload = {}) => {
    const message = trFallback(
        'main.logWriteFailed',
        'Log write failed ({kind}): {error}{paused}',
        {
            kind: payload.kind || 'log',
            error: payload.message || 'unknown error',
            paused: payload.paused ? trFallback('main.logWritePaused', ' Logging paused to protect memory.') : ''
        }
    );
    setActionStatus(message);
});

const portSelect = document.getElementById('port-select');
const baudSelect = document.getElementById('baud-select');
const baudCustomWrapper = document.getElementById('baud-custom-wrapper');
const baudCustomInput = document.getElementById('baud-custom-input');
const baudCustomConfirm = document.getElementById('baud-custom-confirm');
const baudCustomCancel = document.getElementById('baud-custom-cancel');
const baudCustomDelete = document.getElementById('baud-custom-delete');
const connectBtn = document.getElementById('connect-btn');
const clearBtn = document.getElementById('clear-btn');
const throughputPanel = document.getElementById('throughput-panel');
const throughputRxChart = document.getElementById('throughput-rx-chart');
const throughputTxChart = document.getElementById('throughput-tx-chart');
const throughputRxRate = document.getElementById('throughput-rx-rate');
const throughputTxRate = document.getElementById('throughput-tx-rate');
let previousBaudRate = '115200';

function renderCustomBaudRates(customBaudRates, selectedBaudRate) {
    baudSelect.querySelectorAll('option[data-custom-baud-rate]').forEach(option => option.remove());
    const customAction = baudSelect.querySelector('option[value="custom"]');
    normalizeCustomBaudRates(customBaudRates).forEach(baudRate => {
        const option = document.createElement('option');
        option.value = baudRate;
        option.textContent = baudRate;
        option.dataset.customBaudRate = 'true';
        baudSelect.insertBefore(option, customAction);
    });
    const normalizedSelection = normalizeBaudRate(selectedBaudRate);
    if (normalizedSelection && Array.from(baudSelect.options).some(option => option.value === normalizedSelection)) {
        baudSelect.value = normalizedSelection;
    }
    syncBaudDeleteButton();
}

// 删除按钮只在「当前选中的是非标准波特率」时出现：
// 标准值是内置的删不掉；custom 是「添加」入口，本身不是一个可删的值。
function syncBaudDeleteButton() {
    if (!baudCustomDelete) return;
    const selected = normalizeBaudRate(baudSelect.value);
    baudCustomDelete.style.display = selected !== null && !isStandardBaudRate(selected) ? 'block' : 'none';
}

function closeCustomBaudInput(selectedBaudRate = previousBaudRate) {
    baudCustomInput.setCustomValidity('');
    baudCustomInput.value = '';
    baudCustomWrapper.style.display = 'none';
    baudSelect.style.display = 'block';
    renderCustomBaudRates(currentConfig?.customBaudRates, selectedBaudRate);
}

// 删除当前选中的自定义波特率。
//
// 只允许删自定义项：标准值是内置的，删了下次渲染还会回来。删除正在使用的
// 波特率必须回落到一个仍然存在的值，否则 <select> 会停在不存在的位置，
// 后续读取 baudSelect.value 得到空串，连接时参数非法。
function deleteSelectedCustomBaudRate() {
    const selected = normalizeBaudRate(baudSelect.value);
    if (!selected || isStandardBaudRate(selected)) return;
    const remaining = normalizeCustomBaudRates(currentConfig?.customBaudRates)
        .filter(rate => rate !== selected);
    if (currentConfig) currentConfig.customBaudRates = remaining;
    // 删掉的正好是当前生效值时回落到默认值；否则保持当前选择不变。
    const nextBaudRate = previousBaudRate === selected ? '9600' : previousBaudRate;
    previousBaudRate = nextBaudRate;
    renderCustomBaudRates(remaining, nextBaudRate);
    applySerialParameterChange({ reconnect: true });
    setActionStatus(trFallback('main.customBaudRateDeleted', 'Custom baud rate removed'));
}

function restoreBaudRateConfig(config) {
    const savedBaudRate = normalizeBaudRate(config.lastSerialOptions?.baudRate) || '9600';
    const customBaudRates = normalizeCustomBaudRates([
        ...normalizeCustomBaudRates(config.customBaudRates),
        ...(!isStandardBaudRate(savedBaudRate) ? [savedBaudRate] : [])
    ]);
    config.customBaudRates = customBaudRates;
    previousBaudRate = savedBaudRate;
    closeCustomBaudInput(savedBaudRate);
}

function confirmCustomBaudRate() {
    const baudRate = normalizeBaudRate(baudCustomInput.value);
    if (!baudRate) {
        const message = trFallback('main.invalidCustomBaudRate', 'Enter a positive whole-number baud rate');
        baudCustomInput.setCustomValidity(message);
        baudCustomInput.reportValidity();
        setActionStatus(message);
        return;
    }
    baudCustomInput.setCustomValidity('');
    const customBaudRates = normalizeCustomBaudRates([...(currentConfig?.customBaudRates || []), baudRate]);
    if (currentConfig) currentConfig.customBaudRates = customBaudRates;
    previousBaudRate = baudRate;
    closeCustomBaudInput(baudRate);
    applySerialParameterChange({ reconnect: true });
}

baudSelect.addEventListener('change', () => {
    if (baudSelect.value === 'custom') {
        baudSelect.style.display = 'none';
        baudCustomWrapper.style.display = 'flex';
        baudCustomInput.focus();
        return;
    }
    previousBaudRate = normalizeBaudRate(baudSelect.value) || previousBaudRate;
    syncBaudDeleteButton();
    applySerialParameterChange({ reconnect: true });
});

baudCustomConfirm.addEventListener('click', confirmCustomBaudRate);
baudCustomCancel.addEventListener('click', () => closeCustomBaudInput());
baudCustomDelete?.addEventListener('click', deleteSelectedCustomBaudRate);
baudCustomInput.addEventListener('input', () => baudCustomInput.setCustomValidity(''));
baudCustomInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        confirmCustomBaudRate();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        closeCustomBaudInput();
    }
});

['data-bits-select', 'stop-bits-select', 'parity-select'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', saveSerialModeConfig);
});

function applySerialParameterChange({ reconnect = false } = {}) {
    saveSerialModeConfig();
    // 参数属于激活分组：是否重连必须看**这一组**的连接态，不能用全局 isConnected。
    const groupId = resolveSerialGroupId(activeGroupId);
    if (reconnect && isGroupConnected(groupId) && !isGroupConnecting(groupId) && !isGroupReconnecting(groupId)) {
        reconnectSerialFromUi({ groupId });
    }
}

function getBaudRate() {
    // 激活分组自己的波特率。刷新端口列表时若换成默认分组的缓存值，会把用户刚选的
    // 波特率改回去，接着连上的就不是他选的那个速率。
    const group = getSerialGroupById(activeGroupId);
    return normalizeBaudRate(baudSelect.value)
        || normalizeBaudRate(group?.serialOptions?.baudRate)
        || previousBaudRate
        || '115200';
}

const refreshBtn = document.getElementById('refresh-btn');

// 默认分组的连接态镜像。多串口下每个分组各有自己的连接态（真相源是 serialGroupRegistry），
// 这个变量只服务默认分组的历史读法；任何「当前分组」的判断都必须走 isGroupConnected()。
let isConnected = false;

// 正在连接中的分组集合。
//
// 以前这是一个全局布尔 serialConnectInProgress：一个分组在连的时候，另一个分组的连接点击
// 会被静默丢弃，用户看到的是「点了没反应」。按分组的连接是并行的，锁也必须按分组。
const serialConnectingGroups = new Set();

function isGroupConnecting(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    return serialConnectingGroups.has(resolveSerialGroupId(groupId));
}

// 重连中的分组集合，同样必须按分组。
const serialReconnectingGroups = new Set();

function isGroupReconnecting(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    return serialReconnectingGroups.has(resolveSerialGroupId(groupId));
}

const DEFAULT_SERIAL_GROUP_ID = 'default';

ensureThroughputSvg(throughputRxChart, 'rx');
ensureThroughputSvg(throughputTxChart, 'tx');
updateThroughputPanel({
    connected: false,
    rxHistory: Array(THROUGHPUT_BAR_COUNT).fill(0),
    txHistory: Array(THROUGHPUT_BAR_COUNT).fill(0),
    rxBytesPerSecond: 0,
    txBytesPerSecond: 0
});

async function refreshPorts() {
    // 首选值必须取自**激活分组**。
    // 以前兑底到 `currentConfig.lastSerialOptions.path`（默认分组的端口），
    // 于是设备被拔掉后刷一次列表，默认分组的端口又会被重新选中，
    // 用户看到的就是「拔了卡但端口还在」。
    const group = getSerialGroupById(activeGroupId);
    const selectedPath = portSelect.value;
    const preferredPath = selectedPath || (typeof group?.portPath === 'string' ? group.portPath : '');
    const ports = await ipcRenderer.invoke('list-ports');
    portSelect.innerHTML = '<option value="">Select Port</option>';
    let hasPreferredPath = false;
    ports.forEach(port => {
        const opt = document.createElement('option');
        opt.value = port.path;
        opt.textContent = `${port.path} ${port.manufacturer || ''}`;
        if (preferredPath === port.path) {
            opt.selected = true;
            hasPreferredPath = true;
        }
        portSelect.appendChild(opt);
    });
    // 重建列表后 <select> 默认停在第一项（占位），这里显式对齐：
    // 目标不存在就停占位，绝不能留在上一个分组的端口上。
    portSelect.value = hasPreferredPath ? preferredPath : '';
    setActionStatus(`已刷新串口列表，共 ${ports.length} 个端口`);
}

refreshBtn.addEventListener('click', refreshPorts);

portSelect.addEventListener('change', () => {
    // 侧栏端口选择器编辑的是**激活分组**：切分组前若该组正连着，换端口必须断它自己的连接，
    // 不能用全局 isConnected（那是默认分组的状态）。
    const groupId = resolveSerialGroupId(activeGroupId);
    // 端口要落到分组自己的 portPath 上：开启「跟随端口」的分组靠它决定标签名，
    // 不写进去就会出现「端口变了但标签还叫旧端口」。
    const portGroup = getSerialGroupById(groupId);
    if (portGroup) {
        portGroup.portPath = portSelect.value || '';
        persistSerialGroups();
        syncGroupTitlesForPortChange(groupId);
    }
    if (isGroupConnected(groupId) && !isGroupConnecting(groupId)) {
        disconnectSerial(groupId);
        setActionStatus(trFallback('main.serialDisconnected', 'Serial port disconnected'));
    }
});

// 优先清空焦点终端；没有焦点时回落到当前控制组的激活终端。
function clearActiveTerminal() {
    const target = getCurrentTerminalTarget();
    if (target.term) clearTerminalByTabId(target.id);
}

// 侧栏「清空所有 Log 标签页」的清理范围必须按分组展开。
//
// filterTabs 与 shellTabs 都是模块级别名，只指向一个分组。直接遍历它们
// 会让「清空所有」只清掉别名所在分组的那几页，其它分组的过滤页全部漏掉——
// 而按钮名字承诺的是「所有」。
//
// 主标签同理：每个分组都有自己的主终端（tab-main / tab-main-<g>），
// 必须逐个分组取 id，不能写死 'tab-main'。
function clearAllLogTabs() {
    serialGroups.forEach(group => {
        clearTerminalByTabId(mainTabId(group.id));
        filterTabsStore.getList(group.id).forEach(tab => clearTerminalByTabId(tab.id));
    });
    // Shell 不归属任何分组，只清一次；是否包含 Shell 由设置项决定。
    if (currentConfig?.clearAllLogsIncludesShell === true) {
        shellTabs.forEach(tab => clearTerminalByTabId(tab.id));
    }
}

clearBtn.addEventListener('click', clearActiveTerminal);
clearAllLogsBtn?.addEventListener('click', clearAllLogTabs);

const openLogFolderBtn = document.getElementById('open-log-folder-btn');
openLogFolderBtn.addEventListener('click', () => {
    ipcRenderer.send('open-log-folder');
    setActionStatus('已打开日志文件夹');
});

// 当前终端操作只解析全局焦点；控制组继续独立负责串口设置和发送。
function getCurrentTerminalTarget() {
    const id = workspaceModel?.focusedTabId || focusedWorkspaceTabId || getGroupActiveTabId(activeGroupId);
    const shell = getShellTabState(id);
    if (shell) return { id, kind: 'shell', groupId: null, label: shell.title || getShellTabLogTitle(shell), term: shell.term, addon: shell.searchAddon };
    for (const group of serialGroups) {
        if (id === mainTabId(group.id)) {
            const runtime = serialRuntimes.get(group.id);
            return { id, kind: 'main', groupId: group.id, label: getMainTabTitle(group.id), term: runtime?.term || null, addon: runtime?.searchAddon || null };
        }
        const filter = filterTabsStore.getList(group.id).find(tab => tab.id === id);
        if (filter) return { id, kind: 'filter', groupId: group.id, label: getFilterTabLogTitle(filter), term: filter.term, addon: filter.searchAddon };
        const chart = chartTabsStore.getList(group.id).find(tab => tab.id === id);
        if (chart) return { id, kind: 'chart', groupId: group.id, label: chart.title || id, term: null, addon: null };
    }
    return { id, kind: null, groupId: null, label: id || '', term: null, addon: null };
}

function getActiveTerminalExport() {
    const target = getCurrentTerminalTarget();
    return target.term ? { title: target.label, content: getTerminalPlainText(target.term) } : null;
}

document.getElementById('save-current-tab-btn').addEventListener('click', async () => {
    try {
        const target = getActiveTerminalExport();
        if (!target) { setActionStatus('当前标签页没有终端可供导出'); return; }
        const result = await ipcRenderer.invoke('save-current-tab-log', target);
        if (result?.filePath) {
            setActionStatus(trFallback('main.currentTabSaved', 'Current tab saved: {path}', { path: result.filePath }));
        }
    } catch (error) {
        setActionStatus(trFallback('main.currentTabSaveFailed', 'Failed to save current tab: {error}', {
            error: error?.message || String(error)
        }));
    }
});

// 读取**指定分组**的连接参数。
//
// 侧栏控件是激活分组的实时编辑器：只有目标分组就是激活分组时，才把控件值回写到该分组；
// 否则从该分组自己的 serialOptions 读，避免用另一个分组的端口去连它。
function getGroupSerialOptionsForConnect(groupId) {
    const id = resolveSerialGroupId(groupId);
    if (id === activeGroupId) persistActiveGroupSerialOptions();
    const group = getSerialGroupById(id);
    const options = group?.serialOptions || {};
    return {
        path: group?.portPath || '',
        baudRate: normalizeBaudRate(options.baudRate) || '9600',
        dataBits: String(options.dataBits || '8'),
        stopBits: String(options.stopBits || '1'),
        parity: options.parity || 'none'
    };
}

async function connectSerialFromUi({ reconnecting = false, groupId = activeGroupId } = {}) {
    const targetGroupId = resolveSerialGroupId(groupId);
    if (isGroupConnecting(targetGroupId)) return;
    const targetGroup = getSerialGroupById(targetGroupId);
    if (!targetGroup) return;
    const targetRegistry = serialGroupRegistry.getGroup(targetGroupId);
    const requestToken = ++serialConnectRequestSequence;
    serialConnectRequests.set(targetGroupId, requestToken);
    const isCurrent = () => Boolean(getSerialGroupById(targetGroupId))
        && serialGroupRegistry.getGroup(targetGroupId) === targetRegistry
        && serialConnectRequests.get(targetGroupId) === requestToken;

    const settings = getGroupSerialOptionsForConnect(targetGroupId);
    const path = settings.path;
    if (!path) {
        setActionStatus(trFallback('main.selectPort', 'Select Port'));
        return;
    }

    // 侧栏的换行选择属于**这个分组**。只有目标分组就是激活分组时，控件才代表它；
    // 否则写入会把另一个分组的换行模式改成当前屏幕上显示的那个。
    const newlineEl = document.getElementById('newline-mode-select');
    if (targetGroupId === activeGroupId && newlineEl) {
        setGroupDisplay(targetGroupId, { newlineMode: newlineEl.value });
    }
    const targetDisplay = getGroupDisplay(targetGroupId);

    serialConnectingGroups.add(targetGroupId);
    setGroupConnectBusy(targetGroupId, true);
    // 新会话开始，该分组的 HEX 偏移与文本解码状态都要重置。
    getHexFormatter(targetGroupId).reset({ resetOffset: true });
    resetTextReceive(targetGroupId);
    serialWriteChains.delete(targetGroupId);
    resetQuickTriggerReceive(targetGroupId);
    if (reconnecting) setActionStatus(`正在应用新的波特率 ${settings.baudRate}...`);
    try {
        const connectResult = await ipcRenderer.invoke('connect-serial', {
            groupId: targetGroupId,
            requestId: requestToken,
            path,
            baudRate: settings.baudRate,
            dataBits: settings.dataBits,
            stopBits: settings.stopBits,
            parity: settings.parity,
            sendEncoding: targetDisplay.sendEncoding,
            newlineMode: targetDisplay.newlineMode
        });
        if (!isCurrent()) return;
        // 连接成功后把主进程分配的会话号登记进该分组的注册表，后续字节归属以它为准。
        // serialSessionId 只在默认分组时同步，其它分组的会话号由注册表持有。
        const nextSessionId = serialGroupRegistry.beginSession(targetGroupId, connectResult?.sessionId);
        serialConnectionSessions.set(targetGroupId, nextSessionId);
        if (targetGroupId === REGISTRY_DEFAULT_GROUP_ID) serialSessionId = nextSessionId;
        // 新会话开始，该分组的图表离线数据必须清掉；与是否激活无关。
        chartTabsStore.getList(targetGroupId).forEach(clearChartDataSession);

        ipcRenderer.send('save-config', {
            lastSerialOptions: {
                path,
                baudRate: settings.baudRate,
                dataBits: settings.dataBits,
                stopBits: settings.stopBits,
                parity: settings.parity,
                receiveDisplayMode: targetDisplay.receiveDisplayMode,
                receiveEncoding: targetDisplay.receiveEncoding,
                sendEncoding: targetDisplay.sendEncoding,
                newlineMode: targetDisplay.newlineMode
            }
        });

        // isConnected 只是默认分组的镜像；每组的真相在注册表里。
        if (targetGroupId === REGISTRY_DEFAULT_GROUP_ID) {
            updateSerialConnectionState(true);
            updateAutoSendState();
        }
        // 侧栏按钮显示的是**激活分组**的连接态，无论刚连的是哪一组都要重算。
        refreshConnectButtonState();
        // 连接成功后分组标签的指示竖线要立刻变绿。
        renderSerialGroupTabBar();
        syncAllGroupMainTabTitles();

        serialGroupContext.resetLineCounters(targetGroupId);

        // 必须 getOrCreate：getSerialTerm 在该分组还没有终端时会静默回落到默认分组的终端，
        // 于是「Serial 2 已连接」的提示会写进 Serial 1 的画面。
        serialRuntimes.getOrCreate(targetGroupId).term.write(`\r\n\x1b[32m--- Connected to ${path} at ${settings.baudRate} baud (${settings.dataBits}N${settings.stopBits}) ---\x1b[0m\r\n`);
        // 非默认分组的终端是刚建出来的，键盘输入要在这里补绑。
        bindGroupTerminalInput(targetGroupId);
    } catch (err) {
        if (!isCurrent()) return;
        // 主进程用 `SERIAL_PORT_IN_USE|端口|占用分组|英文原文` 回传「两个分组抢同一个端口」。
        // 这类错误是配置冲突而不是句柄故障，必须给用户一句能直接读懂的话，
        // 否则他看到的只是 Electron 包装过的 `Error invoking remote method ...`。
        const raw = String(err?.message || err);
        const portInUse = raw.match(/SERIAL_PORT_IN_USE\|([^|]*)\|([^|]*)\|(.*)/);
        if (portInUse) {
            const [, portName, ownerGroupId] = portInUse;
            const ownerName = getSerialGroupById(ownerGroupId)?.title || ownerGroupId;
            const message = trFallback(
                'main.serialPortInUse',
                'Port {port} is already open in {group}. Disconnect it there first.',
                { port: portName, group: ownerName }
            );
            setActionStatus(message);
            alert(message);
        } else {
            setActionStatus(reconnecting ? `串口重连失败：${raw}` : `串口连接失败：${raw}`);
            alert((reconnecting ? 'Failed to reconnect: ' : 'Failed to connect: ') + raw);
        }
    } finally {
        if (!isCurrent()) return;
        serialConnectingGroups.delete(targetGroupId);
        setGroupConnectBusy(targetGroupId, false);
        refreshConnectButtonState();
    }
}

async function reconnectSerialFromUi({ groupId = activeGroupId } = {}) {
    const targetGroupId = resolveSerialGroupId(groupId);
    if (isGroupReconnecting(targetGroupId) || isGroupConnecting(targetGroupId)) return;
    if (!isGroupConnected(targetGroupId)) {
        await connectSerialFromUi({ reconnecting: true, groupId: targetGroupId });
        return;
    }

    const targetRegistry = serialGroupRegistry.getGroup(targetGroupId);
    const isCurrent = () => Boolean(getSerialGroupById(targetGroupId))
        && serialGroupRegistry.getGroup(targetGroupId) === targetRegistry;
    const baudRate = getGroupSerialOptionsForConnect(targetGroupId).baudRate;
    serialReconnectingGroups.add(targetGroupId);
    setGroupConnectBusy(targetGroupId, true);
    setActionStatus(`正在应用新的波特率 ${baudRate}...`);
    try {
        // 必须等**这一组**的断开事件，否则换波特率会在端口还没关掉时就重连。
        const disconnected = waitForSerialDisconnected(targetGroupId);
        disconnectSerial(targetGroupId);
        const completed = await disconnected;
        if (completed === false || !isCurrent()) return;
        await connectSerialFromUi({ reconnecting: true, groupId: targetGroupId });
    } finally {
        if (!isCurrent()) return;
        serialReconnectingGroups.delete(targetGroupId);
        if (!isGroupConnecting(targetGroupId)) setGroupConnectBusy(targetGroupId, false);
        refreshConnectButtonState();
    }
}

async function toggleSerialConnection() {
    // 侧栏连接按钮永远作用于**当前激活的分组**：
    // 以前这里不带 groupId，于是切到 Serial 2 点连接，连上的是 Serial 1。
    const groupId = resolveSerialGroupId(activeGroupId);
    if (isGroupConnecting(groupId) || isGroupReconnecting(groupId)) return;
    hideQuickSendDisconnectedToast();
    if (isGroupConnected(groupId)) {
        await disconnectSerial(groupId);
    } else {
        await connectSerialFromUi({ groupId });
    }
}

connectBtn.addEventListener('click', toggleSerialConnection);

// ---- 多串口分组：UI 事件 -------------------------------------------------

// 「添加串口」：新建分组后保持 disconnected，等用户手动点连接。
// 两个入口共用同一个处理函数：静态那个在分组栏（多分组可见），
// inline 那个在 pane 标签行（单分组可见），syncSerialGroupAddButtonLayer 负责两者显隐互斥。
addSerialGroupBtn?.addEventListener('click', () => {
    addSerialGroupFromUi();
});
addSerialGroupInlineBtn?.addEventListener('click', () => {
    addSerialGroupFromUi();
});

// 「新建 Shell」分两层（见 syncShellAddButtonVisibility）：单分组走 pane 行那个静态按钮，
// 多分组走分组标签行里这个。两者不会同时可见，但都指向同一个创建路径。
addShellTabBtn?.addEventListener('click', () => {
    createShellTab({ profileId: getDefaultShellProfileId() }, getActivePane()?.id || groupPaneId(activeGroupId, 1));
});

// refreshPorts(); // Moved to config load chain

window.addEventListener('resize', () => {
    fitWorkspaceTerminals();
});

// Search Logic
const searchInput = document.getElementById('search-input');
const searchTargetLabel = document.getElementById('search-target-label');
const findNextBtn = document.getElementById('find-next-btn');
const findPrevBtn = document.getElementById('find-prev-btn');
const searchRegex = document.getElementById('search-regex');
const searchCase = document.getElementById('search-case');
const searchWord = document.getElementById('search-word');
const searchResultCount = document.getElementById('search-result-count');
const searchHistoryList = document.getElementById('search-history-list');
let searchDebounceTimer = null;
let searchHistory = [];
const searchState = {
    queryKey: '',
    cacheKey: '',
    total: 0,
    current: 0,
    regexError: '',
    matches: []
};
let activeSearchDecoration = null;

function isSearchPanelVisible() {
    const sidebarElement = document.getElementById('sidebar');
    const searchPane = document.getElementById('tab-search');
    return Boolean(searchPane?.classList.contains('active') && !sidebarElement?.classList.contains('sidebar-collapsed'));
}

function observeTerminalSearchChanges(term) {
    unobserveTerminalSearchChanges(term);
    const tracker = createTerminalRevisionTracker(term, changedTerm => {
        const target = getActiveSearchTarget();
        if (target.term === changedTerm && searchInput.value && isSearchPanelVisible()) {
            scheduleSearchRefresh();
        }
    });
    terminalSearchTrackers.set(term, tracker);
    return tracker;
}

function unobserveTerminalSearchChanges(term) {
    const tracker = terminalSearchTrackers.get(term);
    tracker?.dispose();
    terminalSearchTrackers.delete(term);
    if (activeSearchDecoration?.term === term) clearSearchSelection();
}

function invalidateTerminalSearch(term, reason, { clearAnchor = false } = {}) {
    terminalSearchTrackers.get(term)?.invalidate(reason);
    if (clearAnchor && activeSearchDecoration?.term === term) {
        clearSearchSelection();
        searchState.current = 0;
    }
}

function getTerminalSearchRevision(term) {
    return terminalSearchTrackers.get(term)?.revision || 0;
}

// 搜索与导出、清空共用焦点身份，无终端的图表不回落到其他组。
function getActiveSearchTarget() {
    return getCurrentTerminalTarget();
}

function updateSearchTargetLabel() {
    if (!searchTargetLabel) return;
    const target = getActiveSearchTarget();
    searchTargetLabel.textContent = trFallback('main.searchTarget', 'Target: {target}', { target: target.label });
}

function setSearchButtonsEnabled(enabled) {
    if (findNextBtn) findNextBtn.disabled = !enabled;
    if (findPrevBtn) findPrevBtn.disabled = !enabled;
}

function clearSearchDecorations(addon) {
    if (typeof addon?.clearDecorations === 'function') addon.clearDecorations();
    else if (typeof addon?.clearActiveDecoration === 'function') addon.clearActiveDecoration();
}

function disposeActiveSearchDecoration() {
    activeSearchDecoration?.decoration?.dispose();
    activeSearchDecoration?.marker?.dispose();
    activeSearchDecoration = null;
}

function clearSearchSelection(target = getActiveSearchTarget()) {
    disposeActiveSearchDecoration();
    clearSearchDecorations(target.addon);
    if (typeof target.term?.clearSelection === 'function') target.term.clearSelection();
}

function createActiveSearchDecoration(term, marker, column, length) {
    if (typeof term?.registerDecoration !== 'function') return null;
    return term.registerDecoration({
        marker,
        x: column,
        width: length,
        backgroundColor: highlightColors.search.background,
        foregroundColor: highlightColors.search.foreground,
        layer: 'top'
    }) || null;
}

function decorateActiveSearchMatch(term, match) {
    disposeActiveSearchDecoration();
    const buffer = term.buffer?.active;
    if (buffer?.type !== 'normal' || typeof term?.registerMarker !== 'function') return false;
    const cursorLine = (buffer.baseY || 0) + (buffer.cursorY || 0);
    const marker = term.registerMarker(match.line - cursorLine);
    if (!marker) return false;
    const decoration = createActiveSearchDecoration(term, marker, match.column, match.length);
    if (!decoration) {
        marker.dispose();
        return false;
    }
    activeSearchDecoration = {
        term,
        queryKey: searchState.queryKey,
        bufferType: buffer.type,
        decoration,
        marker,
        column: match.column,
        length: match.length
    };
    return true;
}

function redrawActiveSearchDecoration() {
    const active = activeSearchDecoration;
    if (!active) return;
    if (active.marker.isDisposed || active.marker.line < 0) {
        disposeActiveSearchDecoration();
        searchState.current = 0;
        return;
    }
    active.decoration?.dispose();
    active.decoration = createActiveSearchDecoration(active.term, active.marker, active.column, active.length);
    if (!active.decoration) disposeActiveSearchDecoration();
}

function updateSearchResultCount(current = 0, resultCount = 0, regexError = '') {
    if (!searchResultCount) return;

    if (!searchInput.value) {
        searchResultCount.textContent = tr('main.searchResultEmpty');
        setSearchButtonsEnabled(false);
        return;
    }

    if (regexError) {
        searchResultCount.textContent = trFallback('main.searchRegexInvalid', 'Invalid regex: {error}', { error: regexError });
        setSearchButtonsEnabled(false);
        return;
    }

    if (!resultCount) {
        searchResultCount.textContent = tr('main.searchResultZero');
        setSearchButtonsEnabled(false);
        return;
    }

    setSearchButtonsEnabled(true);
    searchResultCount.textContent = tr('main.searchResultCount', {
        current,
        total: resultCount
    });
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRegex() {
    const term = searchInput.value;
    if (!term) return { regex: null, error: '' };

    let pattern = term;
    if (!searchRegex.checked) {
        pattern = escapeRegex(pattern);
    }
    if (searchWord.checked) {
        pattern = `\\b(?:${pattern})\\b`;
    }

    try {
        return { regex: new RegExp(pattern, searchCase.checked ? 'g' : 'gi'), error: '' };
    } catch (error) {
        return { regex: null, error: error.message || String(error) };
    }
}

function buildSearchQueryKey(target) {
    return JSON.stringify({
        query: searchInput.value,
        regex: searchRegex.checked,
        caseSensitive: searchCase.checked,
        wholeWord: searchWord.checked,
        target: target.id,
        bufferType: target.term?.buffer?.active?.type || 'normal'
    });
}

function buildSearchCacheKey(target, queryKey) {
    return `${queryKey}:${getTerminalSearchRevision(target.term)}`;
}

function getActiveSearchAnchor(target, queryKey) {
    const active = activeSearchDecoration;
    if (!active || active.term !== target.term || active.queryKey !== queryKey) return null;
    if (active.bufferType !== target.term?.buffer?.active?.type) return null;
    if (active.marker.isDisposed || active.marker.line < 0) return null;
    return { line: active.marker.line, column: active.column, length: active.length };
}

function clearSearchResults(target, regexError = '') {
    searchState.total = 0;
    searchState.current = 0;
    searchState.regexError = regexError;
    searchState.matches = [];
    clearSearchSelection(target);
    updateSearchResultCount(0, 0, regexError);
    return searchState;
}

function refreshSearchCount({ force = false } = {}) {
    updateSearchTargetLabel();
    const target = getActiveSearchTarget();
    const queryKey = buildSearchQueryKey(target);
    const cacheKey = buildSearchCacheKey(target, queryKey);
    if (!force && cacheKey === searchState.cacheKey) {
        updateSearchResultCount(searchState.current, searchState.total, searchState.regexError);
        return searchState;
    }

    const anchor = getActiveSearchAnchor(target, queryKey);
    searchState.queryKey = queryKey;
    searchState.cacheKey = cacheKey;
    const { regex, error } = buildSearchRegex();
    searchState.regexError = error;
    if (!regex) return clearSearchResults(target, error);

    const buffer = target.term.buffer.active;
    const matches = [];
    for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        const text = line ? line.translateToString(true) : '';
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const value = match[0] || '';
            matches.push({ line: i, column: match.index, length: Math.max(1, value.length) });
            if (value.length === 0) regex.lastIndex++;
        }
    }

    searchState.matches = matches;
    searchState.total = matches.length;
    if (!searchState.total) return clearSearchResults(target);

    const anchoredIndex = findAnchoredMatchIndex(matches, anchor);
    searchState.current = anchoredIndex >= 0 ? anchoredIndex + 1 : 0;
    if (anchoredIndex < 0 && activeSearchDecoration) clearSearchSelection(target);
    updateSearchResultCount(searchState.current, searchState.total);
    return searchState;
}

function scheduleSearchRefresh() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => refreshSearchCount(), 200);
}

function resetSearchState() {
    searchState.queryKey = '';
    searchState.cacheKey = '';
    searchState.total = 0;
    searchState.current = 0;
    searchState.regexError = '';
    searchState.matches = [];
}

function scrollSearchMatchIntoCenter(term, line) {
    if (typeof term?.scrollToLine !== 'function') return;
    const visibleRows = Math.max(1, Number(term.rows) || 1);
    term.scrollToLine(Math.max(0, line - Math.floor(visibleRows / 2)));
}

function selectSearchMatch(index) {
    const target = getActiveSearchTarget();
    if (!searchState.total || index < 1 || index > searchState.total) {
        clearSearchSelection(target);
        return false;
    }
    const match = searchState.matches[index - 1];
    if (!match) return false;
    scrollSearchMatchIntoCenter(target.term, match.line);
    target.term.clearSelection?.();
    decorateActiveSearchMatch(target.term, match);
    searchState.current = index;
    updateSearchResultCount(searchState.current, searchState.total);
    return true;
}

function getSearchOptions() {
    return {
        regex: searchRegex.checked,
        caseSensitive: searchCase.checked,
        wholeWord: searchWord.checked,
        incremental: false 
    };
}

function getSearchHistoryLimit() {
    return currentConfig?.searchSettings?.historyLimit ?? 20;
}

function applySearchHistoryConfig(config) {
    searchHistory = normalizeSearchHistory(config?.searchHistory, config?.searchSettings?.historyLimit ?? 20);
    renderSearchHistory();
}

function persistSearchHistory(nextHistory) {
    searchHistory = nextHistory;
    if (currentConfig) currentConfig.searchHistory = searchHistory;
    renderSearchHistory();
    ipcRenderer.send('save-config', { searchHistory });
}

function recordCurrentSearch() {
    if (!searchInput.value) return;
    persistSearchHistory(recordSearchHistory(searchHistory, {
        query: searchInput.value,
        regex: searchRegex.checked,
        caseSensitive: searchCase.checked,
        wholeWord: searchWord.checked
    }, getSearchHistoryLimit()));
}

function applySearchHistoryItem(item) {
    searchInput.value = item.query;
    searchRegex.checked = item.regex;
    searchCase.checked = item.caseSensitive;
    searchWord.checked = item.wholeWord;
    resetSearchState();
    clearSearchSelection();
    navigateSearch('next');
    searchInput.focus();
}

function createSearchHistoryOptionIcon(name, title) {
    const icon = createMaterialIcon(name, 'search-history-option-icon');
    icon.title = title;
    return icon;
}

function renderSearchHistory() {
    if (!searchHistoryList) return;
    searchHistoryList.replaceChildren();
    if (!searchHistory.length) {
        const empty = document.createElement('div');
        empty.className = 'search-history-empty';
        empty.textContent = tr('main.searchHistoryEmpty');
        searchHistoryList.appendChild(empty);
        return;
    }

    searchHistory.forEach(item => {
        const row = document.createElement('div');
        row.className = `search-history-item${item.pinned ? ' pinned' : ''}`;

        const replayBtn = document.createElement('button');
        replayBtn.type = 'button';
        replayBtn.className = 'search-history-replay';
        replayBtn.title = item.query;
        replayBtn.onclick = () => applySearchHistoryItem(item);
        const query = document.createElement('span');
        query.className = 'search-history-query';
        query.textContent = item.query;
        replayBtn.appendChild(query);
        const options = document.createElement('span');
        options.className = 'search-history-options';
        if (item.regex) options.appendChild(createSearchHistoryOptionIcon('regular_expression', tr('main.regex')));
        if (item.caseSensitive) options.appendChild(createSearchHistoryOptionIcon('match_case', tr('main.caseSensitive')));
        if (item.wholeWord) options.appendChild(createSearchHistoryOptionIcon('match_word', tr('main.wholeWord')));
        replayBtn.appendChild(options);

        const pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'search-history-action search-history-pin';
        pinBtn.classList.toggle('active', item.pinned);
        const pinLabel = tr(item.pinned ? 'main.unpinSearchHistory' : 'main.pinSearchHistory', { query: item.query });
        pinBtn.title = pinLabel;
        pinBtn.setAttribute('aria-label', pinLabel);
        pinBtn.appendChild(createMaterialIcon('push_pin'));
        pinBtn.onclick = () => persistSearchHistory(setSearchHistoryPinned(
            searchHistory,
            item.id,
            !item.pinned,
            getSearchHistoryLimit()
        ));

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'search-history-action search-history-delete';
        const deleteLabel = tr('main.deleteSearchHistory', { query: item.query });
        deleteBtn.title = deleteLabel;
        deleteBtn.setAttribute('aria-label', deleteLabel);
        deleteBtn.appendChild(createMaterialIcon('delete'));
        deleteBtn.onclick = () => persistSearchHistory(deleteSearchHistoryItem(
            searchHistory,
            item.id,
            getSearchHistoryLimit()
        ));

        row.append(replayBtn, pinBtn, deleteBtn);
        searchHistoryList.appendChild(row);
    });
}

function navigateSearch(direction) {
    recordCurrentSearch();
    refreshSearchCount();
    if (searchState.regexError || !searchState.total) return;
    const index = resolveNavigationIndex(direction, searchState.current, searchState.total);
    selectSearchMatch(index);
}

findNextBtn.addEventListener('click', () => navigateSearch('next'));
findPrevBtn.addEventListener('click', () => navigateSearch('previous'));

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        navigateSearch(e.shiftKey ? 'previous' : 'next');
    }
});

searchInput.addEventListener('input', () => {
    resetSearchState();
    clearSearchSelection();
    if (!searchInput.value) {
        clearTimeout(searchDebounceTimer);
        updateSearchResultCount(0, 0);
        return;
    }
    scheduleSearchRefresh();
});

[searchRegex, searchCase, searchWord].forEach(control => {
    control.addEventListener('change', () => {
        resetSearchState();
        clearSearchSelection();
        if (!searchInput.value) {
            updateSearchResultCount(0, 0);
            return;
        }
        refreshSearchCount();
    });
});

window.addEventListener('workspace-focus-changed', () => {
    clearTimeout(searchDebounceTimer);
    resetSearchState();
    clearSearchSelection();
    updateSearchTargetLabel();
    if (!searchInput.value) {
        updateSearchResultCount(0, 0);
        return;
    }
    refreshSearchCount();
});

observeTerminalSearchChanges(serialTerm);
updateSearchTargetLabel();
updateSearchResultCount(0, 0);

// Remove legacy filter window btn reference
// document.getElementById('new-filter-window-btn').addEventListener('click', ...);

// --- Auto Send & Quick Send Logic ---

let autoSendTimer = null;
let autoSendInFlight = false;
let autoSendGeneration = 0;
let appliedAutoSendKey = '';
const autoSendEnableCb = document.getElementById('auto-send-enable');
const autoSendIntervalInput = document.getElementById('auto-send-interval');
const autoSendTextInput = document.getElementById('auto-send-text');
const autoSendValidation = document.getElementById('auto-send-validation');

const quickSendListEl = document.getElementById('quick-send-list');
const sidebarQuickSendListEl = document.getElementById('sidebar-quick-send-list');
const quickSendAutoTriggerEnableInput = document.getElementById('quick-send-auto-trigger-enable');
const openQuickSendDialogBtn = document.getElementById('open-quick-send-dialog-btn');
const quickSendDialog = document.getElementById('quick-send-dialog');
const quickSendDialogTitle = document.getElementById('quick-send-dialog-title');
const quickSendDialogCloseBtn = document.getElementById('quick-send-dialog-close');
const quickSendDialogCancelBtn = document.getElementById('quick-send-dialog-cancel');
const quickSendLabelInput = document.getElementById('quick-send-label');
const quickSendGroupSelect = document.getElementById('quick-send-group-select');
const quickSendNewGroupNameInput = document.getElementById('quick-send-new-group-name');
const addQuickSendGroupBtn = document.getElementById('add-quick-send-group-btn');
const quickSendGroupDeleteDialog = document.getElementById('quick-send-group-delete-dialog');
const quickSendGroupDeleteMessage = document.getElementById('quick-send-group-delete-message');
const quickSendGroupDeleteCancelBtn = document.getElementById('quick-send-group-delete-cancel');
const quickSendGroupDeleteConfirmBtn = document.getElementById('quick-send-group-delete-confirm');
const quickSendGroupDialog = document.getElementById('quick-send-group-dialog');
const quickSendGroupDialogTitle = document.getElementById('quick-send-group-dialog-title');
const quickSendGroupDialogCloseBtn = document.getElementById('quick-send-group-dialog-close');
const quickSendGroupDialogCancelBtn = document.getElementById('quick-send-group-dialog-cancel');
const quickSendGroupDialogSaveBtn = document.getElementById('quick-send-group-dialog-save');
const quickSendGroupDialogSaveLabel = quickSendGroupDialogSaveBtn.querySelector('span:last-child');
const quickSendGroupNameInput = document.getElementById('quick-send-group-name');
const quickSendContentInput = document.getElementById('quick-send-content');
const quickSendModeInputs = Array.from(document.querySelectorAll('input[name="quick-send-mode"]'));
const quickSendAppendCrlfInput = document.getElementById('quick-send-append-crlf');
const quickSendTriggerEnableInput = document.getElementById('quick-send-trigger-enable');
const quickSendTriggerTextInput = document.getElementById('quick-send-trigger-text');
const quickSendTriggerRegexInput = document.getElementById('quick-send-trigger-regex');
const quickSendTriggerCaseInput = document.getElementById('quick-send-trigger-case');
const quickSendTriggerWordInput = document.getElementById('quick-send-trigger-word');
const quickSendSidebarEnableInput = document.getElementById('quick-send-sidebar-enable');
const quickSendSidebarTextInput = document.getElementById('quick-send-sidebar-text');
const quickSendSidebarColorInput = document.getElementById('quick-send-sidebar-color');
const quickSendSidebarControls = document.getElementById('quick-send-sidebar-controls');
const addQuickSendBtn = document.getElementById('add-quick-send-btn');
const addQuickSendBtnLabel = addQuickSendBtn.querySelector('span:last-child');
const quickSendValidation = document.getElementById('quick-send-validation');

let quickSendList = [];
let quickSendGroups = [];
let sidebarQuickSendOrder = [];
let quickSendAutoTriggerEnabled = true;
let deletingQuickSendGroupId = '';
let quickSendGroupDeleteTrigger = null;
let editingQuickSendGroupId = '';
let quickSendGroupDialogTrigger = null;
let quickSendUngroupedCollapsed = false;
let quickSendGroupDragState = null;
const quickSendCollapseAnimations = new WeakMap();
const quickSendTriggerInFlight = new Set();
const quickSendFlashTimers = new WeakMap();
const quickSendClickTimers = new WeakMap();
let quickSendDisconnectedClicks = new WeakMap();
let quickSendDisconnectedToast = null;
let quickSendDisconnectedToastTimer = null;
let quickSendDisconnectedToastRemoveTimer = null;

function stopAutoSendRuntime() {
    autoSendGeneration++;
    if (autoSendTimer) clearTimeout(autoSendTimer);
    autoSendTimer = null;
    autoSendInFlight = false;
}

function getAutoSendRequest() {
    return {
        // 自动发送同样必须按**激活分组**路由：缺省会落到默认分组，于是「切到串口 2 组
        // 开自动发送」实际一直在往串口 1 写（实测 diag981：groupId 为 `<absent>`）。
        // 编码也取激活分组的值，与主输入框保持一致。
        groupId: activeGroupId,
        mode: 'text', content: autoSendTextInput.value,
        encoding: getGroupDisplay(activeGroupId).sendEncoding, appendCrLf: false,
        source: 'auto-send'
    };
}

function updateAutoSendValidation() {
    const request = getAutoSendRequest();
    const result = validateSendContent(request.mode, request.content, request.encoding, SEND_LIMITS.auto - (request.appendCrLf ? 2 : 0));
    autoSendValidation.textContent = formatValidation(result, request.mode, request.appendCrLf);
    autoSendValidation.classList.toggle('valid', result.ok);
    autoSendValidation.classList.toggle('invalid', !result.ok && request.content.length > 0);
    autoSendEnableCb.disabled = !result.ok;
    autoSendTextInput.placeholder = request.mode === 'hex' ? 'AA 55 01 FF' : tr('main.autoSendText');
    if (!result.ok && autoSendEnableCb.checked) {
        autoSendEnableCb.checked = false;
        stopAutoSendRuntime();
    }
    return result;
}

async function runAutoSendTick() {
    if (!autoSendEnableCb.checked || autoSendInFlight) return;
    const generation = autoSendGeneration;
    const interval = Math.max(10, Number.parseInt(autoSendIntervalInput.value, 10) || 1000);
    // 连接判据也必须按激活分组：全局 `isConnected` 只代表默认分组，于是
    // 「串口 2 组已连、串口 1 组未连」时自动发送会一直停在等连接。
    if (!isGroupConnected(activeGroupId)) {
        autoSendValidation.textContent = trFallback('main.autoSendWaiting', 'Waiting for serial connection');
        autoSendTimer = setTimeout(() => {
            if (generation === autoSendGeneration) runAutoSendTick();
        }, interval);
        return;
    }
    const request = getAutoSendRequest();
    if (!updateAutoSendValidation().ok) return;
    autoSendInFlight = true;
    const result = await sendSerialRequest(request, SEND_LIMITS.auto, { silent: true });
    if (generation !== autoSendGeneration) return;
    autoSendInFlight = false;
    if (!result.ok) {
        autoSendEnableCb.checked = false;
        stopAutoSendRuntime();
        setActionStatus(trFallback('main.autoSendStopped', 'Auto send stopped: {error}', { error: result.message || result.code }));
        saveAutoSendSettings();
        return;
    }
    autoSendValidation.textContent = trFallback('main.bytesSent', 'Sent {count} bytes', { count: result.bytesWritten });
    autoSendTimer = setTimeout(() => {
        if (generation === autoSendGeneration) runAutoSendTick();
    }, interval);
}

function updateAutoSendState() {
    stopAutoSendRuntime();
    if (autoSendEnableCb.checked && updateAutoSendValidation().ok) {
        const generation = autoSendGeneration;
        const interval = Math.max(10, Number.parseInt(autoSendIntervalInput.value, 10) || 1000);
        autoSendTimer = setTimeout(() => {
            if (generation === autoSendGeneration) runAutoSendTick();
        }, interval);
    }
}

function saveAutoSendSettings() {
    if (isApplyingConfig) return;
    const autoSendSettings = getAutoSendSettings();
    appliedAutoSendKey = JSON.stringify(autoSendSettings);
    ipcRenderer.send('save-config', { autoSendSettings });
}

function getAutoSendSettings() {
    return {
        enabled: autoSendEnableCb.checked,
        interval: Math.max(10, Number.parseInt(autoSendIntervalInput.value, 10) || 1000),
        content: autoSendTextInput.value
    };
}

function applyAutoSendConfig(settings) {
    const normalized = {
        enabled: settings.enabled === true,
        interval: Math.max(10, Number(settings.interval) || 1000),
        content: settings.content || ''
    };
    const settingsKey = JSON.stringify(normalized);
    if (settingsKey === appliedAutoSendKey) return false;
    appliedAutoSendKey = settingsKey;
    autoSendEnableCb.checked = normalized.enabled;
    autoSendIntervalInput.value = normalized.interval;
    autoSendTextInput.value = normalized.content;
    return true;
}

autoSendEnableCb.addEventListener('change', () => {
    updateAutoSendState();
    saveAutoSendSettings();
});

autoSendIntervalInput.addEventListener('change', () => {
    autoSendIntervalInput.value = Math.max(10, Number.parseInt(autoSendIntervalInput.value, 10) || 1000);
    updateAutoSendState();
    saveAutoSendSettings();
});
autoSendTextInput.addEventListener('input', updateAutoSendValidation);
autoSendTextInput.addEventListener('blur', saveAutoSendSettings);
let editingQuickSendId = '';
const QUICK_SEND_HOLD_MS = 420;
const QUICK_SEND_MOVE_THRESHOLD = 8;
const quickSendReorderContexts = [
    {
        container: quickSendListEl,
        compact: false,
        editMode: false,
        dragState: null,
        holdTimer: null,
        suppressClickUntil: 0
    },
    {
        container: sidebarQuickSendListEl,
        compact: true,
        editMode: false,
        dragState: null,
        holdTimer: null,
        suppressClickUntil: 0
    }
];

function getQuickSendReorderContext(compact) {
    return quickSendReorderContexts.find(context => context.compact === compact);
}

function getQuickSendReorderElements(context) {
    if (!context?.container) return [];
    return context.compact
        ? Array.from(context.container.children).filter(element => element.classList.contains('quick-send-item'))
        : Array.from(context.container.querySelectorAll('.quick-send-item'));
}

function clearQuickSendHoldTimer(context) {
    if (context?.holdTimer !== null) {
        clearTimeout(context.holdTimer);
        context.holdTimer = null;
    }
}

function syncQuickSendEditMode(context) {
    if (!context) return;
    context.container?.classList.toggle('quick-send-reorder-mode', context.editMode);
    getQuickSendReorderElements(context).forEach(element => {
        const isDragged = context.dragState?.element === element && context.dragState.dragging;
        element.setAttribute('aria-grabbed', isDragged ? 'true' : 'false');
        const deleteButton = element.querySelector('.quick-send-edit-delete-btn');
        if (deleteButton) {
            deleteButton.tabIndex = context.editMode ? 0 : -1;
            deleteButton.setAttribute('aria-hidden', context.editMode ? 'false' : 'true');
        }
    });
}

function applyQuickSendElementOrder(context, orderedIds) {
    if (context.compact) {
        sidebarQuickSendOrder = [...orderedIds];
        normalizeSidebarQuickSendOrder();
        return;
    }
    const byId = new Map(quickSendList.map(item => [item.id, item]));
    quickSendList = getQuickSendReorderElements(context).map(element => ({
        ...byId.get(element.dataset.quickId),
        groupId: element.closest('.quick-send-group')?.dataset.quickGroupId || null
    })).filter(item => item.id);
}

function cleanUpQuickSendDrag(context, state) {
    if (!context || !state || state.cleanedUp) return;
    state.cleanedUp = true;
    state.snapFallbackTimer && clearTimeout(state.snapFallbackTimer);
    state.expandTimer && clearTimeout(state.expandTimer);
    state.indicator?.remove();
    state.preview?.remove();
    state.element?.classList.remove('dragging', 'quick-send-drag-placeholder');
    try {
        if (state.element?.hasPointerCapture?.(state.pointerId)) {
            state.element.releasePointerCapture(state.pointerId);
        }
    } catch {
        // Pointer capture may already be released after pointerup/cancel.
    }
    if (context.dragState === state) context.dragState = null;
    syncQuickSendEditMode(context);
}

function cancelQuickSendDrag(context, { restoreOrder = true } = {}) {
    if (!context) return;
    clearQuickSendHoldTimer(context);
    const state = context.dragState;
    if (!state) return;
    const originalOrder = !state.committed && Array.isArray(state.originalOrder) ? state.originalOrder : null;
    const originalItems = !state.committed && Array.isArray(state.originalItems) ? state.originalItems : null;
    const originalGroups = !state.committed && Array.isArray(state.originalGroups) ? state.originalGroups : null;
    cleanUpQuickSendDrag(context, state);
    if (restoreOrder && (originalItems || originalOrder)) {
        if (context.compact) applyQuickSendElementOrder(context, originalOrder);
        else {
            quickSendList = originalItems;
            if (originalGroups) quickSendGroups = originalGroups;
        }
        renderQuickSendLists();
    }
}

function setQuickSendEditMode(context, enabled) {
    if (!context) return;
    const nextMode = enabled === true;
    if (!nextMode && context.dragState) {
        cancelQuickSendDrag(context, { restoreOrder: true });
    }
    context.editMode = nextMode;
    syncQuickSendEditMode(context);
}

function animateQuickSendReflow(previousRects, elements) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return;
    requestAnimationFrame(() => {
        elements.forEach(element => {
            const previous = previousRects.get(element.dataset.quickId);
            if (!previous || !element.isConnected) return;
            const current = element.getBoundingClientRect();
            const offset = previous.top - current.top;
            if (Math.abs(offset) < 1) return;
            element.animate([
                { transform: `translateY(${offset}px)` },
                { transform: 'translateY(0)' }
            ], {
                duration: 180,
                easing: 'cubic-bezier(.2,.8,.2,1)'
            });
        });
    });
}

function positionQuickSendIndicator(context, state) {
    if (!context?.container || !state.indicator?.isConnected) return;
    const listRect = context.container.getBoundingClientRect();
    const targetRect = state.element.getBoundingClientRect();
    const scrollOffset = context.compact ? 0 : context.container.scrollTop;
    state.indicator.style.top = `${targetRect.top - listRect.top + scrollOffset - 3}px`;
}

function updateQuickSendDropTarget(context, state, pointerY) {
    if (!context?.container || !state.dragging) return;
    if (!context.compact) {
        const groups = Array.from(context.container.querySelectorAll('.quick-send-group'));
        const targetGroup = groups.reduce((nearest, group) => {
            const rect = group.getBoundingClientRect();
            const distance = pointerY < rect.top ? rect.top - pointerY : (pointerY > rect.bottom ? pointerY - rect.bottom : 0);
            return !nearest || distance < nearest.distance ? { group, distance } : nearest;
        }, null)?.group;
        const body = targetGroup?.querySelector('.quick-send-group-items');
        if (!targetGroup || !body) return;
        const groupId = targetGroup.dataset.quickGroupId || null;
        const group = quickSendGroups.find(entry => entry.id === groupId);
        if (group?.collapsed && state.expandGroupId !== group.id) {
            clearTimeout(state.expandTimer);
            state.expandGroupId = group.id;
            state.expandTimer = setTimeout(() => {
                group.collapsed = false;
                state.temporarilyExpandedGroupIds.add(group.id);
                targetGroup.classList.remove('collapsed');
                targetGroup.querySelector('.quick-send-group-toggle')?.setAttribute('aria-expanded', 'true');
            }, 500);
        } else if (!group?.collapsed && state.expandGroupId !== (groupId || '')) {
            clearTimeout(state.expandTimer);
            state.expandGroupId = groupId || '';
        }
        const otherElements = Array.from(body.querySelectorAll('.quick-send-item')).filter(element => element !== state.element);
        const insertionIndex = getVerticalInsertionIndex(otherElements.map(element => element.getBoundingClientRect()), pointerY);
        const currentParent = state.element.parentElement;
        const currentIndex = Array.from(currentParent?.querySelectorAll('.quick-send-item') || []).indexOf(state.element);
        if (currentParent !== body || insertionIndex !== currentIndex) {
            const movingElements = getQuickSendReorderElements(context).filter(element => element !== state.element);
            const previousRects = new Map(movingElements.map(element => [element.dataset.quickId, element.getBoundingClientRect()]));
            body.insertBefore(state.element, otherElements[insertionIndex] || null);
            animateQuickSendReflow(previousRects, movingElements);
        }
        state.targetGroupId = groupId;
        state.insertionIndex = insertionIndex;
        requestAnimationFrame(() => positionQuickSendIndicator(context, state));
        return;
    }
    const otherElements = getQuickSendReorderElements(context).filter(element => element !== state.element);
    const rects = otherElements.map(element => element.getBoundingClientRect());
    const insertionIndex = getVerticalInsertionIndex(rects, pointerY);
    const currentIndex = getQuickSendReorderElements(context).indexOf(state.element);

    if (insertionIndex !== currentIndex) {
        const previousRects = new Map(otherElements.map(element => [element.dataset.quickId, element.getBoundingClientRect()]));
        const beforeElement = otherElements[insertionIndex] || state.indicator || null;
        if (beforeElement) {
            context.container.insertBefore(state.element, beforeElement);
        } else {
            context.container.appendChild(state.element);
        }
        animateQuickSendReflow(previousRects, otherElements);
    }

    state.insertionIndex = insertionIndex;
    requestAnimationFrame(() => positionQuickSendIndicator(context, state));
}

function scrollQuickSendDuringDrag(context, pointerY) {
    const scroller = context?.compact ? context.container?.parentElement : context?.container;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const edgeSize = Math.min(42, rect.height / 4);
    if (pointerY < rect.top + edgeSize) {
        scroller.scrollTop -= Math.ceil((rect.top + edgeSize - pointerY) / 5);
    } else if (pointerY > rect.bottom - edgeSize) {
        scroller.scrollTop += Math.ceil((pointerY - (rect.bottom - edgeSize)) / 5);
    }
}

function updateQuickSendDragPosition(context, state, clientX, clientY) {
    if (!state.preview || !state.dragging) return;
    const maxLeft = Math.max(4, window.innerWidth - state.previewRect.width - 4);
    const maxTop = Math.max(4, window.innerHeight - state.previewRect.height - 4);
    const left = Math.max(4, Math.min(clientX - state.pointerOffsetX, maxLeft));
    const top = Math.max(4, Math.min(clientY - state.pointerOffsetY, maxTop));
    const tilt = Math.max(-4, Math.min(4, (clientX - state.startX) / 12));
    state.preview.style.left = `${left}px`;
    state.preview.style.top = `${top}px`;
    state.preview.style.setProperty('--quick-send-drag-tilt', `${tilt}deg`);
    scrollQuickSendDuringDrag(context, clientY);
    updateQuickSendDropTarget(context, state, clientY);
}

function startQuickSendDrag(context, state) {
    if (!context || !state || state !== context.dragState || state.dragging || !state.element?.isConnected) return;
    clearQuickSendHoldTimer(context);
    setQuickSendEditMode(context, true);

    const rect = state.element.getBoundingClientRect();
    state.dragging = true;
    state.originalOrder = getQuickSendReorderElements(context).map(element => element.dataset.quickId);
    state.originalItems = context.compact ? null : quickSendList.map(item => ({ ...item }));
    state.originalGroups = context.compact ? null : quickSendGroups.map(group => ({ ...group }));
    state.temporarilyExpandedGroupIds = new Set();
    state.pointerOffsetX = Math.max(0, Math.min(rect.width, state.lastX - rect.left));
    state.pointerOffsetY = Math.max(0, Math.min(rect.height, state.lastY - rect.top));
    state.previewRect = rect;
    state.element.classList.add('dragging', 'quick-send-drag-placeholder');

    const preview = state.element.cloneNode(true);
    preview.classList.remove('dragging', 'quick-send-drag-placeholder');
    preview.classList.add('quick-send-drag-preview');
    preview.setAttribute('aria-hidden', 'true');
    preview.removeAttribute('draggable');
    preview.removeAttribute('aria-grabbed');
    preview.querySelectorAll('button, [tabindex]').forEach(element => { element.tabIndex = -1; });
    preview.style.width = `${rect.width}px`;
    preview.style.height = `${rect.height}px`;
    preview.style.left = `${rect.left}px`;
    preview.style.top = `${rect.top}px`;
    document.body.appendChild(preview);
    state.preview = preview;

    const indicator = document.createElement('div');
    indicator.className = 'quick-send-drop-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    context.container.appendChild(indicator);
    state.indicator = indicator;

    try {
        state.element.setPointerCapture?.(state.pointerId);
    } catch {
        // Pointer capture is optional; document listeners keep the drag working.
    }
    context.suppressClickUntil = performance.now() + 600;
    navigator.vibrate?.(12);
    syncQuickSendEditMode(context);
    updateQuickSendDragPosition(context, state, state.lastX, state.lastY);
}

function finishQuickSendDrag(context, state) {
    if (!context || !state || state !== context.dragState || !state.dragging || state.finishing) return;
    state.finishing = true;
    clearQuickSendHoldTimer(context);
    context.suppressClickUntil = performance.now() + 600;

    const orderedElements = getQuickSendReorderElements(context);
    orderedElements.forEach((element, index) => { element.dataset.index = String(index); });
    applyQuickSendElementOrder(context, orderedElements.map(element => element.dataset.quickId));
    state.committed = true;
    if (!context.compact && state.temporarilyExpandedGroupIds.size) {
        state.temporarilyExpandedGroupIds.forEach(groupId => {
            const group = quickSendGroups.find(entry => entry.id === groupId);
            if (group) group.collapsed = true;
        });
        saveQuickSendList();
        cleanUpQuickSendDrag(context, state);
        renderQuickSendLists();
        return;
    }
    saveQuickSendList();
    state.indicator?.remove();
    state.indicator = null;

    const targetRect = state.element?.getBoundingClientRect();
    const previewRect = state.preview?.getBoundingClientRect();
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reduceMotion || !targetRect || !previewRect || targetRect.width === 0 || targetRect.height === 0
        || typeof state.preview.animate !== 'function') {
        cleanUpQuickSendDrag(context, state);
        renderQuickSendLists();
        return;
    }

    let cleanedUp = false;
    const finishVisuals = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        cleanUpQuickSendDrag(context, state);
        renderQuickSendLists();
    };
    const animation = state.preview.animate([
        {
            left: `${previewRect.left}px`,
            top: `${previewRect.top}px`,
            transform: getComputedStyle(state.preview).transform,
            opacity: 1
        },
        {
            left: `${targetRect.left}px`,
            top: `${targetRect.top}px`,
            transform: 'rotate(0deg) scale(1)',
            opacity: 0.45
        }
    ], {
        duration: 190,
        easing: 'cubic-bezier(.2,.85,.25,1)',
        fill: 'forwards'
    });
    animation.addEventListener('finish', finishVisuals, { once: true });
    animation.addEventListener('cancel', finishVisuals, { once: true });
    state.snapFallbackTimer = setTimeout(finishVisuals, 260);
}

function beginQuickSendPointer(context, event, element) {
    if (!context || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (context.dragState?.finishing) return;
    quickSendReorderContexts.forEach(otherContext => {
        if (otherContext !== context && otherContext.dragState) {
            cancelQuickSendDrag(otherContext, { restoreOrder: true });
        }
    });
    cancelQuickSendDrag(context, { restoreOrder: true });

    const state = {
        pointerId: event.pointerId,
        element,
        itemId: element.dataset.quickId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        dragging: false,
        finishing: false
    };
    context.dragState = state;

    if (!context.editMode) {
        context.holdTimer = setTimeout(() => {
            if (context.dragState !== state) return;
            startQuickSendDrag(context, state);
        }, QUICK_SEND_HOLD_MS);
    }
}

function getQuickSendPointerContext(event) {
    return quickSendReorderContexts.find(context => {
        const state = context.dragState;
        return state && !state.finishing && event.pointerId === state.pointerId;
    });
}

function handleQuickSendPointerMove(event) {
    const context = getQuickSendPointerContext(event);
    const state = context?.dragState;
    if (!context || !state) return;
    state.lastX = event.clientX;
    state.lastY = event.clientY;

    if (!state.dragging) {
        const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
        if (context.editMode && distance >= QUICK_SEND_MOVE_THRESHOLD) {
            startQuickSendDrag(context, state);
        } else if (!context.editMode && distance >= QUICK_SEND_MOVE_THRESHOLD) {
            clearQuickSendHoldTimer(context);
            context.dragState = null;
        }
    }

    if (state.dragging) {
        event.preventDefault();
        updateQuickSendDragPosition(context, state, event.clientX, event.clientY);
    }
}

function handleQuickSendPointerUp(event) {
    const context = getQuickSendPointerContext(event);
    const state = context?.dragState;
    if (!context || !state) return;
    clearQuickSendHoldTimer(context);
    if (state.dragging) {
        event.preventDefault();
        finishQuickSendDrag(context, state);
    } else {
        context.dragState = null;
    }
}

function handleQuickSendPointerCancel(event) {
    const context = getQuickSendPointerContext(event);
    if (context) cancelQuickSendDrag(context, { restoreOrder: true });
}

function createQuickSendId() {
    return `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createQuickSendGroupId() {
    return `quick-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeQuickSendGroup(group = {}) {
    return {
        id: typeof group.id === 'string' && group.id ? group.id : createQuickSendGroupId(),
        name: typeof group.name === 'string' && group.name.trim()
            ? group.name.trim().slice(0, 60)
            : trFallback('main.quickSendGroupDefault', 'New Group'),
        collapsed: group.collapsed === true
    };
}

function normalizeQuickSendItem(item = {}) {
    const trigger = item.autoTrigger && typeof item.autoTrigger === 'object' ? item.autoTrigger : {};
    return {
        id: typeof item.id === 'string' && item.id ? item.id : createQuickSendId(),
        groupId: typeof item.groupId === 'string' && quickSendGroups.some(group => group.id === item.groupId)
            ? item.groupId
            : null,
        label: typeof item.label === 'string' ? item.label : '',
        mode: item.mode === 'hex' ? 'hex' : 'text',
        appendCrLf: item.appendCrLf === true,
        content: typeof item.content === 'string' ? item.content : '',
        sidebarShortcut: {
            enabled: item.sidebarShortcut?.enabled === true,
            text: typeof item.sidebarShortcut?.text === 'string' ? item.sidebarShortcut.text : '',
            backgroundColor: /^#[0-9a-f]{6}$/i.test(item.sidebarShortcut?.backgroundColor || '')
                ? item.sidebarShortcut.backgroundColor
                : ''
        },
        autoTrigger: {
            enabled: trigger.enabled === true,
            text: typeof trigger.text === 'string' ? trigger.text : '',
            useRegex: trigger.useRegex === true,
            caseSensitive: trigger.caseSensitive === true,
            wholeWord: trigger.wholeWord === true
        }
    };
}

function applyQuickSendAutoTriggerConfig(enabled) {
    const nextEnabled = enabled !== false;
    if (quickSendAutoTriggerEnabled && !nextEnabled) resetQuickTriggerReceive();
    quickSendAutoTriggerEnabled = nextEnabled;
    quickSendAutoTriggerEnableInput.checked = nextEnabled;
}

function saveQuickSendAutoTriggerConfig() {
    if (isApplyingConfig) return;
    ipcRenderer.send('save-config', { quickSendAutoTriggerEnabled });
}

function buildQuickTriggerRegex(trigger = {}) {
    const text = typeof trigger.text === 'string' ? trigger.text : '';
    if (!text) return { ok: true, regex: null };
    let pattern = text;
    if (trigger.useRegex !== true) {
        pattern = escapeRegex(pattern);
    }
    if (trigger.wholeWord === true) {
        pattern = `\\b(?:${pattern})\\b`;
    }
    try {
        return { ok: true, regex: new RegExp(pattern, trigger.caseSensitive === true ? '' : 'i') };
    } catch (error) {
        return { ok: false, message: trFallback('main.quickTriggerRegexInvalid', 'Auto-trigger regex is invalid: {error}', { error: error.message }) };
    }
}

function getQuickEditorItem() {
    const selectedGroupId = quickSendGroupSelect.value;
    return normalizeQuickSendItem({
        id: editingQuickSendId || createQuickSendId(),
        groupId: selectedGroupId && selectedGroupId !== '__new__' ? selectedGroupId : null,
        label: quickSendLabelInput.value.trim(),
        mode: quickSendModeInputs.find(input => input.checked)?.value === 'hex' ? 'hex' : 'text',
        appendCrLf: quickSendAppendCrlfInput.checked,
        content: quickSendContentInput.value,
        sidebarShortcut: {
            enabled: quickSendSidebarEnableInput.checked,
            text: quickSendSidebarTextInput.value.trim(),
            backgroundColor: quickSendSidebarColorInput.value
        },
        autoTrigger: {
            enabled: quickSendTriggerEnableInput.checked,
            text: quickSendTriggerTextInput.value,
            useRegex: quickSendTriggerRegexInput.checked,
            caseSensitive: quickSendTriggerCaseInput.checked,
            wholeWord: quickSendTriggerWordInput.checked
        }
    });
}

function closeQuickSendDialog() {
    quickSendDialog.classList.add('hidden');
    editingQuickSendId = '';
    quickSendLabelInput.value = '';
    quickSendGroupSelect.value = '';
    quickSendNewGroupNameInput.value = '';
    quickSendNewGroupNameInput.classList.add('hidden');
    quickSendContentInput.value = '';
    quickSendModeInputs.forEach(input => { input.checked = input.value === 'text'; });
    quickSendAppendCrlfInput.checked = false;
    quickSendTriggerEnableInput.checked = false;
    quickSendTriggerTextInput.value = '';
    quickSendTriggerRegexInput.checked = false;
    quickSendTriggerCaseInput.checked = false;
    quickSendTriggerWordInput.checked = false;
    quickSendSidebarEnableInput.checked = false;
    quickSendSidebarTextInput.value = '';
    quickSendSidebarColorInput.value = '#333333';
    updateQuickSidebarEditorState();
    renderQuickSendLists();
}

function updateQuickSidebarEditorState() {
    const enabled = quickSendSidebarEnableInput.checked;
    quickSendSidebarTextInput.disabled = !enabled;
    quickSendSidebarColorInput.disabled = !enabled;
    quickSendSidebarControls.classList.toggle('controls-disabled', !enabled);
}

function openQuickSendDialog(itemId = '') {
    editingQuickSendId = itemId;
    const item = quickSendList.find(entry => entry.id === itemId) || null;
    renderQuickSendGroupOptions(item?.groupId || null);
    quickSendLabelInput.value = item?.label || '';
    quickSendContentInput.value = item?.content || '';
    quickSendModeInputs.forEach(input => { input.checked = input.value === (item?.mode || mainInputMode); });
    quickSendAppendCrlfInput.checked = item?.appendCrLf === true;
    quickSendTriggerEnableInput.checked = item?.autoTrigger?.enabled === true;
    quickSendTriggerTextInput.value = item?.autoTrigger?.text || '';
    quickSendTriggerRegexInput.checked = item?.autoTrigger?.useRegex === true;
    quickSendTriggerCaseInput.checked = item?.autoTrigger?.caseSensitive === true;
    quickSendTriggerWordInput.checked = item?.autoTrigger?.wholeWord === true;
    quickSendSidebarEnableInput.checked = item?.sidebarShortcut?.enabled === true;
    quickSendSidebarTextInput.value = item?.sidebarShortcut?.text || '';
    quickSendSidebarColorInput.value = item?.sidebarShortcut?.backgroundColor || '#333333';
    updateQuickSidebarEditorState();
    const editing = Boolean(item);
    quickSendDialogTitle.textContent = editing
        ? trFallback('main.editQuickSend', 'Edit Quick Send')
        : trFallback('main.addQuickSend', 'Add Quick Send');
    addQuickSendBtnLabel.textContent = editing
        ? trFallback('main.updateItem', 'Update Item')
        : tr('main.addToList');
    updateQuickSendValidation();
    renderQuickSendLists();
    quickSendDialog.classList.remove('hidden');
    requestAnimationFrame(() => (editing ? quickSendContentInput : quickSendLabelInput).focus());
}

function renderQuickSendGroupOptions(selectedGroupId = null) {
    quickSendGroupSelect.innerHTML = '';
    quickSendGroups.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        quickSendGroupSelect.appendChild(option);
    });
    const ungrouped = document.createElement('option');
    ungrouped.value = '';
    ungrouped.textContent = trFallback('main.quickSendUngrouped', 'Ungrouped');
    quickSendGroupSelect.appendChild(ungrouped);
    const createOption = document.createElement('option');
    createOption.value = '__new__';
    createOption.textContent = trFallback('main.quickSendCreateGroup', '+ New Group');
    quickSendGroupSelect.appendChild(createOption);
    quickSendGroupSelect.value = selectedGroupId || '';
}

function createNamedQuickSendGroup(name) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return null;
    const group = normalizeQuickSendGroup({ id: createQuickSendGroupId(), name: trimmed, collapsed: false });
    quickSendGroups.push(group);
    return group;
}

function updateQuickSendValidation() {
    const item = getQuickEditorItem();
    const result = validateSendContent(item.mode, item.content, sendEncoding, SEND_LIMITS.quick - (item.appendCrLf ? 2 : 0));
    const triggerResult = !item.autoTrigger.enabled
        ? { ok: true, regex: null }
        : (!item.autoTrigger.text
            ? { ok: false, message: trFallback('main.quickTriggerTextRequired', 'Auto trigger needs match text') }
            : buildQuickTriggerRegex(item.autoTrigger));
    const groupResult = quickSendGroupSelect.value !== '__new__' || quickSendNewGroupNameInput.value.trim()
        ? { ok: true }
        : { ok: false, message: trFallback('main.quickSendGroupNameRequired', 'Enter a group name') };
    quickSendValidation.textContent = !groupResult.ok
        ? groupResult.message
        : triggerResult.ok
        ? formatValidation(result, item.mode, item.appendCrLf)
        : triggerResult.message;
    quickSendValidation.classList.toggle('valid', result.ok && triggerResult.ok && groupResult.ok);
    quickSendValidation.classList.toggle('invalid', (!result.ok && item.content.length > 0) || !triggerResult.ok || !groupResult.ok);
    addQuickSendBtn.disabled = !result.ok || !triggerResult.ok || !groupResult.ok;
    quickSendContentInput.placeholder = item.mode === 'hex' ? 'AA 55 01 FF' : tr('main.contentMultiLine');
    return { ...result, ok: result.ok && triggerResult.ok && groupResult.ok };
}

// groupId 是**触发字节所属的分组**，不是 activeGroupId：A 组收到的字节触发出来的指令
// 必须发回 A 组；用 activeGroupId 会在用户切到别的分组后把回复发错端口。
async function triggerQuickSendItem(item, groupId) {
    const targetGroupId = resolveSerialGroupId(groupId || activeGroupId);
    const triggerKey = JSON.stringify([targetGroupId, item.id]);
    if (quickSendTriggerInFlight.has(triggerKey)) return;
    quickSendTriggerInFlight.add(triggerKey);
    try {
        flashQuickSendItem(item.id);
        const result = await sendSerialRequest({ groupId: targetGroupId, mode: item.mode, content: item.content, appendCrLf: item.appendCrLf, source: 'quick-send-trigger' }, SEND_LIMITS.quick, { silent: true });
        const label = item.label || item.content;
        setActionStatus(result.ok
            ? trFallback('main.quickTriggerSent', 'Auto-trigger sent: {label}', { label })
            : trFallback('main.quickTriggerFailed', 'Auto-trigger failed: {error}', { error: result.message || result.code }));
    } finally {
        quickSendTriggerInFlight.delete(triggerKey);
    }
}

function showQuickSendClickResult(button, ok) {
    if (!button) return;
    const className = ok ? 'quick-send-click-success' : 'quick-send-click-failed';
    const previousTimer = quickSendClickTimers.get(button);
    if (previousTimer) clearTimeout(previousTimer);
    button.classList.remove('quick-send-click-success', 'quick-send-click-failed');
    void button.offsetWidth;
    button.classList.add(className);
    const timer = setTimeout(() => {
        button.classList.remove(className);
        quickSendClickTimers.delete(button);
    }, 320);
    quickSendClickTimers.set(button, timer);
}

function hideQuickSendDisconnectedToast(animate = true) {
    if (quickSendDisconnectedToastTimer) clearTimeout(quickSendDisconnectedToastTimer);
    quickSendDisconnectedToastTimer = null;
    const toast = quickSendDisconnectedToast;
    if (!toast) return;
    if (quickSendDisconnectedToastRemoveTimer) clearTimeout(quickSendDisconnectedToastRemoveTimer);
    quickSendDisconnectedToastRemoveTimer = null;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (!animate || reduceMotion) {
        toast.remove();
        quickSendDisconnectedToast = null;
        return;
    }
    toast.classList.add('quick-send-toast-hiding');
    quickSendDisconnectedToastRemoveTimer = setTimeout(() => {
        toast.remove();
        if (quickSendDisconnectedToast === toast) quickSendDisconnectedToast = null;
        quickSendDisconnectedToastRemoveTimer = null;
    }, 180);
}

function showQuickSendDisconnectedToast(button) {
    if (!button?.isConnected) return;
    hideQuickSendDisconnectedToast(false);

    const toast = document.createElement('div');
    toast.className = 'quick-send-disconnected-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = trFallback('main.quickSendDisconnectedToast', 'Hold on, did you forget to open the serial port?');
    document.body.appendChild(toast);

    const buttonRect = button.getBoundingClientRect();
    const toastRect = toast.getBoundingClientRect();
    const gap = 8;
    const edge = 8;
    const fitsRight = buttonRect.right + gap + toastRect.width <= window.innerWidth - edge;
    const left = fitsRight
        ? buttonRect.right + gap
        : buttonRect.left - gap - toastRect.width;
    toast.style.left = `${Math.max(edge, Math.min(left, window.innerWidth - toastRect.width - edge))}px`;
    toast.style.top = `${Math.max(edge, Math.min(
        buttonRect.top + (buttonRect.height - toastRect.height) / 2,
        window.innerHeight - toastRect.height - edge
    ))}px`;
    quickSendDisconnectedToast = toast;
    quickSendDisconnectedToastTimer = setTimeout(hideQuickSendDisconnectedToast, 3000);
}

function recordQuickSendDisconnectedClick(button) {
    const now = performance.now();
    const previous = quickSendDisconnectedClicks.get(button);
    const count = previous && now - previous.lastClick <= 2000 ? previous.count + 1 : 1;
    quickSendDisconnectedClicks.set(button, { count, lastClick: now });
    if (count >= 3) showQuickSendDisconnectedToast(button);
}

function flashQuickSendItem(itemId, className = 'auto-trigger-flash', duration = 1300) {
    if (!itemId) return;
    document.querySelectorAll(`.quick-send-item[data-quick-id="${CSS.escape(itemId)}"] .quick-send-main-btn`).forEach(button => {
        button.classList.remove('auto-trigger-flash', 'quick-send-click-success', 'quick-send-click-failed');
        void button.offsetWidth;
        button.classList.add(className);
        const previousTimer = quickSendFlashTimers.get(button);
        if (previousTimer) clearTimeout(previousTimer);
        const timer = setTimeout(() => {
            button.classList.remove(className);
            quickSendFlashTimers.delete(button);
        }, duration);
        quickSendFlashTimers.set(button, timer);
    });
}

function processQuickSendAutoTriggers(bytes, groupId = REGISTRY_DEFAULT_GROUP_ID) {
    if (!quickSendAutoTriggerEnabled) return;
    const triggerItems = quickSendList.filter(item => item.autoTrigger?.enabled === true && item.autoTrigger.text);
    if (!triggerItems.length) return;
    // 解码器与缓冲区按分组取：见 quickTriggerDecoders 声明处的注释。
    const id = resolveSerialGroupId(groupId);
    if (!quickTriggerDecoders.has(id)) createQuickTriggerDecoder(id);
    const decoder = quickTriggerDecoders.get(id);
    if (!decoder) return;
    const text = decoder.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (!text) return;
    const buffer = ((quickTriggerBuffers.get(id) || '') + text).slice(-4096);
    const matchedItems = [];
    triggerItems.forEach(item => {
        const triggerResult = buildQuickTriggerRegex(item.autoTrigger);
        if (triggerResult.ok && triggerResult.regex?.test(buffer)) {
            matchedItems.push(item);
        }
    });
    if (!matchedItems.length) {
        quickTriggerBuffers.set(id, buffer);
        return;
    }
    quickTriggerBuffers.set(id, '');
    matchedItems.forEach(item => triggerQuickSendItem(item, id));
}

function normalizeSidebarQuickSendOrder() {
    const groupOrder = new Map(quickSendGroups.map((group, index) => [group.id, index]));
    const itemOrder = new Map(quickSendList.map((item, index) => [item.id, index]));
    const enabledIds = quickSendList
        .filter(item => item.sidebarShortcut?.enabled === true)
        .sort((a, b) => {
            const aGroup = groupOrder.get(a.groupId) ?? quickSendGroups.length;
            const bGroup = groupOrder.get(b.groupId) ?? quickSendGroups.length;
            return aGroup - bGroup || itemOrder.get(a.id) - itemOrder.get(b.id);
        })
        .map(item => item.id);
    const enabledIdSet = new Set(enabledIds);
    const orderedIds = [...new Set(sidebarQuickSendOrder.filter(id => enabledIdSet.has(id)))];
    sidebarQuickSendOrder = [...orderedIds, ...enabledIds.filter(id => !orderedIds.includes(id))];
}

function animateQuickSendRemoval(element, onComplete) {
    let completed = false;
    const complete = () => {
        if (completed) return;
        completed = true;
        onComplete();
    };

    if (!element?.isConnected) {
        complete();
        return;
    }
    if (element.classList.contains('quick-send-removing')) return;
    element.classList.add('quick-send-removing');

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reduceMotion || typeof element.animate !== 'function') {
        complete();
        return;
    }

    const animation = element.animate([
        { opacity: 1 },
        { opacity: 0 }
    ], {
        duration: 220,
        easing: 'ease-out',
        fill: 'forwards'
    });
    animation.addEventListener('finish', complete, { once: true });
    animation.addEventListener('cancel', complete, { once: true });
}

function removeSidebarQuickSendShortcut(item, element) {
    if (!item?.id) return;
    animateQuickSendRemoval(element, () => {
        const result = disableSidebarQuickSend(quickSendList, sidebarQuickSendOrder, item.id);
        if (!result.changed) return;
        quickSendList = result.quickSendList;
        sidebarQuickSendOrder = result.sidebarQuickSendOrder;
        saveQuickSendList();
        renderQuickSendLists();
        setActionStatus(trFallback('main.quickSendSidebarRemoved', 'Removed sidebar shortcut: {label}', { label: item.label || item.content }));
    });
}

function deleteQuickSendItem(item, element) {
    if (!item?.id) return;
    animateQuickSendRemoval(element, () => {
        const result = deleteQuickSendById(quickSendList, sidebarQuickSendOrder, item.id);
        if (!result.changed) return;
        if (editingQuickSendId === item.id) closeQuickSendDialog();
        quickSendList = result.quickSendList;
        sidebarQuickSendOrder = result.sidebarQuickSendOrder;
        saveQuickSendList();
        renderQuickSendLists();
        setActionStatus(trFallback('main.quickSendDeleted', 'Deleted quick command: {label}', { label: item.label || item.content }));
    });
}

function setQuickSendGroupCollapsed(groupId, collapsed) {
    const section = Array.from(quickSendListEl.querySelectorAll('.quick-send-group'))
        .find(element => (element.dataset.quickGroupId || '') === (groupId || ''));
    const body = section?.querySelector('.quick-send-group-items');
    const toggle = section?.querySelector('.quick-send-group-toggle');
    if (groupId) {
        const group = quickSendGroups.find(entry => entry.id === groupId);
        if (!group || group.collapsed === collapsed) return;
        group.collapsed = collapsed;
        saveQuickSendList();
    } else {
        if (quickSendUngroupedCollapsed === collapsed) return;
        quickSendUngroupedCollapsed = collapsed;
        saveQuickSendList();
    }
    if (!section || !body) return renderQuickSendContainer(quickSendListEl);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    toggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (reduceMotion || typeof body.animate !== 'function') {
        section.classList.toggle('collapsed', collapsed);
        return;
    }
    if (!collapsed) section.classList.remove('collapsed');
    const height = body.scrollHeight;
    quickSendCollapseAnimations.get(body)?.cancel();
    const animation = body.animate([
        { height: collapsed ? `${height}px` : '0px', opacity: collapsed ? 1 : 0 },
        { height: collapsed ? '0px' : `${height}px`, opacity: collapsed ? 0 : 1 }
    ], {
        duration: collapsed ? 140 : 160,
        easing: collapsed ? 'ease-in' : 'ease-out'
    });
    quickSendCollapseAnimations.set(body, animation);
    animation.addEventListener('finish', () => {
        section.classList.toggle('collapsed', collapsed);
        quickSendCollapseAnimations.delete(body);
    }, { once: true });
}

function closeQuickSendGroupDialog() {
    quickSendGroupDialog.classList.add('hidden');
    editingQuickSendGroupId = '';
    quickSendGroupNameInput.value = '';
    const trigger = quickSendGroupDialogTrigger;
    quickSendGroupDialogTrigger = null;
    if (trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
}

function openQuickSendGroupDialog(groupId = '', trigger = document.activeElement) {
    const group = quickSendGroups.find(entry => entry.id === groupId) || null;
    editingQuickSendGroupId = group?.id || '';
    quickSendGroupDialogTrigger = trigger;
    quickSendGroupDialogTitle.textContent = group
        ? trFallback('main.renameQuickSendGroup', 'Rename group')
        : trFallback('main.addQuickSendGroup', 'Add group');
    quickSendGroupDialogSaveLabel.textContent = group
        ? trFallback('main.saveGroupChanges', 'Save Changes')
        : trFallback('main.createQuickSendGroup', 'Create Group');
    quickSendGroupDialogSaveBtn.querySelector('svg[data-material-icon]')?.replaceWith(createMaterialIcon(group ? 'edit' : 'add'));
    quickSendGroupNameInput.value = group?.name || '';
    quickSendGroupDialogSaveBtn.disabled = !quickSendGroupNameInput.value.trim();
    quickSendGroupDialog.classList.remove('hidden');
    requestAnimationFrame(() => quickSendGroupNameInput.focus());
}

function saveQuickSendGroupDialog() {
    const name = quickSendGroupNameInput.value.trim().slice(0, 60);
    if (!name) return;
    const group = quickSendGroups.find(entry => entry.id === editingQuickSendGroupId);
    if (group) group.name = name;
    else createNamedQuickSendGroup(name);
    closeQuickSendGroupDialog();
    saveQuickSendList();
    renderQuickSendLists();
}

function closeQuickSendGroupDeleteDialog({ restoreFocus = true } = {}) {
    deletingQuickSendGroupId = '';
    quickSendGroupDeleteDialog.classList.add('hidden');
    const trigger = quickSendGroupDeleteTrigger;
    quickSendGroupDeleteTrigger = null;
    if (restoreFocus && trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
}

function openQuickSendGroupDeleteDialog(groupId, trigger = document.activeElement) {
    const group = quickSendGroups.find(entry => entry.id === groupId);
    if (!group) return;
    deletingQuickSendGroupId = groupId;
    quickSendGroupDeleteTrigger = trigger;
    const count = quickSendList.filter(item => item.groupId === groupId).length;
    quickSendGroupDeleteMessage.textContent = trFallback(
        'main.quickSendDeleteGroupMessage',
        'Delete "{name}" and its {count} commands? This cannot be undone.',
        { name: group.name, count }
    );
    quickSendGroupDeleteDialog.classList.remove('hidden');
    requestAnimationFrame(() => quickSendGroupDeleteCancelBtn.focus());
}

function createQuickSendGroupSection(group, itemElements) {
    const groupId = group?.id || '';
    const collapsed = group ? group.collapsed : quickSendUngroupedCollapsed;
    const section = document.createElement('section');
    section.className = `quick-send-group${collapsed ? ' collapsed' : ''}${group ? '' : ' ungrouped'}`;
    section.dataset.quickGroupId = groupId;
    const header = document.createElement('div');
    header.className = 'quick-send-group-header';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'quick-send-group-toggle';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.appendChild(createMaterialIcon('arrow_drop_down'));
    const name = document.createElement('span');
    name.className = 'quick-send-group-name';
    name.textContent = group?.name || trFallback('main.quickSendUngrouped', 'Ungrouped');
    const count = document.createElement('span');
    count.className = 'quick-send-group-count';
    count.textContent = String(itemElements.length);
    toggle.append(name, count);
    toggle.addEventListener('click', event => {
        event.stopPropagation();
        const currentCollapsed = group
            ? group.collapsed
            : section.classList.contains('collapsed');
        setQuickSendGroupCollapsed(groupId, !currentCollapsed);
    });
    header.appendChild(toggle);
    if (group) {
        const dragHandle = document.createElement('span');
        dragHandle.className = 'quick-send-group-handle';
        dragHandle.draggable = true;
        dragHandle.title = trFallback('main.dragToReorder', 'Drag to reorder');
        dragHandle.appendChild(createMaterialIcon('drag_indicator'));
        dragHandle.addEventListener('dragstart', event => {
            quickSendGroupDragState = { groupId: group.id, insertionIndex: quickSendGroups.indexOf(group) };
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', group.id);
            requestAnimationFrame(() => section.classList.add('group-dragging'));
        });
        dragHandle.addEventListener('dragend', () => {
            quickSendGroupDragState = null;
            quickSendListEl.classList.remove('quick-send-group-drag-active');
            quickSendListEl.querySelectorAll('.quick-send-group-drop-before, .quick-send-group-drop-after')
                .forEach(element => element.classList.remove('quick-send-group-drop-before', 'quick-send-group-drop-after'));
            section.classList.remove('group-dragging');
        });
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'quick-send-group-action';
        edit.title = trFallback('main.renameQuickSendGroup', 'Rename group');
        edit.appendChild(createMaterialIcon('edit'));
        edit.addEventListener('click', event => openQuickSendGroupDialog(group.id, event.currentTarget));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'quick-send-group-action delete';
        remove.title = trFallback('main.deleteQuickSendGroup', 'Delete group');
        remove.appendChild(createMaterialIcon('delete'));
        remove.addEventListener('click', event => openQuickSendGroupDeleteDialog(group.id, event.currentTarget));
        header.append(dragHandle, edit, remove);
    }
    const body = document.createElement('div');
    body.className = 'quick-send-group-items';
    itemElements.forEach(element => body.appendChild(element));
    section.append(header, body);
    return section;
}

function updateQuickSendGroupDropTarget(pointerY) {
    if (!quickSendGroupDragState) return;
    const sections = Array.from(quickSendListEl.querySelectorAll('.quick-send-group:not(.ungrouped)'))
        .filter(section => section.dataset.quickGroupId !== quickSendGroupDragState.groupId);
    const insertionIndex = getVerticalInsertionIndex(
        sections.map(section => section.getBoundingClientRect()),
        pointerY
    );
    quickSendGroupDragState.insertionIndex = insertionIndex;
    quickSendListEl.classList.add('quick-send-group-drag-active');
    quickSendListEl.querySelectorAll('.quick-send-group-drop-before, .quick-send-group-drop-after')
        .forEach(element => element.classList.remove('quick-send-group-drop-before', 'quick-send-group-drop-after'));
    if (sections[insertionIndex]) sections[insertionIndex].classList.add('quick-send-group-drop-before');
    else sections.at(-1)?.classList.add('quick-send-group-drop-after');
}

quickSendListEl.addEventListener('dragover', event => {
    if (!quickSendGroupDragState) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    updateQuickSendGroupDropTarget(event.clientY);
});

quickSendListEl.addEventListener('drop', event => {
    if (!quickSendGroupDragState) return;
    event.preventDefault();
    const { groupId, insertionIndex } = quickSendGroupDragState;
    quickSendGroupDragState = null;
    quickSendGroups = moveQuickSendGroup(quickSendGroups, groupId, insertionIndex);
    saveQuickSendList();
    renderQuickSendLists();
});

function renderQuickSendContainer(container, compact = false) {
    if (!container) return;
    const context = getQuickSendReorderContext(compact);
    if (context?.dragState) cancelQuickSendDrag(context, { restoreOrder: false });
    const previousRects = new Map(getQuickSendReorderElements(context)
        .map(element => [element.dataset.quickId, element.getBoundingClientRect()]));
    container.innerHTML = '';
    const items = compact
        ? sidebarQuickSendOrder.map(id => quickSendList.find(item => item.id === id)).filter(Boolean)
        : quickSendList;
    items.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = `quick-send-item${compact ? ' quick-send-item-compact' : ''}`;
        div.setAttribute('role', 'listitem');
        div.setAttribute('aria-grabbed', 'false');
        div.dataset.index = String(index);
        div.dataset.quickId = item.id;
        div.addEventListener('pointerdown', event => beginQuickSendPointer(context, event, div));
        
        // If this item is being edited, highlight it
        if (item.id === editingQuickSendId) {
            div.classList.add('editing');
        }

        const btn = document.createElement('button');
        const label = document.createElement('span');
        label.className = 'quick-send-label';
        label.textContent = compact ? (item.sidebarShortcut?.text || item.label || item.content) : (item.label || item.content);
        const validation = validateSendContent(item.mode, item.content, sendEncoding, SEND_LIMITS.quick - (item.appendCrLf ? 2 : 0));
        btn.title = validation.ok ? `${validation.normalized} (${validation.byteCount + (item.appendCrLf ? 2 : 0)} B)` : validation.message;
        btn.className = compact ? 'quick-send-main-btn sidebar-tool-btn' : 'quick-send-main-btn';
            if (compact) {
            btn.style.backgroundColor = item.sidebarShortcut?.backgroundColor || 'var(--bg-tertiary)';
            btn.style.color = 'var(--text-primary)';
                const textLength = [...label.textContent].length;
                btn.style.fontSize = `${Math.max(8, Math.min(13, 15 - textLength * 0.35))}px`;
                const previousItem = items[index - 1];
                if (previousItem && (previousItem.groupId || null) !== (item.groupId || null)) div.classList.add('quick-send-group-break');
            }
            const groupName = quickSendGroups.find(group => group.id === item.groupId)?.name
                || trFallback('main.quickSendUngrouped', 'Ungrouped');
            btn.title = compact ? `${groupName} / ${item.label || item.content}` : (item.label || item.content);
        btn.append(label);
        if (!compact && item.mode === 'hex') {
            btn.classList.add('has-mode-badge');
            const modeBadge = document.createElement('span');
            modeBadge.className = 'mode-badge hex quick-send-mode-badge';
            modeBadge.textContent = 'HEX';
            btn.append(modeBadge);
        }
        
        btn.addEventListener('click', async event => {
            if (performance.now() < context.suppressClickUntil) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            // 点的是左侧栏里的一条指令，发往**当前激活分组**的端口。
            const result = await sendSerialRequest({ groupId: activeGroupId, mode: item.mode, content: item.content, appendCrLf: item.appendCrLf, source: 'quick-send' }, SEND_LIMITS.quick);
            showQuickSendClickResult(btn, result?.ok === true);
            if (result?.code === 'SERIAL_NOT_OPEN') recordQuickSendDisconnectedClick(btn);
        });

        div.appendChild(btn);

        const editDeleteBtn = document.createElement('button');
        editDeleteBtn.type = 'button';
        editDeleteBtn.className = `quick-send-edit-delete-btn ${compact ? 'compact' : 'full'}`;
        editDeleteBtn.title = compact
            ? trFallback('main.removeQuickSendSidebar', 'Remove from sidebar')
            : trFallback('main.deleteQuickSend', 'Delete quick command');
        editDeleteBtn.tabIndex = -1;
        editDeleteBtn.setAttribute('aria-hidden', 'true');
        editDeleteBtn.setAttribute('aria-label', compact
            ? trFallback('main.removeQuickSendSidebarLabel', 'Remove sidebar shortcut: {label}', { label: item.label || item.content })
            : trFallback('main.deleteQuickSendLabel', 'Delete quick command: {label}', { label: item.label || item.content }));
        editDeleteBtn.appendChild(createMaterialIcon('close'));
        editDeleteBtn.addEventListener('pointerdown', event => event.stopPropagation());
        editDeleteBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (compact) removeSidebarQuickSendShortcut(item, div);
            else deleteQuickSendItem(item, div);
        });
        div.appendChild(editDeleteBtn);

        if (!compact) {
            // Actions are overlaid on the left and revealed on hover/focus.
            const actionDiv = document.createElement('div');
            actionDiv.className = 'quick-send-actions';
            actionDiv.addEventListener('pointerdown', event => event.stopPropagation());
            actionDiv.addEventListener('focusin', () => {
                div.classList.add('actions-focused');
            });
            actionDiv.addEventListener('focusout', event => {
                if (!actionDiv.contains(event.relatedTarget)) div.classList.remove('actions-focused');
            });

            const editBtn = document.createElement('button');
            editBtn.className = 'quick-send-action-btn';
        editBtn.title = trFallback('main.edit', 'Edit');
            editBtn.appendChild(createMaterialIcon('edit'));
            editBtn.addEventListener('click', event => {
                event.stopPropagation();
                openQuickSendDialog(item.id);
                setActionStatus(trFallback('main.editingQuickSend', 'Editing quick command: {label}', { label: item.label || item.content }));
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'quick-send-action-btn delete';
        delBtn.title = trFallback('main.delete', 'Delete');
            delBtn.appendChild(createMaterialIcon('delete'));
            delBtn.addEventListener('click', event => {
                event.stopPropagation();
                deleteQuickSendItem(item, div);
            });

            actionDiv.appendChild(delBtn);
            actionDiv.appendChild(editBtn);
            div.appendChild(actionDiv);
        }
        
        if (!compact || item.sidebarShortcut?.enabled === true) container.appendChild(div);
    });
    if (!compact) {
        const itemElements = Array.from(container.querySelectorAll('.quick-send-item'));
        const elementsByGroup = groupId => itemElements.filter(element => {
            const item = quickSendList.find(entry => entry.id === element.dataset.quickId);
            return (item?.groupId || '') === groupId;
        });
        container.innerHTML = '';
        quickSendGroups.forEach(group => container.appendChild(createQuickSendGroupSection(group, elementsByGroup(group.id))));
        container.appendChild(createQuickSendGroupSection(null, elementsByGroup('')));
    }
    requestAnimationFrame(() => {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return;
        const elements = compact ? Array.from(container.children) : Array.from(container.querySelectorAll('.quick-send-item'));
        elements.forEach(element => {
            const previous = previousRects.get(element.dataset.quickId);
            if (!previous) return;
            const current = element.getBoundingClientRect();
            const offset = previous.top - current.top;
            if (Math.abs(offset) < 1) return;
            element.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], {
                duration: compact ? 220 : 280,
                easing: 'cubic-bezier(.2,.8,.2,1)'
            });
        });
    });
    syncQuickSendEditMode(context);
}

function renderQuickSendLists() {
    normalizeSidebarQuickSendOrder();
    renderQuickSendContainer(quickSendListEl);
    renderQuickSendContainer(sidebarQuickSendListEl, true);
}

function saveQuickSendList() {
    if (isApplyingConfig) return;
    normalizeSidebarQuickSendOrder();
    ipcRenderer.send('save-config', {
        quickSendGroups: quickSendGroups.map(normalizeQuickSendGroup),
        quickSendUngroupedCollapsed,
        quickSendList: quickSendList.map(normalizeQuickSendItem),
        sidebarQuickSendOrder
    });
}

document.addEventListener('pointermove', handleQuickSendPointerMove, { passive: false });
document.addEventListener('pointerup', handleQuickSendPointerUp);
document.addEventListener('pointercancel', handleQuickSendPointerCancel);
document.addEventListener('pointerdown', event => {
    quickSendReorderContexts.forEach(context => {
        if (context.editMode && !context.container?.contains(event.target)) setQuickSendEditMode(context, false);
    });
}, true);
quickSendReorderContexts.forEach(context => {
    context.container?.addEventListener('contextmenu', event => {
        if (context.editMode || context.dragState) event.preventDefault();
    });
});
window.addEventListener('blur', () => {
    quickSendReorderContexts.forEach(context => {
        if (context.dragState) cancelQuickSendDrag(context, { restoreOrder: true });
    });
});

addQuickSendBtn.addEventListener('click', () => {
    if (updateQuickSendValidation().ok) {
        if (quickSendGroupSelect.value === '__new__') {
            const group = createNamedQuickSendGroup(quickSendNewGroupNameInput.value);
            if (!group) {
                quickSendNewGroupNameInput.focus();
                return;
            }
            renderQuickSendGroupOptions(group.id);
        }
        const item = getQuickEditorItem();
        const editingIndex = quickSendList.findIndex(entry => entry.id === editingQuickSendId);
        if (editingIndex > -1) {
            const previousGroupId = quickSendList[editingIndex].groupId || null;
            quickSendList[editingIndex] = item;
            if (previousGroupId !== item.groupId) {
                const targetCount = quickSendList.filter(entry => entry.id !== item.id && entry.groupId === item.groupId).length;
                quickSendList = moveQuickSendItem(quickSendList, item.id, item.groupId, targetCount);
            }
        } else {
            quickSendList.push(item);
        }
        saveQuickSendList();
        closeQuickSendDialog();
    }
});
quickSendContentInput.addEventListener('input', updateQuickSendValidation);
quickSendGroupSelect.addEventListener('change', () => {
    const creating = quickSendGroupSelect.value === '__new__';
    quickSendNewGroupNameInput.classList.toggle('hidden', !creating);
    if (creating) requestAnimationFrame(() => quickSendNewGroupNameInput.focus());
    updateQuickSendValidation();
});
quickSendNewGroupNameInput.addEventListener('input', updateQuickSendValidation);
quickSendModeInputs.forEach(input => input.addEventListener('change', updateQuickSendValidation));
quickSendAppendCrlfInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerEnableInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerTextInput.addEventListener('input', updateQuickSendValidation);
quickSendTriggerRegexInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerCaseInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerWordInput.addEventListener('change', updateQuickSendValidation);
quickSendSidebarEnableInput.addEventListener('change', () => {
    updateQuickSidebarEditorState();
    updateQuickSendValidation();
});
quickSendSidebarTextInput.addEventListener('input', updateQuickSendValidation);
quickSendSidebarColorInput.addEventListener('input', updateQuickSendValidation);
openQuickSendDialogBtn.addEventListener('click', () => openQuickSendDialog());
quickSendAutoTriggerEnableInput.addEventListener('change', () => {
    applyQuickSendAutoTriggerConfig(quickSendAutoTriggerEnableInput.checked);
    saveQuickSendAutoTriggerConfig();
});
addQuickSendGroupBtn.addEventListener('click', () => {
    openQuickSendGroupDialog('', addQuickSendGroupBtn);
});
quickSendGroupNameInput.addEventListener('input', () => {
    quickSendGroupDialogSaveBtn.disabled = !quickSendGroupNameInput.value.trim();
});
quickSendGroupNameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !quickSendGroupDialogSaveBtn.disabled) saveQuickSendGroupDialog();
});
quickSendGroupDialogSaveBtn.addEventListener('click', saveQuickSendGroupDialog);
quickSendGroupDialogCloseBtn.addEventListener('click', closeQuickSendGroupDialog);
quickSendGroupDialogCancelBtn.addEventListener('click', closeQuickSendGroupDialog);
quickSendGroupDeleteCancelBtn.addEventListener('click', closeQuickSendGroupDeleteDialog);
quickSendGroupDeleteConfirmBtn.addEventListener('click', () => {
    const group = quickSendGroups.find(entry => entry.id === deletingQuickSendGroupId);
    if (!group) return closeQuickSendGroupDeleteDialog();
    const result = deleteQuickSendGroup(quickSendGroups, quickSendList, sidebarQuickSendOrder, group.id);
    quickSendGroups = result.quickSendGroups;
    quickSendList = result.quickSendList;
    sidebarQuickSendOrder = result.sidebarQuickSendOrder;
    closeQuickSendGroupDeleteDialog({ restoreFocus: false });
    saveQuickSendList();
    renderQuickSendLists();
    setActionStatus(trFallback('main.quickSendGroupDeleted', 'Deleted group: {name}', { name: group.name }));
    requestAnimationFrame(() => quickSendListEl.querySelector('.quick-send-group-toggle')?.focus());
});
quickSendDialogCloseBtn.addEventListener('click', closeQuickSendDialog);
quickSendDialogCancelBtn.addEventListener('click', closeQuickSendDialog);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !quickSendGroupDialog.classList.contains('hidden')) {
        closeQuickSendGroupDialog();
    } else if (event.key === 'Escape' && !quickSendGroupDeleteDialog.classList.contains('hidden')) {
        closeQuickSendGroupDeleteDialog();
    } else if (event.key === 'Escape' && !quickSendDialog.classList.contains('hidden')) {
        closeQuickSendDialog();
    } else if (event.key === 'Escape' && quickSendReorderContexts.some(context => context.editMode)) {
        quickSendReorderContexts.forEach(context => setQuickSendEditMode(context, false));
    }
});
