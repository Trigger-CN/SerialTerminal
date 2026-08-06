'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getVerticalInsertionIndex,
  reorderQuickSendItems,
  disableSidebarQuickSend,
  deleteQuickSendById
} = require('../quick-send-reorder');

const shortcutRects = [
  { top: 400, height: 36 },
  { top: 442, height: 36 },
  { top: 484, height: 36 }
];

test('quick-send insertion accepts the empty area above the first shortcut', () => {
  assert.equal(getVerticalInsertionIndex(shortcutRects, 120), 0);
  assert.equal(getVerticalInsertionIndex(shortcutRects, 399), 0);
});

test('quick-send insertion follows item centers and accepts the trailing area', () => {
  assert.equal(getVerticalInsertionIndex(shortcutRects, 419), 1);
  assert.equal(getVerticalInsertionIndex(shortcutRects, 465), 2);
  assert.equal(getVerticalInsertionIndex(shortcutRects, 700), 3);
});

test('inner quick-send order follows dragged IDs without dropping unknown items', () => {
  const items = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  assert.deepEqual(reorderQuickSendItems(items, ['three', 'one']), [items[2], items[0], items[1]]);
});

test('removing an outer shortcut only disables its sidebar option', () => {
  const items = [
    { id: 'one', content: 'KEEP', sidebarShortcut: { enabled: true, text: 'K' } },
    { id: 'two', content: 'ALSO KEEP', sidebarShortcut: { enabled: true, text: 'A' } }
  ];
  const result = disableSidebarQuickSend(items, ['one', 'two'], 'one');

  assert.equal(result.changed, true);
  assert.equal(result.quickSendList.length, 2);
  assert.equal(result.quickSendList[0].content, 'KEEP');
  assert.deepEqual(result.quickSendList[0].sidebarShortcut, { enabled: false, text: 'K' });
  assert.deepEqual(result.sidebarQuickSendOrder, ['two']);
});

test('deleting an inner quick send also removes its outer shortcut', () => {
  const items = [{ id: 'one' }, { id: 'two' }];
  const result = deleteQuickSendById(items, ['two', 'one'], 'one');

  assert.equal(result.changed, true);
  assert.deepEqual(result.quickSendList, [{ id: 'two' }]);
  assert.deepEqual(result.sidebarQuickSendOrder, ['two']);
});
