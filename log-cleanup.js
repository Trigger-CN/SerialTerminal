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
  for (const entry of entries) {
    if (!entry.isFile() || !LOG_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

    const filePath = path.resolve(directory, entry.name);
    if (activePaths.has(filePath)) continue;

    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.mtimeMs >= cutoff) continue;
      await fs.promises.unlink(filePath);
      deleted.push(filePath);
    } catch (error) {
      failed.push({ filePath, error });
    }
  }

  return { deleted, failed };
}

module.exports = { cleanupExpiredLogFiles };
