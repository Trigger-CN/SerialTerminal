'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HexStreamFormatter, formatHexLine } = require('../hex-formatter');

test('formats offsets, bytes, and printable ASCII consistently', () => {
  const line = formatHexLine(16, Uint8Array.from([0x41, 0x00, 0x7e]), { bytesPerLine: 8 });
  assert.equal(line.hexText, '41 00 7E');
  assert.equal(line.asciiText, 'A.~');
  assert.equal(line.output, '00000010  41 00 7E                 |A.~|\r\n');
});

test('streams complete lines and flushes the remaining bytes', () => {
  const emitted = [];
  const formatter = new HexStreamFormatter({ bytesPerLine: 8, idleFlushMs: 1000 }, lines => emitted.push(...lines));
  const complete = formatter.push(Uint8Array.from({ length: 10 }, (_, index) => index));

  assert.equal(complete.length, 1);
  assert.equal(complete[0].offset, 0);
  assert.deepEqual(Array.from(complete[0].bytes), [0, 1, 2, 3, 4, 5, 6, 7]);
  const remainder = formatter.flush();
  assert.equal(remainder[0].offset, 8);
  assert.deepEqual(Array.from(remainder[0].bytes), [8, 9]);
  assert.equal(formatter.offset, 10);
  assert.equal(emitted.length, 2);
  formatter.dispose();
});

test('can clear pending bytes without resetting the running offset', () => {
  const formatter = new HexStreamFormatter({ bytesPerLine: 8, idleFlushMs: 1000 });
  formatter.push(Uint8Array.from({ length: 9 }, (_, index) => index));
  formatter.reset({ resetOffset: false });
  const lines = formatter.push(Uint8Array.from({ length: 8 }, (_, index) => index + 10));

  assert.equal(lines[0].offset, 8);
  formatter.dispose();
});
