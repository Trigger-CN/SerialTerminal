'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHexInput, buildSerialWriteBuffer } = require('../serial-codec');

test('parses supported Hex formats into identical bytes', () => {
  for (const input of ['AA5501FF', 'AA 55 01 FF', '0xAA,0x55,0x01,0xFF', 'aa:55-01-ff']) {
    const result = parseHexInput(input);
    assert.equal(result.ok, true, input);
    assert.deepEqual([...result.bytes], [0xaa, 0x55, 0x01, 0xff]);
  }
});

test('rejects invalid and oversized Hex input', () => {
  assert.equal(parseHexInput('ABC').code, 'ODD_HEX_DIGITS');
  assert.equal(parseHexInput('0xA').code, 'INVALID_HEX_TOKEN');
  assert.equal(parseHexInput('GG').code, 'INVALID_HEX_CHAR');

  const oversized = parseHexInput('AA BB', { maxBytes: 1 });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, 'PAYLOAD_TOO_LARGE');
});

test('encodes UTF-8 and GBK text without a second conversion', () => {
  const utf8 = buildSerialWriteBuffer({ mode: 'text', content: '中文', encoding: 'utf8' });
  assert.equal(utf8.ok, true);
  assert.equal(utf8.bytes.toString('hex'), 'e4b8ade69687');

  const gbk = buildSerialWriteBuffer({ mode: 'text', content: '中文', encoding: 'gbk' });
  assert.equal(gbk.ok, true);
  assert.equal(gbk.bytes.toString('hex'), 'd6d0cec4');
});

test('rejects characters unavailable in the selected encoding', () => {
  const ascii = buildSerialWriteBuffer({ mode: 'text', content: '中文', encoding: 'ascii' });
  assert.equal(ascii.ok, false);
  assert.equal(ascii.code, 'UNREPRESENTABLE_CHARACTER');

  const gbk = buildSerialWriteBuffer({ mode: 'text', content: '😀', encoding: 'gbk' });
  assert.equal(gbk.ok, false);
  assert.equal(gbk.code, 'UNREPRESENTABLE_CHARACTER');
});

test('applies terminal newline and explicit CRLF append semantics', () => {
  const enter = buildSerialWriteBuffer({
    mode: 'text',
    content: '\r',
    encoding: 'utf8',
    terminalEnter: true,
    newlineMode: 'lf'
  });
  assert.equal(enter.bytes.toString('hex'), '0a');

  const appended = buildSerialWriteBuffer({
    mode: 'hex',
    content: 'AA',
    appendCrLf: true
  });
  assert.equal(appended.bytes.toString('hex'), 'aa0d0a');
});
