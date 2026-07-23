'use strict';

const iconv = require('iconv-lite');

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const SUPPORTED_TEXT_ENCODINGS = new Set(['utf8', 'ascii', 'gbk']);
const HEX_SEPARATOR_RE = /[\s,:-]/;

function failure(code, message, details = {}) {
  return { ok: false, code, message, ...details };
}

function parseHexInput(input, options = {}) {
  if (typeof input !== 'string') {
    return failure('INVALID_INPUT_TYPE', 'Hex input must be a string');
  }

  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : DEFAULT_MAX_PAYLOAD_BYTES;
  const tokens = [];
  let tokenStart = -1;

  for (let index = 0; index <= input.length; index++) {
    const character = input[index];
    if (index === input.length || HEX_SEPARATOR_RE.test(character)) {
      if (tokenStart !== -1) {
        tokens.push({ value: input.slice(tokenStart, index), position: tokenStart });
        tokenStart = -1;
      }
    } else if (tokenStart === -1) {
      tokenStart = index;
    }
  }

  if (tokens.length === 0) {
    return failure('EMPTY_INPUT', 'Hex input is empty');
  }

  let hexDigits = '';
  for (const token of tokens) {
    if (/^0x/i.test(token.value)) {
      if (!/^0x[0-9a-f]{2}$/i.test(token.value)) {
        return failure('INVALID_HEX_TOKEN', `Invalid hex token: ${token.value}`, {
          token: token.value,
          position: token.position
        });
      }
      hexDigits += token.value.slice(2);
      continue;
    }

    const invalidOffset = token.value.search(/[^0-9a-f]/i);
    if (invalidOffset !== -1) {
      return failure('INVALID_HEX_CHAR', `Invalid hex character: ${token.value[invalidOffset]}`, {
        token: token.value,
        position: token.position + invalidOffset
      });
    }
    hexDigits += token.value;
  }

  if (hexDigits.length % 2 !== 0) {
    return failure('ODD_HEX_DIGITS', 'Hex input contains an incomplete byte', {
      position: input.length
    });
  }

  const byteCount = hexDigits.length / 2;
  if (byteCount > maxBytes) {
    return failure('PAYLOAD_TOO_LARGE', `Payload exceeds the ${maxBytes} byte limit`, {
      byteCount,
      maxBytes
    });
  }

  const bytes = Buffer.allocUnsafe(byteCount);
  const normalizedParts = new Array(byteCount);
  for (let index = 0; index < byteCount; index++) {
    const pair = hexDigits.slice(index * 2, index * 2 + 2).toUpperCase();
    bytes[index] = Number.parseInt(pair, 16);
    normalizedParts[index] = pair;
  }

  return {
    ok: true,
    bytes,
    normalized: normalizedParts.join(' '),
    byteCount
  };
}

function normalizeEncoding(encoding) {
  const normalized = String(encoding || 'utf8').toLowerCase().replace(/[-_]/g, '');
  return normalized === 'utf8' || normalized === 'ascii' || normalized === 'gbk'
    ? normalized
    : '';
}

function newlineBytes(newlineMode) {
  if (newlineMode === 'lf') return '\n';
  if (newlineMode === 'cr') return '\r';
  return '\r\n';
}

function buildSerialWriteBuffer(request, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return failure('INVALID_REQUEST', 'Serial write request must be an object');
  }

  const mode = request.mode === undefined ? 'text' : request.mode;
  if (mode !== 'text' && mode !== 'hex') {
    return failure('INVALID_MODE', 'Serial write mode must be text or hex');
  }
  if (typeof request.content !== 'string') {
    return failure('INVALID_CONTENT', 'Serial write content must be a string');
  }

  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : DEFAULT_MAX_PAYLOAD_BYTES;
  let bytes;

  if (mode === 'hex') {
    const parsed = parseHexInput(request.content, { maxBytes });
    if (!parsed.ok) return parsed;
    bytes = parsed.bytes;
  } else {
    const encoding = normalizeEncoding(request.encoding || options.defaultEncoding);
    if (!encoding || !SUPPORTED_TEXT_ENCODINGS.has(encoding)) {
      return failure('UNSUPPORTED_ENCODING', `Unsupported text encoding: ${request.encoding || options.defaultEncoding || ''}`);
    }

    let content = request.content;
    const terminalEnter = request.terminalEnter === true
      || (content === '\r' && (request.source === 'terminal' || request.newlineMode !== undefined));
    if (terminalEnter) {
      content = newlineBytes(request.newlineMode || options.defaultNewlineMode);
    }
    if (!content && request.appendCrLf !== true) {
      return failure('EMPTY_INPUT', 'Serial write content is empty');
    }
    bytes = iconv.encode(content, encoding);
  }

  if (request.appendCrLf === true) {
    bytes = Buffer.concat([bytes, Buffer.from([0x0d, 0x0a])]);
  }
  if (bytes.length > maxBytes) {
    return failure('PAYLOAD_TOO_LARGE', `Payload exceeds the ${maxBytes} byte limit`, {
      byteCount: bytes.length,
      maxBytes
    });
  }

  return { ok: true, bytes, byteCount: bytes.length };
}

module.exports = {
  DEFAULT_MAX_PAYLOAD_BYTES,
  SUPPORTED_TEXT_ENCODINGS,
  parseHexInput,
  buildSerialWriteBuffer
};
