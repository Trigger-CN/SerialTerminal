'use strict';

const { randomUUID } = require('crypto');
const { normalizeIntegerSetting } = require('./config-values');

function normalizeTimestamp(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function normalizeSortOrder(value) {
  return Number.isFinite(value) ? value : 0;
}

function searchIdentity(item) {
  return JSON.stringify([
    item.query,
    item.regex === true,
    item.caseSensitive === true,
    item.wholeWord === true
  ]);
}

function compareSearchHistoryItems(left, right) {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (left.lastUsedAt !== right.lastUsedAt) return right.lastUsedAt - left.lastUsedAt;
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
  return left.id.localeCompare(right.id);
}

function applySearchHistoryLimit(history, limit) {
  const normalizedLimit = normalizeIntegerSetting(limit, 'searchHistoryLimit');
  const pinned = history.filter(item => item.pinned).sort(compareSearchHistoryItems);
  const unpinnedCapacity = Math.max(0, normalizedLimit - pinned.length);
  const unpinned = history.filter(item => !item.pinned)
    .sort(compareSearchHistoryItems)
    .slice(0, unpinnedCapacity);
  return [...pinned, ...unpinned].sort(compareSearchHistoryItems);
}

function normalizeSearchHistory(history, limit, options = {}) {
  const now = Number.isFinite(options.now) ? Math.trunc(options.now) : Date.now();
  const createId = typeof options.createId === 'function' ? options.createId : randomUUID;
  const entries = Array.isArray(history) ? history : [];
  const seenIds = new Set();
  const byIdentity = new Map();

  entries.forEach(item => {
    if (!item || typeof item !== 'object' || typeof item.query !== 'string' || !item.query) return;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : createId();
    while (seenIds.has(id)) id = createId();
    seenIds.add(id);
    const createdAt = normalizeTimestamp(item.createdAt, now);
    const normalized = {
      id,
      query: item.query,
      regex: item.regex === true,
      caseSensitive: item.caseSensitive === true,
      wholeWord: item.wholeWord === true,
      pinned: item.pinned === true,
      createdAt,
      lastUsedAt: normalizeTimestamp(item.lastUsedAt, createdAt),
      sortOrder: normalizeSortOrder(item.sortOrder)
    };
    const identity = searchIdentity(normalized);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, normalized);
      return;
    }
    existing.pinned = existing.pinned || normalized.pinned;
    existing.createdAt = Math.min(existing.createdAt, normalized.createdAt);
    existing.lastUsedAt = Math.max(existing.lastUsedAt, normalized.lastUsedAt);
  });

  return applySearchHistoryLimit([...byIdentity.values()], limit);
}

function recordSearchHistory(history, search, limit, options = {}) {
  const now = Number.isFinite(options.now) ? Math.trunc(options.now) : Date.now();
  const createId = typeof options.createId === 'function' ? options.createId : randomUUID;
  const normalized = normalizeSearchHistory(history, limit, { now, createId });
  if (!search || typeof search.query !== 'string' || !search.query) return normalized;
  const candidate = {
    query: search.query,
    regex: search.regex === true,
    caseSensitive: search.caseSensitive === true,
    wholeWord: search.wholeWord === true
  };
  const identity = searchIdentity(candidate);
  const existing = normalized.find(item => searchIdentity(item) === identity);
  if (existing) {
    existing.lastUsedAt = now;
  } else {
    const nextSortOrder = normalized.reduce((maximum, item) => Math.max(maximum, item.sortOrder), 0) + 1;
    normalized.push({
      id: createId(),
      ...candidate,
      pinned: false,
      createdAt: now,
      lastUsedAt: now,
      sortOrder: nextSortOrder
    });
  }
  return applySearchHistoryLimit(normalized, limit);
}

function setSearchHistoryPinned(history, id, pinned, limit, options = {}) {
  const normalized = normalizeSearchHistory(history, limit, options);
  normalized.forEach(item => {
    if (item.id === id) item.pinned = pinned === true;
  });
  return applySearchHistoryLimit(normalized, limit);
}

function deleteSearchHistoryItem(history, id, limit, options = {}) {
  return normalizeSearchHistory(history, limit, options).filter(item => item.id !== id);
}

module.exports = {
  applySearchHistoryLimit,
  compareSearchHistoryItems,
  deleteSearchHistoryItem,
  normalizeSearchHistory,
  recordSearchHistory,
  setSearchHistoryPinned
};
