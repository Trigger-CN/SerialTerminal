'use strict';

const VALID_BYTES_PER_LINE = new Set([8, 16, 24, 32]);

function normalizeOptions(options = {}) {
  const idleFlushMs = Number(options.idleFlushMs);
  return {
    bytesPerLine: VALID_BYTES_PER_LINE.has(Number(options.bytesPerLine)) ? Number(options.bytesPerLine) : 16,
    showOffset: options.showOffset !== false,
    showAscii: options.showAscii !== false,
    uppercase: options.uppercase !== false,
    idleFlushMs: Number.isFinite(idleFlushMs) && idleFlushMs >= 0 && idleFlushMs <= 1000 ? idleFlushMs : 50
  };
}

function byteToPrintableAscii(byte) {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
}

function formatHexLine(offset, bytes, options = {}) {
  const settings = normalizeOptions(options);
  const values = Array.from(bytes || []);
  const formatByte = byte => byte.toString(16).padStart(2, '0')[settings.uppercase ? 'toUpperCase' : 'toLowerCase']();
  const hexText = values.map(formatByte).join(' ');
  const asciiText = values.map(byteToPrintableAscii).join('');
  const columns = [];
  if (settings.showOffset) {
    const offsetText = Math.max(0, Number(offset) || 0).toString(16).padStart(8, '0');
    columns.push(settings.uppercase ? offsetText.toUpperCase() : offsetText.toLowerCase());
  }
  columns.push(settings.showAscii ? hexText.padEnd(settings.bytesPerLine * 3 - 1, ' ') : hexText);
  if (settings.showAscii) columns.push(`|${asciiText}|`);
  return {
    offset,
    bytes: Uint8Array.from(values),
    hexText,
    asciiText,
    output: `${columns.join('  ')}\r\n`
  };
}

class HexStreamFormatter {
  constructor(options = {}, onLines = null) {
    this.options = normalizeOptions(options);
    this.onLines = typeof onLines === 'function' ? onLines : null;
    this.offset = 0;
    this.pendingBytes = [];
    this.idleTimer = null;
  }

  configure(options = {}) {
    this.options = normalizeOptions({ ...this.options, ...options });
  }

  push(bytes) {
    const incoming = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    if (!incoming.length) return [];
    this.cancelIdleFlush();
    const combined = new Uint8Array(this.pendingBytes.length + incoming.length);
    combined.set(this.pendingBytes);
    combined.set(incoming, this.pendingBytes.length);
    const lines = [];
    let consumed = 0;
    while (combined.length - consumed >= this.options.bytesPerLine) {
      const lineBytes = combined.subarray(consumed, consumed + this.options.bytesPerLine);
      lines.push(formatHexLine(this.offset, lineBytes, this.options));
      this.offset += lineBytes.length;
      consumed += lineBytes.length;
    }
    this.pendingBytes = Array.from(combined.subarray(consumed));
    this.emit(lines);
    if (this.pendingBytes.length) {
      if (this.options.idleFlushMs === 0) {
        return lines.concat(this.flush());
      }
      this.idleTimer = setTimeout(() => this.flush(), this.options.idleFlushMs);
    }
    return lines;
  }

  takeLine(length) {
    const bytes = this.pendingBytes.splice(0, length);
    const line = formatHexLine(this.offset, bytes, this.options);
    this.offset += bytes.length;
    return line;
  }

  flush() {
    this.cancelIdleFlush();
    if (!this.pendingBytes.length) return [];
    const lines = [this.takeLine(this.pendingBytes.length)];
    this.emit(lines);
    return lines;
  }

  reset({ resetOffset = true, flush = false } = {}) {
    if (flush) this.flush();
    this.cancelIdleFlush();
    this.pendingBytes = [];
    if (resetOffset) this.offset = 0;
  }

  cancelIdleFlush() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  emit(lines) {
    if (lines.length && this.onLines) this.onLines(lines);
  }

  dispose() {
    this.cancelIdleFlush();
    this.pendingBytes = [];
  }
}

module.exports = { HexStreamFormatter, formatHexLine, byteToPrintableAscii };
