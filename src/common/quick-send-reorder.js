'use strict';

function getVerticalInsertionIndex(rects, pointerY) {
  const y = Number(pointerY);
  if (!Number.isFinite(y)) return rects.length;

  const index = rects.findIndex(rect => {
    const top = Number(rect?.top);
    const height = Number(rect?.height);
    return Number.isFinite(top) && Number.isFinite(height) && y < top + height / 2;
  });

  return index < 0 ? rects.length : index;
}

function reorderQuickSendItems(items, orderedIds) {
  const byId = new Map(items.map(item => [item.id, item]));
  const seen = new Set();
  const ordered = [];

  orderedIds.forEach(id => {
    const item = byId.get(id);
    if (!item || seen.has(id)) return;
    seen.add(id);
    ordered.push(item);
  });

  items.forEach(item => {
    if (!seen.has(item.id)) ordered.push(item);
  });
  return ordered;
}

function reorderQuickSendGroups(groups, orderedIds) {
  return reorderQuickSendItems(groups, orderedIds);
}

function moveQuickSendGroup(groups, groupId, insertionIndex) {
  const group = groups.find(entry => entry.id === groupId);
  if (!group) return groups;
  const remaining = groups.filter(entry => entry.id !== groupId);
  const index = Math.max(0, Math.min(Number.isInteger(insertionIndex) ? insertionIndex : remaining.length, remaining.length));
  return [...remaining.slice(0, index), group, ...remaining.slice(index)];
}

function moveQuickSendItem(items, itemId, groupId, insertionIndex) {
  const item = items.find(entry => entry.id === itemId);
  if (!item) return items;
  const remaining = items.filter(entry => entry.id !== itemId);
  const targetIds = remaining.filter(entry => (entry.groupId || null) === (groupId || null)).map(entry => entry.id);
  const index = Math.max(0, Math.min(Number.isInteger(insertionIndex) ? insertionIndex : targetIds.length, targetIds.length));
  const beforeId = targetIds[index];
  const moved = { ...item, groupId: groupId || null };
  if (!beforeId) return [...remaining, moved];
  const beforeIndex = remaining.findIndex(entry => entry.id === beforeId);
  return [...remaining.slice(0, beforeIndex), moved, ...remaining.slice(beforeIndex)];
}

function deleteQuickSendGroup(groups, items, sidebarOrder, groupId) {
  const removedIds = new Set(items.filter(item => item.groupId === groupId).map(item => item.id));
  const quickSendGroups = groups.filter(group => group.id !== groupId);
  const quickSendList = items.filter(item => !removedIds.has(item.id));
  const sidebarQuickSendOrder = sidebarOrder.filter(id => !removedIds.has(id));
  return {
    quickSendGroups,
    quickSendList,
    sidebarQuickSendOrder,
    changed: quickSendGroups.length !== groups.length
  };
}

function disableSidebarQuickSend(items, sidebarOrder, itemId) {
  let itemChanged = false;
  const quickSendList = items.map(item => {
    if (item.id !== itemId || item.sidebarShortcut?.enabled !== true) return item;
    itemChanged = true;
    return {
      ...item,
      sidebarShortcut: {
        ...item.sidebarShortcut,
        enabled: false
      }
    };
  });
  const sidebarQuickSendOrder = sidebarOrder.filter(id => id !== itemId);
  return {
    quickSendList,
    sidebarQuickSendOrder,
    changed: itemChanged || sidebarQuickSendOrder.length !== sidebarOrder.length
  };
}

function deleteQuickSendById(items, sidebarOrder, itemId) {
  const quickSendList = items.filter(item => item.id !== itemId);
  const sidebarQuickSendOrder = sidebarOrder.filter(id => id !== itemId);
  return {
    quickSendList,
    sidebarQuickSendOrder,
    changed: quickSendList.length !== items.length || sidebarQuickSendOrder.length !== sidebarOrder.length
  };
}

module.exports = {
  getVerticalInsertionIndex,
  reorderQuickSendItems,
  reorderQuickSendGroups,
  moveQuickSendGroup,
  moveQuickSendItem,
  deleteQuickSendGroup,
  disableSidebarQuickSend,
  deleteQuickSendById
};
