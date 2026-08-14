'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOG_FILE_EXTENSIONS = new Set(['.txt', '.log', '.bin']);
const DAY_MS = 24 * 60 * 60 * 1000;

async function cleanupExpiredLogFiles(directory, retentionDays, options = {}) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0 || typeof directory !== 'string' || !directory) {
    return { deleted: [], failed: [] };
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const cutoff = now - days * DAY_MS;
  const activePaths = new Set(
    Array.from(options.activePaths || [], filePath => path.resolve(filePath))
  );
  let entries;

  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { deleted: [], failed: [] };
    throw error;
  }

  const deleted = [];
  const failed = [];
  async function cleanEntries(parent, children, removeWhenEmpty = false) {
    for (const entry of children) {
      const filePath = path.resolve(parent, entry.name);
      if (entry.isDirectory()) {
        if (removeWhenEmpty || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
        try {
          const nested = await fs.promises.readdir(filePath, { withFileTypes: true });
          await cleanEntries(filePath, nested, true);
        } catch (error) {
          failed.push({ filePath, error });
        }
        continue;
      }
      if (!entry.isFile() || !LOG_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || activePaths.has(filePath)) continue;
      try {
        const stats = await fs.promises.stat(filePath);
        if (stats.mtimeMs >= cutoff) continue;
        await fs.promises.unlink(filePath);
        deleted.push(filePath);
      } catch (error) {
        failed.push({ filePath, error });
      }
    }
    if (!removeWhenEmpty) return;
    try {
      const remaining = await fs.promises.readdir(parent);
      if (remaining.length === 0) await fs.promises.rmdir(parent);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') failed.push({ filePath: parent, error });
    }
  }
  await cleanEntries(directory, entries);

  return { deleted, failed };
}

module.exports = { cleanupExpiredLogFiles };
