'use strict';

const iconv = require('iconv-lite');

const SUPPORTED_ENCODINGS = new Set(['utf8', 'ascii', 'gbk']);

class SerialTextStream {
  constructor({ encoding = 'utf8', maxLineLength = 64 * 1024, onRecord = null } = {}) {
    this.encoding = SUPPORTED_ENCODINGS.has(encoding) ? encoding : 'utf8';
    this.maxLineLength = Math.max(256, Number(maxLineLength) || 64 * 1024);
    this.onRecord = typeof onRecord === 'function' ? onRecord : null;
    this.sequence = 0;
    this.reset();
  }

  write(bytes, receivedAt = Date.now()) {
    if (this.disposed) return [];
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (!buffer.length) return [];
    this.lastReceivedAt = Number.isFinite(receivedAt) ? receivedAt : Date.now();
    this.textBuffer += this.decoder.write(buffer);
    return this._drain(false);
  }

  flush(receivedAt = this.lastReceivedAt || Date.now()) {
    if (this.disposed) return [];
    this.lastReceivedAt = Number.isFinite(receivedAt) ? receivedAt : Date.now();
    this.textBuffer += this.decoder.end();
    const records = this._drain(true);
    this.decoder = iconv.getDecoder(this.encoding);
    return records;
  }

  reset() {
    this.decoder = iconv.getDecoder(this.encoding);
    this.textBuffer = '';
    this.lastReceivedAt = 0;
    this.disposed = false;
  }

  dispose() {
    this.textBuffer = '';
    this.disposed = true;
  }

  _emit(text, delimiter, partial, records) {
    const record = {
      text,
      delimiter,
      partial,
      receivedAt: this.lastReceivedAt || Date.now(),
      sequence: ++this.sequence
    };
    records.push(record);
    this.onRecord?.(record);
  }

  _drain(flushing) {
    const records = [];
    while (this.textBuffer.length) {
      let delimiterIndex = -1;
      for (let index = 0; index < this.textBuffer.length; index++) {
        const character = this.textBuffer[index];
        if (character === '\n' || character === '\r') {
          delimiterIndex = index;
          break;
        }
      }

      if (delimiterIndex < 0) {
        if (this.textBuffer.length > this.maxLineLength) {
          this._emit(this.textBuffer.slice(0, this.maxLineLength), '', true, records);
          this.textBuffer = this.textBuffer.slice(this.maxLineLength);
          continue;
        }
        if (flushing) {
          this._emit(this.textBuffer, '', false, records);
          this.textBuffer = '';
        }
        break;
      }

      const character = this.textBuffer[delimiterIndex];
      if (character === '\r' && delimiterIndex === this.textBuffer.length - 1 && !flushing) break;
      const delimiterLength = character === '\r' && this.textBuffer[delimiterIndex + 1] === '\n' ? 2 : 1;
      const delimiter = this.textBuffer.slice(delimiterIndex, delimiterIndex + delimiterLength);
      this._emit(this.textBuffer.slice(0, delimiterIndex), delimiter, false, records);
      this.textBuffer = this.textBuffer.slice(delimiterIndex + delimiterLength);
    }
    return records;
  }
}

module.exports = { SerialTextStream, SUPPORTED_ENCODINGS };
