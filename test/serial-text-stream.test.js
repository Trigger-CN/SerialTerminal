'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const { SerialTextStream } = require('../serial-text-stream');

test('frames CRLF, LF and CR without a split CRLF artifact', () => {
  const stream = new SerialTextStream();
  const first = stream.write(Buffer.from('one\r'), 10);
  assert.deepEqual(first, []);
  const records = stream.write(Buffer.from('\ntwo\nthree\rfour'), 20);
  assert.deepEqual(records.map(record => [record.text, record.delimiter]), [['one', '\r\n'], ['two', '\n'], ['three', '\r']]);
  assert.equal(stream.flush()[0].text, 'four');
});

test('decodes multibyte UTF-8 and GBK characters across chunks', () => {
  for (const encoding of ['utf8', 'gbk']) {
    const bytes = iconv.encode('temperature=25\n', encoding);
    const stream = new SerialTextStream({ encoding });
    const records = [...stream.write(bytes.subarray(0, 3)), ...stream.write(bytes.subarray(3))];
    assert.equal(records[0].text, 'temperature=25');
  }
});

test('bounds unterminated lines and marks forced records partial', () => {
  const stream = new SerialTextStream({ maxLineLength: 256 });
  const records = stream.write(Buffer.from('x'.repeat(300)));
  assert.equal(records.length, 1);
  assert.equal(records[0].text.length, 256);
  assert.equal(records[0].partial, true);
  assert.equal(stream.flush()[0].text.length, 44);
});
