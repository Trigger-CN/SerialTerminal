'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serializeTerminalBuffer } = require('../terminal-buffer-text');

function createBuffer(lines) {
  return {
    length: lines.length,
    getLine(index) {
      const line = lines[index];
      if (!line) return null;
      return {
        isWrapped: line.isWrapped === true,
        translateToString(trimRight) {
          return trimRight ? line.text.trimEnd() : line.text;
        }
      };
    }
  };
}

test('joins terminal soft wraps without adding line breaks', () => {
  const buffer = createBuffer([
    { text: '01234567' },
    { text: '89ABCDEF', isWrapped: true },
    { text: 'tail    ', isWrapped: true }
  ]);

  assert.equal(serializeTerminalBuffer(buffer), '0123456789ABCDEFtail');
});

test('preserves hard line breaks between logical terminal lines', () => {
  const buffer = createBuffer([
    { text: 'first   ' },
    { text: 'second  ' },
    { text: 'wrapped-' },
    { text: 'line    ', isWrapped: true },
    { text: 'last    ' }
  ]);

  assert.equal(serializeTerminalBuffer(buffer), 'first\nsecond\nwrapped-line\nlast');
});

test('keeps full-width spaces inside a wrapped logical line', () => {
  const buffer = createBuffer([
    { text: 'value   ' },
    { text: 'next    ', isWrapped: true }
  ]);

  assert.equal(serializeTerminalBuffer(buffer), 'value   next');
});
