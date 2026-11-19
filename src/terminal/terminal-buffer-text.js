'use strict';

function serializeTerminalBuffer(buffer) {
  if (!buffer) return '';

  const logicalLines = [];
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;

    const nextLine = index + 1 < buffer.length ? buffer.getLine(index + 1) : null;
    const text = line.translateToString(nextLine?.isWrapped !== true);
    if (line.isWrapped && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += text;
    } else {
      logicalLines.push(text);
    }
  }

  return logicalLines.join('\n').replace(/\s+$/g, '');
}

module.exports = { serializeTerminalBuffer };
