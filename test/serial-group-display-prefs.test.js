'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DISPLAY_PREF_SCOPES,
  DISPLAY_PREF_DEFAULTS,
  DISPLAY_PREF_FIELDS,
  normalizeDisplayPrefScope,
  normalizeDisplayPrefs,
  readGroupDisplayPrefs,
  resolveDisplayPrefs,
  displayPrefsEqual
} = require('../serial-group-display-prefs');

const GLOBAL_PREFS = {
  showTimestamp: true,
  showLineNumbers: false,
  echoSentData: true,
  echoSentDataBothFormats: true,
  echoSentDataInFilterTabs: false
};

test('scope values are the two documented strings', () => {
  assert.equal(DISPLAY_PREF_SCOPES.GLOBAL, 'global');
  assert.equal(DISPLAY_PREF_SCOPES.PER_GROUP, 'per-group');
});

test('unknown or missing scope falls back to global', () => {
  assert.equal(normalizeDisplayPrefScope('per-group'), 'per-group');
  assert.equal(normalizeDisplayPrefScope('global'), 'global');
  assert.equal(normalizeDisplayPrefScope(''), 'global');
  assert.equal(normalizeDisplayPrefScope(undefined), 'global');
  assert.equal(normalizeDisplayPrefScope('PER-GROUP'), 'global');
  assert.equal(normalizeDisplayPrefScope(null), 'global');
});

test('normalizeDisplayPrefs keeps the documented legacy defaults', () => {
  assert.deepEqual(normalizeDisplayPrefs({}), {
    showTimestamp: false,
    showLineNumbers: false,
    echoSentData: true,
    echoSentDataBothFormats: false,
    echoSentDataInFilterTabs: true
  });
  assert.deepEqual(normalizeDisplayPrefs(null), DISPLAY_PREF_DEFAULTS);
  assert.deepEqual(Object.keys(DISPLAY_PREF_DEFAULTS).sort(), [...DISPLAY_PREF_FIELDS].sort());
});

test('normalizeDisplayPrefs only accepts booleans and drops unknown fields', () => {
  const normalized = normalizeDisplayPrefs({
    showTimestamp: 'yes',
    showLineNumbers: true,
    echoSentData: 0,
    somethingElse: true
  });
  assert.equal(normalized.showTimestamp, false);
  assert.equal(normalized.showLineNumbers, true);
  assert.equal(normalized.echoSentData, true);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'somethingElse'), false);
});

test('global scope ignores per-group copies entirely', () => {
  const prefs = resolveDisplayPrefs({
    scope: 'global',
    globalPrefs: GLOBAL_PREFS,
    group: { uiPrefs: { showTimestamp: false, echoSentData: false } }
  });
  assert.deepEqual(prefs, normalizeDisplayPrefs(GLOBAL_PREFS));
});

test('per-group scope reads the group copy', () => {
  const prefs = resolveDisplayPrefs({
    scope: 'per-group',
    globalPrefs: GLOBAL_PREFS,
    group: { uiPrefs: { showTimestamp: false, echoSentData: false } }
  });
  // 组内只存了两个字段，其余继续继承全局值。
  assert.equal(prefs.showTimestamp, false);
  assert.equal(prefs.echoSentData, false);
  assert.equal(prefs.echoSentDataBothFormats, GLOBAL_PREFS.echoSentDataBothFormats);
  assert.equal(prefs.echoSentDataInFilterTabs, GLOBAL_PREFS.echoSentDataInFilterTabs);
});

test('a group without a stored copy inherits the global values in per-group scope', () => {
  const perGroup = resolveDisplayPrefs({ scope: 'per-group', globalPrefs: GLOBAL_PREFS, group: {} });
  const global = resolveDisplayPrefs({ scope: 'global', globalPrefs: GLOBAL_PREFS, group: {} });
  assert.deepEqual(perGroup, global);

  const missing = resolveDisplayPrefs({ scope: 'per-group', globalPrefs: GLOBAL_PREFS, group: null });
  assert.deepEqual(missing, global);
});

test('a missing group never breaks resolution', () => {
  assert.deepEqual(resolveDisplayPrefs({}), DISPLAY_PREF_DEFAULTS);
  assert.deepEqual(resolveDisplayPrefs(), DISPLAY_PREF_DEFAULTS);
});

test('readGroupDisplayPrefs distinguishes "not stored" from "stored as default"', () => {
  const inherited = readGroupDisplayPrefs({}, { showTimestamp: true });
  assert.equal(inherited.showTimestamp, true);

  const explicit = readGroupDisplayPrefs(
    { uiPrefs: { showTimestamp: false, echoSentData: true } },
    { showTimestamp: true }
  );
  assert.equal(explicit.showTimestamp, false);
  assert.equal(explicit.echoSentData, true);
});

test('displayPrefsEqual compares only the five scope-managed fields', () => {
  assert.equal(displayPrefsEqual({ showTimestamp: true }, { showTimestamp: true }), true);
  assert.equal(displayPrefsEqual({ showTimestamp: true }, { showTimestamp: false }), false);
  // 缺项按默认值补齐后比较：undefined 与 false 在 showTimestamp 上是等价的。
  assert.equal(displayPrefsEqual({}, { showTimestamp: false }), true);
  // 多余字段不影响结论。
  assert.equal(displayPrefsEqual({ showTimestamp: true, extra: 1 }, { showTimestamp: true }), true);
});
