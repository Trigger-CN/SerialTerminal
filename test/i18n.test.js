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

test('quick-send disconnected toast is translated for every configured language', () => {
  const expected = {
    en: 'Hold on, did you forget to open the serial port?',
    'zh-CN': '且慢，你是不是忘记打开串口了？',
    'zh-TW': '且慢，你是不是忘記開啟串口了？',
    fr: 'Un instant, avez-vous oublié d’ouvrir le port série ?',
    ru: 'Постойте, вы не забыли открыть последовательный порт?',
    de: 'Moment, haben Sie vergessen, den seriellen Port zu öffnen?'
  };
  Object.entries(expected).forEach(([language, text]) => {
    assert.equal(t(language, 'main.quickSendDisconnectedToast'), text);
  });
});

test('scheduled update toast directs users to update settings', () => {
  assert.equal(t('en', 'main.updateToastMessage', { version: '1.2.3' }), 'Version 1.2.3 is available. Update it from Settings > About.');
  assert.equal(t('zh-CN', 'main.updateToastMessage', { version: '1.2.3' }), '新版本 1.2.3 已发布，请前往“设置 > 关于”进行更新。');
});
