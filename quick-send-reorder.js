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
  disableSidebarQuickSend,
  deleteQuickSendById
};
