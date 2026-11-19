'use strict';

// 只保留 9600 及以上的速率。
//
// 9600 以下（110/300/600/1200/2400/4800）在现代串口设备上已经基本见不到：
// 嵌入式调试、日志输出、固件烧录都在 115200 以上，保留它们只是把常用值挤到
// 下拉框下半部分。这些值同时也不再被视为「标准值」——老配置里残留的会被
// normalizeCustomBaudRates 当作非标准值挡掉，不会悄悄混进自定义列表。
const STANDARD_BAUD_RATES = Object.freeze([
  '9600', '14400', '19200', '38400',
  '56000', '57600', '115200', '128000', '256000', '460800', '512000', '921600',
  '1000000', '2000000'
]);
const STANDARD_BAUD_RATE_SET = new Set(STANDARD_BAUD_RATES);

// 最低可用波特率。低于它的值既不显示、也不接受为自定义项：
// 老配置里若残留 4800 之类的值，归一化时直接丢弃，而不是转成自定义项。
const MIN_BAUD_RATE = 9600;

function normalizeBaudRate(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    value = Number(trimmed);
  }
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return String(value);
}

function isSupportedBaudRate(value) {
  const baudRate = normalizeBaudRate(value);
  return baudRate !== null && Number(baudRate) >= MIN_BAUD_RATE;
}

function normalizeCustomBaudRates(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const baudRate = normalizeBaudRate(value);
    if (!baudRate || STANDARD_BAUD_RATE_SET.has(baudRate) || seen.has(baudRate)) continue;
    // 低于最低值的残留项直接丢弃，不让它转成自定义波特率混进下拉框。
    if (Number(baudRate) < MIN_BAUD_RATE) continue;
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
  MIN_BAUD_RATE,
  isSupportedBaudRate,
  isStandardBaudRate,
  normalizeBaudRate,
  normalizeCustomBaudRates
};
