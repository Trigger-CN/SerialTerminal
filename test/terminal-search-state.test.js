'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTerminalRevisionTracker,
  findAnchoredMatchIndex,
  resolveNavigationIndex
} = require('../terminal-search-state');

function createEvent() {
  const listeners = new Set();
  return {
    event(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire(value) {
      listeners.forEach(listener => listener(value));
    },
    get size() {
      return listeners.size;
    }
  };
}

function createTerminalStub() {
  const write = createEvent();
  const resize = createEvent();
  const buffer = createEvent();
  return {
    term: {
      onWriteParsed: write.event,
      onResize: resize.event,
      buffer: { onBufferChange: buffer.event }
    },
    write,
    resize,
    buffer
  };
}

test('terminal revision tracks parsed writes, resize, buffer changes, and explicit invalidation', () => {
  const stub = createTerminalStub();
  const reasons = [];
  const tracker = createTerminalRevisionTracker(stub.term, (_term, revision, reason) => {
    reasons.push([revision, reason]);
  });

  stub.write.fire();
  stub.resize.fire();
  stub.buffer.fire();
  tracker.invalidate('clear');

  assert.equal(tracker.revision, 4);
  assert.deepEqual(reasons, [[1, 'write'], [2, 'resize'], [3, 'buffer'], [4, 'clear']]);
});

test('disposing a terminal revision tracker removes every listener', () => {
  const stub = createTerminalStub();
  const tracker = createTerminalRevisionTracker(stub.term);

  tracker.dispose();
  stub.write.fire();
  stub.resize.fire();
  stub.buffer.fire();
  tracker.invalidate();

  assert.equal(tracker.revision, 0);
  assert.equal(stub.write.size, 0);
  assert.equal(stub.resize.size, 0);
  assert.equal(stub.buffer.size, 0);
});

test('an updated marker position re-anchors the same result after earlier matches are evicted', () => {
  const matches = [
    { line: 2, column: 4, length: 5 },
    { line: 8, column: 1, length: 5 }
  ];

  assert.equal(findAnchoredMatchIndex(matches, { line: 8, column: 1, length: 5 }), 1);
  assert.equal(findAnchoredMatchIndex(matches, { line: -1, column: 1, length: 5 }), -1);
});

test('anchor matching uses the column and length to distinguish results on the same line', () => {
  const matches = [
    { line: 3, column: 1, length: 4 },
    { line: 3, column: 8, length: 4 }
  ];

  assert.equal(findAnchoredMatchIndex(matches, { line: 3, column: 8, length: 4 }), 1);
  assert.equal(findAnchoredMatchIndex(matches, { line: 3, column: 8, length: 5 }), -1);
});

test('search navigation starts at the appropriate edge and wraps', () => {
  assert.equal(resolveNavigationIndex('next', 0, 3), 1);
  assert.equal(resolveNavigationIndex('next', 3, 3), 1);
  assert.equal(resolveNavigationIndex('previous', 0, 3), 3);
  assert.equal(resolveNavigationIndex('previous', 1, 3), 3);
  assert.equal(resolveNavigationIndex('next', 1, 0), 0);
});
