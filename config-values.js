'use strict';

const INTEGER_SETTINGS = Object.freeze({
  fontSize: Object.freeze({ min: 8, max: 72, fallback: 14 }),
  scrollbackLimit: Object.freeze({ min: 1000, max: 1000000, fallback: 100000 }),
  historyBufferSize: Object.freeze({ min: 10000, max: 100000000, fallback: 5000000 }),
  mouseWheelScrollLines: Object.freeze({ min: 1, max: 50, fallback: 3 }),
  mainInputHistoryLimit: Object.freeze({ min: 0, max: 200, fallback: 20 }),
  hexIdleFlushMs: Object.freeze({ min: 0, max: 1000, fallback: 50 }),
  rawBufferAutoFlushMB: Object.freeze({ min: 1, max: 1024, fallback: 10 })
});

function normalizeIntegerSetting(value, setting) {
  const range = INTEGER_SETTINGS[setting];
  if (!range) throw new Error(`Unknown integer setting: ${setting}`);
  if (value === null || value === undefined || value === '') return range.fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) return range.fallback;
  return Math.min(range.max, Math.max(range.min, number));
}

module.exports = { INTEGER_SETTINGS, normalizeIntegerSetting };
