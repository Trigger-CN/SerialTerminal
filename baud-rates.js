'use strict';

const STANDARD_BAUD_RATES = Object.freeze([
  '110', '300', '600', '1200', '2400', '4800', '9600', '14400', '19200', '38400',
  '56000', '57600', '115200', '128000', '256000', '460800', '512000', '921600',
  '1000000', '2000000'
]);
const STANDARD_BAUD_RATE_SET = new Set(STANDARD_BAUD_RATES);

function normalizeBaudRate(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    value = Number(trimmed);
  }
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return String(value);
}

function normalizeCustomBaudRates(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const baudRate = normalizeBaudRate(value);
    if (!baudRate || STANDARD_BAUD_RATE_SET.has(baudRate) || seen.has(baudRate)) continue;
    seen.add(baudRate);
    normalized.push(baudRate);
  }
  return normalized;
}

function isStandardBaudRate(value) {
  const baudRate = normalizeBaudRate(value);
  return baudRate !== null && STANDARD_BAUD_RATE_SET.has(baudRate);
}

module.exports = {
  STANDARD_BAUD_RATES,
  isStandardBaudRate,
  normalizeBaudRate,
  normalizeCustomBaudRates
};
