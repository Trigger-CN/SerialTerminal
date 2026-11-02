'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatSentBody, formatSentRecord, escapeControlChars } = require('../sent-record');

test('control characters are escaped so they cannot drive the terminal', () => {
  assert.equal(escapeControlChars('AT+RST\r\n'), 'AT+RST\\r\\n');
  assert.equal(escapeControlChars('a\tb'), 'a\\tb');
  // 0x1b 是 ESC，必须转义成字面量，否则会被 xterm 当成转义序列执行。
  assert.equal(escapeControlChars('\x1b[31mred'), '\\x1b[31mred');
  assert.equal(escapeControlChars('\x00\x7f'), '\\x00\\x7f');
});

test('text mode composes timestamp, byte count and escaped payload', () => {
  const record = {
    timestamp: '10:00:01.500',
    mode: 'text',
    bytes: Buffer.from('AT+RST\r\n', 'utf8'),
    text: 'AT+RST\r\n'
  };
  const formatted = formatSentRecord(record);
  assert.equal(formatted.header, '[10:00:01.500] [TX 8B]');
  assert.equal(formatted.line, '[10:00:01.500] [TX 8B] AT+RST\\r\\n');
});

test('hex mode renders uppercase byte pairs', () => {
  const record = { timestamp: '10:00:02.000', mode: 'hex', bytes: Buffer.from([0x01, 0xab, 0x0f]) };
  const formatted = formatSentRecord(record);
  assert.equal(formatted.line, '[10:00:02.000] [TX 3B] 01 AB 0F');
});

test('both formats show text first for text sends and hex first for hex sends', () => {
  const textRecord = { timestamp: 't', mode: 'text', bytes: Buffer.from('Hi', 'utf8'), text: 'Hi' };
  assert.equal(formatSentBody(textRecord, { both: true }).line, 'Hi | 48 69');

  const hexRecord = { timestamp: 't', mode: 'hex', bytes: Buffer.from([0x48, 0x69]) };
  assert.equal(formatSentBody(hexRecord, { both: true }).line, '48 69 | Hi');
});

test('both formats are produced even when only one is displayed', () => {
  const record = { timestamp: 't', mode: 'text', bytes: Buffer.from([0x41]) };
  const body = formatSentBody(record, { both: false });
  assert.equal(body.line, 'A');
  assert.equal(body.hex, '41');
  assert.equal(body.text, 'A');
});

test('long payloads are truncated with an ellipsis instead of flooding the terminal', () => {
  const longText = 'x'.repeat(2000);
  const record = { timestamp: 't', mode: 'text', bytes: Buffer.from(longText), text: longText };
  const body = formatSentBody(record, { maxChars: 32 });
  assert.equal(body.text.length, 33);
  assert.ok(body.text.endsWith('…'));
});

test('custom label replaces TX in the header', () => {
  const record = { timestamp: 't', mode: 'text', bytes: Buffer.from('A') };
  assert.equal(formatSentRecord(record, { label: '发送' }).header, '[t] [发送 1B]');
});

test('missing timestamp falls back to a bare direction header', () => {
  const record = { mode: 'text', bytes: Buffer.from('A'), text: 'A' };
  assert.equal(formatSentRecord(record).line, '[TX 1B] A');
});

test('appended CRLF is visible in the echo and consistent with the byte count', () => {
  // 开启“追加 CRLF”时实际写入的是 content + CRLF，两者必须同时体现在回显与字节数上。
  const payload = 'AT+RST';
  const withCrlf = Buffer.from(`${payload}\r\n`, 'utf8');
  const record = { timestamp: 't', mode: 'text', bytes: withCrlf, text: `${payload}\r\n` };
  const formatted = formatSentRecord(record);
  assert.equal(formatted.header, '[t] [TX 8B]');
  assert.equal(formatted.text, 'AT+RST\\r\\n');
  assert.equal(formatted.line, '[t] [TX 8B] AT+RST\\r\\n');
  // 字节数与转义后的可见字符应自洽：8 字节 = 6 个可见字符 + CRLF。
  assert.equal(Buffer.byteLength(`${payload}\r\n`, 'utf8'), 8);
});
