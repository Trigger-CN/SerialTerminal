'use strict';

// 分组标签栏的 DOM 节点描述（P3 DOM 层）。
//
// 与 serial-group-tabs.js 的分工：
//   serial-group-tabs.js  回答「哪个标签属于哪一层、哪一个是激活的」——纯归属判定；
//   本模块                回答「这些标签应该长成什么样的 DOM 节点」——纯结构描述。
//
// 为什么再拆一层：归属判定已经能被单测覆盖，但从「模型」到「真实节点」之间还有一段
// 只能靠肉眼发现错误的区域——比如把分组标签插进了下层的 tabs-list、把关闭按钮放在
// 标题前面、或者忘了给分组标签加 data-target 导致点击后找不到目标。把这些决定也
// 变成可断言的纯数据，DOM 层就只剩下 createElement / appendChild。
//
// 本模块不碰 DOM、不读全局状态，因此可以在 Node 里直接断言。

const { mainTabId, mainTabButtonId, serialContainerId } = require('./serial-group-dom');
const { attributeSelector } = require('./serial-group-workspace');

// 分组标签栏的固定容器 id。
// 不与现有的 `pane-1-tabs-list` 冲突：分组层是**独立的一行**，位于 pane 标签行之上。
const GROUP_TAB_BAR_ID = 'serial-group-tab-bar';
const GROUP_TAB_LIST_ID = 'serial-group-tab-list';
const ADD_GROUP_BUTTON_ID = 'add-serial-group-btn';

// 单个分组标签的 id。默认分组同样带后缀，因为它与 `tab-main` 是两件不同的东西：
// `tab-main` 是「该分组内的主终端标签」，而这里是「分组本身」的标签。
// 两者若算出同一个 id，点击分组标签会同时命中主终端标签，行为无法预期。
function groupTabId(groupId) {
    const raw = typeof groupId === 'string' ? groupId.trim() : '';
    const safe = (raw || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
    return `tab-group-${safe}`;
}

function groupTabButtonId(groupId) {
    return `${groupTabId(groupId)}-button`;
}

function groupCloseButtonId(groupId) {
    return `${groupTabId(groupId)}-close`;
}

// 描述一个分组标签。`isDefault` 只影响「能否关闭」与无障碍文案的默认值，
// 不影响 id 计算——id 必须只由 groupId 决定，否则同一个分组会拿到两个 id。
function describeGroupTab(group, options = {}) {
    const source = group && typeof group === 'object' ? group : {};
    const groupId = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : 'default';
    const title = typeof source.title === 'string' && source.title.trim() ? source.title.trim() : 'Serial';
    const isDefault = options.isDefault === true;

    return {
        groupId,
        title,
        active: source.active === true || options.active === true,
        connected: source.connected === true,
        // 默认分组不可关闭：关掉它之后没有任何路径能恢复，用户会看到空白终端区。
        // 但按钮仍然渲染（只是 disabled），因为「有的分组能关、有的不能」若用
        // 「有的没有关闭按钮」表达，标签宽度会跳变。
        closable: !isDefault,
        elementId: groupTabId(groupId),
        buttonId: groupTabButtonId(groupId),
        closeButtonId: groupCloseButtonId(groupId),
        buttonSelector: attributeSelector('id', groupTabButtonId(groupId)),
        // 点击分组标签时用它找到要激活的分组。放在 dataset 而不是闭包里，
        // 是为了让事件委托也能读到（标签会被重建，闭包会跟着丢）。
        dataset: { groupId },
        // 状态类名由渲染层据此 toggle，避免出现「active 与 connected 两个类名
        // 各自用一套不同拼法」的漂移。
        className: [
            'main-tab',
            'serial-group-tab',
            source.active === true || options.active === true ? 'active' : '',
            source.connected === true ? 'connected' : ''
        ].filter(Boolean).join(' ')
    };
}

// 描述整个分组标签栏。
//
// mode 与 serial-group-tabs.js 的判定必须一致：单分组时整条分组栏隐藏
// （`hidden: true`），只留一个 Shell 与串口标签混排的单层标签栏。
// 这里不再重复算「几个分组算多分组」，而是由调用方传 mode，避免两处阈值漂移。
function describeGroupTabBar(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const groups = Array.isArray(source.groups) ? source.groups.filter(item => item && typeof item === 'object') : [];
    const isMultiGroup = source.isMultiGroup === true && groups.length > 1;

    return {
        // 单分组时分组栏整体隐藏：只有一个分组还显示一个「分组标签」是纯噪声，
        // 而且会让用户以为可以点它切到别处。
        hidden: !isMultiGroup,
        barId: GROUP_TAB_BAR_ID,
        listId: GROUP_TAB_LIST_ID,
        addButtonId: ADD_GROUP_BUTTON_ID,
        addButtonSelector: attributeSelector('id', ADD_GROUP_BUTTON_ID),
        tabs: isMultiGroup
            ? groups.map(group => describeGroupTab(group, {
                isDefault: group.id === (source.defaultGroupId || 'default')
            }))
            : [],
        // 「添加串口」按钮在多分组时也保留：用户可能想继续加第三个。
        canAdd: true
    };
}

// 「添加串口」按钮的描述。单独抽出来是因为它有两个容易写错的地方：
//   1. 必须放在分组层右端，而不是下层的 pane-tab-actions 里（后者是「新建过滤页」）；
//   2. 单分组时也必须可见——否则用户永远开启不了多分组。
function describeAddGroupButton(options = {}) {
    const source = options && typeof options === 'object' ? options : {};
    return {
        id: ADD_GROUP_BUTTON_ID,
        icon: 'add',
        titleKey: 'main.addSerialPort',
        titleFallback: 'Add Serial Port',
        // 已达上限时禁用而不是隐藏：隐藏会让布局跳动，也让用户不知道为什么加不了。
        disabled: source.disabled === true,
        selector: attributeSelector('id', ADD_GROUP_BUTTON_ID)
    };
}

// 计算某个分组的主标签在标签栏里的可见性。
//
// 关键规则：**非激活分组的主终端标签必须隐藏**，而不是「保留在 DOM 里但尺寸为 0」。
// xterm 在 display:none 的容器里 fit() 会算出 0 尺寸，切回来时终端尺寸是错的，
// 表现为字符被压扁或右侧被裁掉。所以切分组时必须显式 hide 旧容器、show 新容器，
// 并在 show 之后重新 fit。
function describeGroupVisibility(groups, activeGroupId) {
    const list = Array.isArray(groups) ? groups.filter(item => item && typeof item === 'object') : [];
    const normalizedActive = typeof activeGroupId === 'string' ? activeGroupId.trim() : '';
    return list.map(group => {
        const id = typeof group.id === 'string' ? group.id.trim() : '';
        const visible = Boolean(id) && id === normalizedActive;
        return {
            groupId: id,
            visible,
            mainTabId: mainTabId(id),
            mainTabButtonId: mainTabButtonId(id),
            // 不可见时必须真正隐藏；只用 aria 或透明度都不行，理由见函数头注释。
            hidden: !visible,
            // 容器 id 必须走 serialContainerId，不能在这里手写一遍拼接：
            // 两份规则一旦漂移，切分组后 show 的就是一个不存在的容器。
            containerId: serialContainerId(id),
            containerSelector: attributeSelector('id', serialContainerId(id))
        };
    });
}

module.exports = {
    GROUP_TAB_BAR_ID,
    GROUP_TAB_LIST_ID,
    ADD_GROUP_BUTTON_ID,
    groupTabId,
    groupTabButtonId,
    groupCloseButtonId,
    describeGroupTab,
    describeGroupTabBar,
    describeAddGroupButton,
    describeGroupVisibility
};
