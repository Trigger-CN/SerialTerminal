'use strict';

// 显示类偏好的**作用域**：时间戳前缀、行号前缀、发送回显、双格式回显、过滤页回显。
//
// 这五项默认是全局共享的一份：切换串口分组时侧栏看到的是同一个值。
// 用户可以把作用域改成「每组独立」，此时每个串口分组各存一份。
//
// 为什么把作用域判断抽成纯函数：
//   1. 读取侧在**每条数据**的路径上（getPrefix / renderSentRecord），不能有 DOM 依赖；
//   2. 侧栏回显侧需要「这一组应该显示成什么」的唯一答案；
//   3. 两条路径必须对同一份规则给出同一个答案，否则会出现「存到了组里、读还在读全局」
//      这类只在特定操作顺序下才暴露的错位。

const DISPLAY_PREF_SCOPES = Object.freeze({
    GLOBAL: 'global',
    PER_GROUP: 'per-group'
});

const DISPLAY_PREF_DEFAULTS = Object.freeze({
    showTimestamp: false,
    showLineNumbers: false,
    echoSentData: true,
    echoSentDataBothFormats: false,
    echoSentDataInFilterTabs: true
});

const DISPLAY_PREF_FIELDS = Object.freeze(Object.keys(DISPLAY_PREF_DEFAULTS));

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 未知值一律回落到 global：作用域是二选一，写坏的配置不应该让所有分组失去显示偏好。
function normalizeDisplayPrefScope(value) {
    return value === DISPLAY_PREF_SCOPES.PER_GROUP
        ? DISPLAY_PREF_SCOPES.PER_GROUP
        : DISPLAY_PREF_SCOPES.GLOBAL;
}

// 只认识字段清单里的键，且只接受布尔值。
// 缺失或类型不对时回落到默认值而不是保留 undefined：
// 这些值会被直接喂进 `if (...)`，undefined 与 false 行为相同，
// 但「用户是否曾显式设置过」这个语义会因此彻底丢失。
function normalizeDisplayPrefs(source) {
    const input = isPlainObject(source) ? source : {};
    const result = {};
    for (const field of DISPLAY_PREF_FIELDS) {
        result[field] = typeof input[field] === 'boolean'
            ? input[field]
            : DISPLAY_PREF_DEFAULTS[field];
    }
    return result;
}

// 某一组**自己**的显示偏好（不判断作用域）。
//
// 组内没有存过时继承全局值：全新分组、以及刚把作用域切成「每组独立」的那一刻，
// 用户看到的第一屏应当与他切换之前完全一致，而不是突然全部回到出厂默认。
function readGroupDisplayPrefs(group, globalPrefs) {
    const fallback = normalizeDisplayPrefs(globalPrefs);
    const stored = isPlainObject(group) ? group.uiPrefs : null;
    if (!isPlainObject(stored)) return fallback;
    return normalizeDisplayPrefs({ ...fallback, ...stored });
}

// 读取侧唯一入口。global 作用域下所有分组共用一份，per-group 下各读各的。
function resolveDisplayPrefs({ scope, globalPrefs, group } = {}) {
    return normalizeDisplayPrefScope(scope) === DISPLAY_PREF_SCOPES.PER_GROUP
        ? readGroupDisplayPrefs(group, globalPrefs)
        : normalizeDisplayPrefs(globalPrefs);
}

// 侧栏回显需要判断「值是否真的变了」：
// 没变就不要重渲染，否则每切一次分组都会把终端主题与前缀重新套一遍。
function displayPrefsEqual(a, b) {
    const left = normalizeDisplayPrefs(a);
    const right = normalizeDisplayPrefs(b);
    return DISPLAY_PREF_FIELDS.every(field => left[field] === right[field]);
}

module.exports = {
    DISPLAY_PREF_SCOPES,
    DISPLAY_PREF_DEFAULTS,
    DISPLAY_PREF_FIELDS,
    normalizeDisplayPrefScope,
    normalizeDisplayPrefs,
    readGroupDisplayPrefs,
    resolveDisplayPrefs,
    displayPrefsEqual
};
