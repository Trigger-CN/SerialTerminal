'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getVerticalInsertionIndex,
  reorderQuickSendItems,
  reorderQuickSendGroups,
  moveQuickSendGroup,
  moveQuickSendItem,
  deleteQuickSendGroup,
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

test('quick-send groups follow dragged IDs without dropping unknown groups', () => {
  const groups = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  assert.deepEqual(reorderQuickSendGroups(groups, ['three', 'one']), [groups[2], groups[0], groups[1]]);
});

test('quick-send group moves to an insertion index without changing its contents', () => {
  const groups = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  assert.deepEqual(moveQuickSendGroup(groups, 'one', 2), [groups[1], groups[2], groups[0]]);
  assert.deepEqual(moveQuickSendGroup(groups, 'three', 0), [groups[2], groups[0], groups[1]]);
});

test('quick send can move within and across groups', () => {
  const items = [
    { id: 'one', groupId: 'a' },
    { id: 'two', groupId: 'a' },
    { id: 'three', groupId: 'b' }
  ];
  assert.deepEqual(moveQuickSendItem(items, 'one', 'b', 0), [
    { id: 'two', groupId: 'a' },
    { id: 'one', groupId: 'b' },
    { id: 'three', groupId: 'b' }
  ]);
  assert.deepEqual(moveQuickSendItem(items, 'one', null, 0).at(-1), { id: 'one', groupId: null });
});

test('deleting a group removes its commands and sidebar references', () => {
  const result = deleteQuickSendGroup(
    [{ id: 'a' }, { id: 'b' }],
    [{ id: 'one', groupId: 'a' }, { id: 'two', groupId: 'b' }, { id: 'three', groupId: 'a' }],
    ['three', 'two', 'one'],
    'a'
  );
  assert.deepEqual(result.quickSendGroups, [{ id: 'b' }]);
  assert.deepEqual(result.quickSendList, [{ id: 'two', groupId: 'b' }]);
  assert.deepEqual(result.sidebarQuickSendOrder, ['two']);
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
