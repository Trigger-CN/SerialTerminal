'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { translations, t } = require('../i18n');

function flattenKeys(value, prefix = '', keys = []) {
  Object.entries(value).forEach(([name, child]) => {
    const key = prefix ? `${prefix}.${name}` : name;
    if (child && typeof child === 'object' && !Array.isArray(child)) flattenKeys(child, key, keys);
    else keys.push(key);
  });
  return keys;
}

test('Simplified Chinese covers every English translation key', () => {
  const englishKeys = flattenKeys(translations.en).sort();
  const chineseKeys = new Set(flattenKeys(translations['zh-CN']));
  assert.deepEqual(englishKeys.filter(key => !chineseKeys.has(key)), []);
});

test('all configured languages fall back to English for missing keys', () => {
  const englishKeys = flattenKeys(translations.en);
  Object.keys(translations).forEach(language => {
    englishKeys.forEach(key => assert.notEqual(t(language, key), key, `${language} failed to resolve ${key}`));
  });
});

test('translation interpolation replaces known parameters', () => {
  assert.equal(t('zh-CN', 'main.bytesSent', { count: 12 }), '已发送 12 字节');
  assert.equal(t('unknown', 'updateDialog.versionAvailable', { version: '1.2.3' }), 'Version 1.2.3 is available.');
});
