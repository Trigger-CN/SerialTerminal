'use strict';

// 发送回显行的纯格式化逻辑：负责控制字符转义、长度截断与文本/HEX 双通道拼装。
// 不依赖 Electron 或 DOM，便于单测。

const MAX_PREVIEW_CHARS = 512;
const MAX_HEX_BYTES = 256;
const ELLIPSIS = '…';

function escapeControlChars(text) {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (character === '\r') { out += '\\r'; continue; }
    if (character === '\n') { out += '\\n'; continue; }
    if (character === '\t') { out += '\\t'; continue; }
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
      continue;
    }
    out += character;
  }
  return out;
}

function truncateText(text, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_PREVIEW_CHARS;
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  return characters.slice(0, limit).join('') + ELLIPSIS;
}

function truncateHexLines(bytes, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_HEX_BYTES;
  if (bytes.length <= limit) return bytes;
  return bytes.subarray(0, limit);
}

function toHexString(bytes) {
  const parts = [];
  for (const byte of bytes) parts.push(byte.toString(16).toUpperCase().padStart(2, '0'));
  return parts.join(' ');
}

function decodeHexToText(bytes) {
  // 用宽松解码：二进制内容会出现替换字符，仍可读，不会抛错。
  return bytes.toString('utf8');
}

// 生成发送回显的主体内容。
// both=true 时同时给出文本与 HEX 两种表示；否则按发送模式只给一种。
function formatSentBody(record, options = {}) {
  const bytes = Buffer.isBuffer(record.bytes)
    ? record.bytes
    : Buffer.from(record.hex || '', 'hex');
  const both = options.both === true;
  const truncatedBytes = truncateHexLines(bytes, options.maxHexBytes);
  const hexSuffix = truncatedBytes.length < bytes.length ? ` ${ELLIPSIS}` : '';
  const hexText = toHexString(truncatedBytes) + hexSuffix;
  const rawText = typeof record.text === 'string' ? record.text : decodeHexToText(truncatedBytes);
  const textPart = truncateText(escapeControlChars(rawText), options.maxChars);

  // 两种表示总是都产出，由调用方按模式与“同时显示”开关决定怎么拼；
  // 这样过滤标签页可以自由切换而无需重算。
  const textForLine = textPart || ELLIPSIS;
  if (record.mode === 'hex') {
    return { text: textPart, hex: hexText, line: both ? `${hexText} | ${textForLine}` : hexText };
  }
  return { text: textPart, hex: hexText, line: both ? `${textForLine} | ${hexText}` : textPart };
}

// 组装完整回显行：时间戳 + 方向与字节数 + 内容。
function formatSentRecord(record, options = {}) {
  const label = typeof options.label === 'string' && options.label ? options.label : 'TX';
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
  const byteCount = Number.isFinite(record.bytes?.length) ? record.bytes.length
    : (Number.isFinite(record.bytes) ? record.bytes : 0);
  const header = timestamp ? `[${timestamp}] [${label} ${byteCount}B]` : `[${label} ${byteCount}B]`;
  const body = formatSentBody(record, options);
  return { header, text: body.text, hex: body.hex, line: `${header} ${body.line}` };
}

module.exports = {
  MAX_PREVIEW_CHARS,
  MAX_HEX_BYTES,
  escapeControlChars,
  formatSentBody,
  formatSentRecord
};
