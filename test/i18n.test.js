'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { translations, t } = require('../i18n');

const root = path.join(__dirname, '..');

function flattenKeys(value, prefix = '', keys = []) {
  Object.entries(value).forEach(([name, child]) => {
    const key = prefix ? `${prefix}.${name}` : name;
    if (child && typeof child === 'object' && !Array.isArray(child)) flattenKeys(child, key, keys);
    else keys.push(key);
  });
  return keys;
}

test('every configured language covers every English translation key', () => {
  const englishKeys = flattenKeys(translations.en).sort();
  Object.entries(translations).forEach(([language, values]) => {
    assert.deepEqual(flattenKeys(values).sort(), englishKeys, `${language} translation keys differ from English`);
  });
});

test('all translations preserve English interpolation parameters', () => {
  const flattenValues = (value, prefix = '', values = {}) => {
    Object.entries(value).forEach(([name, child]) => {
      const key = prefix ? `${prefix}.${name}` : name;
      if (child && typeof child === 'object' && !Array.isArray(child)) flattenValues(child, key, values);
      else values[key] = String(child);
    });
    return values;
  };
  const parameters = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  const englishValues = flattenValues(translations.en);

  Object.entries(translations).forEach(([language, values]) => {
    const localizedValues = flattenValues(values);
    Object.entries(englishValues).forEach(([key, text]) => {
      assert.deepEqual(parameters(localizedValues[key]), parameters(text), `${language} interpolation parameters differ for ${key}`);
    });
  });
});

test('application source only references defined translation keys', () => {
  const sourceFiles = ['main.js', 'renderer.js', 'preferences.js'];
  const referencedKeys = new Set();
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\btr(?:Fallback)?\(\s*['"]([^'"]+)['"]/g)) referencedKeys.add(match[1]);
  }

  const englishKeys = new Set(flattenKeys(translations.en));
  assert.deepEqual([...referencedKeys].filter(key => !englishKeys.has(key)).sort(), []);
});

test('translation interpolation replaces known parameters', () => {
  assert.equal(t('zh-CN', 'main.bytesSent', { count: 12 }), '已发送 12 字节');
  assert.equal(t('unknown', 'updateDialog.versionAvailable', { version: '1.2.3' }), 'Version 1.2.3 is available.');
});

test('add-to-list labels do not duplicate the add icon', () => {
  Object.keys(translations).forEach(language => {
    assert.doesNotMatch(t(language, 'main.addToList'), /^\s*\+/);
  });
  assert.equal(t('en', 'main.addToList'), 'Add to List');
  assert.equal(t('zh-CN', 'main.addToList'), '添加到列表');
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

test('search history actions and limit help are translated', () => {
  Object.keys(translations).forEach(language => {
    assert.notEqual(t(language, 'main.searchHistory'), 'main.searchHistory');
    assert.match(t(language, 'main.pinSearchHistory', { query: 'ready' }), /ready/);
    assert.notEqual(t(language, 'prefs.searchHistoryLimit'), 'prefs.searchHistoryLimit');
  });
  assert.equal(t('zh-CN', 'main.searchHistory'), '搜索历史');
  assert.match(t('en', 'prefs.searchHistoryHelp'), /Pinned searches are always kept/);
});

test('shell context menu labels never expose translation keys', () => {
  const keys = [
    'main.moveToOtherPane',
    'main.contextRestartShell',
    'main.contextToggleShellTextMode',
    'main.contextCloseShellTab',
    'main.newShellTab',
    'main.contextPasteAndSend',
    'main.contextSendSelection',
    'main.contextCopy',
    'main.contextCopyAll',
    'main.contextFindSelection',
    'main.contextClearTerminal'
  ];

  Object.keys(translations).forEach(language => {
    keys.forEach(key => assert.notEqual(t(language, key), key, `${language} failed to resolve ${key}`));
  });
  assert.equal(t('zh-CN', 'main.contextRestartShell'), '重启 Shell');
  assert.equal(t('zh-CN', 'main.contextCloseShellTab'), '关闭 Shell 标签页');
});
