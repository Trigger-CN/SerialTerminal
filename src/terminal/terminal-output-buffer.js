'use strict';

// 终端待写入缓冲的上限策略：以回滚行数为主预算，字节硬上限仅作为内存兜底。
// 丢弃时始终从最旧一端整行移除（在 '\n' 边界处切开），不会截断行中间内容。

function countTextLines(text) {
  if (!text) return 0;
  let lines = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) lines++;
  }
  return lines;
}

// 从最旧一端丢弃 count 行（含行尾换行符），返回实际丢弃的字节数。
function dropOldestLines(state, count) {
  let remaining = count;
  let dropped = 0;
  while (remaining > 0 && state.pending.length) {
    const head = state.pending[0];
    let cut = -1;
    let seen = 0;
    for (let index = 0; index < head.length; index++) {
      if (head.charCodeAt(index) === 10) {
        seen++;
        if (seen === remaining) {
          cut = index + 1;
          break;
        }
      }
    }
    if (cut >= 0) {
      state.pendingLength -= cut;
      state.pendingLines -= remaining;
      dropped += cut;
      const rest = head.slice(cut);
      if (rest) state.pending[0] = rest;
      else state.pending.shift();
      break;
    }
    state.pending.shift();
    state.pendingLength -= head.length;
    state.pendingLines -= seen;
    dropped += head.length;
    remaining -= seen;
  }
  return dropped;
}

// 追加一个块并按上限裁剪最旧内容，返回被丢弃的字节数（0 表示无丢弃）。
function appendPendingOutput(state, chunk, { maxLines, maxBytes } = {}) {
  if (!chunk) return 0;
  const lineLimit = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : Infinity;
  const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : Infinity;

  state.pending.push(chunk);
  state.pendingLength += chunk.length;
  state.pendingLines += countTextLines(chunk);

  let dropped = 0;
  const excessLines = state.pendingLines - lineLimit;
  if (excessLines > 0) dropped += dropOldestLines(state, excessLines);
  // 字节兜底同样整行丢弃，且至少保留最后一行，避免裁掉刚写入的最新内容。
  while (state.pendingLength > byteLimit && state.pendingLines > 1) {
    dropped += dropOldestLines(state, 1);
  }
  return dropped;
}

// 从最旧一端取出不超过 maxBytes 的一批，作为单次 term.write 的内容。
// 尽量在行边界切开，避免把一行文字拆到两次写入；剩余内容留在 state.pending。
function takePendingChunk(state, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : Infinity;
  if (!state.pending.length) return '';

  const head = state.pending[0];
  if (state.pending.length === 1 && head.length <= limit) {
    state.pending.shift();
    state.pendingLength -= head.length;
    state.pendingLines -= countTextLines(head);
    return head;
  }

  // 单个头部块就超过预算时，从行边界处切开（找不到行边界再按字节切）。
  if (head.length > limit) {
    let cut = limit;
    while (cut > 0 && head.charCodeAt(cut - 1) !== 10) cut--;
    if (cut === 0) cut = limit;
    const taken = head.slice(0, cut);
    const rest = head.slice(cut);
    state.pendingLength -= taken.length;
    state.pendingLines -= countTextLines(taken);
    if (rest) state.pending[0] = rest;
    else state.pending.shift();
    return taken;
  }

  // 从最旧一端拼接多个整块直到达到预算。
  let taken = '';
  while (state.pending.length && taken.length + state.pending[0].length <= limit) {
    const chunk = state.pending.shift();
    taken += chunk;
  }
  state.pendingLength -= taken.length;
  state.pendingLines -= countTextLines(taken);
  if (!taken) {
    // 预算小于单个块长度，退化到行边界切开。
    const block = state.pending[0];
    let cut = Math.max(1, Math.min(limit, block.length));
    while (cut > 0 && block.charCodeAt(cut - 1) !== 10) cut--;
    if (cut === 0) cut = Math.max(1, Math.min(limit, block.length));
    const head = block.slice(0, cut);
    const rest = block.slice(cut);
    state.pendingLength -= head.length;
    state.pendingLines -= countTextLines(head);
    if (rest) state.pending[0] = rest;
    else state.pending.shift();
    return head;
  }
  return taken;
}

module.exports = { appendPendingOutput, countTextLines, dropOldestLines, takePendingChunk };
