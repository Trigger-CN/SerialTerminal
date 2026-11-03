'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialDataParser, MAX_UNTERMINATED_LINE } = require('../serial-data-parser');

test('splits a chunk into lines and keeps the trailing partial line', () => {
  const parser = new SerialDataParser();

  const lines = parser.parse('a\r\nb\nc');

  assert.deepEqual(lines.map(l => l.text), ['a', 'b']);
  assert.deepEqual(lines.map(l => l.delimiter), ['\r\n', '\n']);
  // 末尾的 'c' 没有分隔符，留在缓冲里等下一个 chunk。
  assert.equal(parser.incomingBuffer, 'c');
});

test('joins a line that arrives split across chunks', () => {
  const parser = new SerialDataParser();

  assert.deepEqual(parser.parse('hel'), []);
  const lines = parser.parse('lo\r\n');

  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'hello');
});

test('handles CR-only and CRLF delimiters distinctly', () => {
  const parser = new SerialDataParser();

  const lines = parser.parse('a\rb\r\nc\n');

  assert.deepEqual(lines.map(l => l.delimiter), ['\r', '\r\n', '\n']);
  assert.deepEqual(lines.map(l => l.text), ['a', 'b', 'c']);
});

test('prefix is taken only at the start of a line', () => {
  const parser = new SerialDataParser({ prefixProvider: () => '[P]' });

  const lines = parser.parse('a\r\nb\r\n');

  assert.deepEqual(lines.map(l => l.prefix), ['[P]', '[P]']);
});

test('a line continued across chunks does not get a second prefix', () => {
  const parser = new SerialDataParser({ prefixProvider: () => '[P]' });

  // 先发一超长行迫使解析器提前吐出一行（此时标记为续行状态）。
  const head = parser.parse('x'.repeat(MAX_UNTERMINATED_LINE + 1));
  assert.equal(head.length, 1);
  assert.equal(head[0].prefix, '[P]');

  // 后续数据属于同一逻辑行的续行：不得再加前缀。
  const tail = parser.parse('continued\r\n');
  assert.equal(tail.length, 1);
  assert.equal(tail[0].prefix, '');
  assert.equal(tail[0].text, 'continued');
});

test('flush emits the buffered tail exactly once', () => {
  const parser = new SerialDataParser({ prefixProvider: () => '[P]' });

  parser.parse('tail');
  const flushed = parser.flush();

  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].text, 'tail');
  assert.equal(flushed[0].prefix, '[P]');
  // 再 flush 不应重复输出。
  assert.deepEqual(parser.flush(), []);
});

test('an oversized unterminated line is emitted without waiting for a delimiter', () => {
  const parser = new SerialDataParser({ prefixProvider: () => '[P]' });
  const huge = 'x'.repeat(MAX_UNTERMINATED_LINE + 1);

  const lines = parser.parse(huge);

  assert.equal(lines.length, 1);
  assert.equal(lines[0].delimiter, '');
  assert.equal(lines[0].prefix, '[P]');
  // 超长行吐出后，紧随其后的数据视为续行，不再加前缀。
  assert.deepEqual(parser.parse('more'), []);
});

test('two parser instances keep independent buffers and prefix state', () => {
  // 这是本次抽取的核心动机：两个端口各自的 parser 不得互相污染。
  let a = 0;
  let b = 0;
  const parserA = new SerialDataParser({ groupId: 'a', prefixProvider: () => `A${++a}` });
  const parserB = new SerialDataParser({ groupId: 'b', prefixProvider: () => `B${++b}` });

  const linesA = parserA.parse('a1\r\n');
  const linesB = parserB.parse('b1\r\nb2\r\n');

  assert.deepEqual(linesA.map(l => l.prefix), ['A1']);
  assert.deepEqual(linesB.map(l => l.prefix), ['B1', 'B2']);
  assert.equal(parserA.incomingBuffer, '');
  assert.equal(parserB.incomingBuffer, '');
});

test('reset clears buffered data and newline state', () => {
  const parser = new SerialDataParser({ prefixProvider: () => '[P]' });

  parser.parse('dangling');
  parser.reset();

  assert.equal(parser.incomingBuffer, '');
  const lines = parser.parse('fresh\r\n');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'fresh');
  assert.equal(lines[0].prefix, '[P]');
});

test('empty input is a no-op', () => {
  const parser = new SerialDataParser();
  assert.deepEqual(parser.parse(''), []);
  assert.deepEqual(parser.parse(null), []);
});
