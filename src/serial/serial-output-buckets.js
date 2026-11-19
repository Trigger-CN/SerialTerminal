'use strict';

// 渲染层串口输出分桶（P3 数据面路由的前置纯逻辑层）。
//
// 为什么必须有这一层：主进程已经按「会话 + sessionId」把字节分桶（main.js 的
// session.outputBuckets），但渲染层此前只有**一个** serialOutputQueue。任意两个分组的
// 字节都会在 Buffer.concat 时被拼成同一批，然后无条件写进唯一的 serialTerm 与唯一的
// 日志文件。这种串流不会抛错、不会留日志，只会让两个端口的输出混在一起——属于最难
// 事后定位的一类缺陷，也是 P1 在主进程侧花最大力气消除的形态。
//
// 本模块只做三件事：按 groupId 收字节、按 groupId 取走、按 groupId 统计水位。
// 它不认识 Terminal / xterm / DOM / ipcRenderer，因此可以在 Node 里直接断言，
// 不必启动 Electron。
//
// 一条不可动摇的语义：**drain() 返回的每一项只包含同一个 groupId 的字节**。
// 任何「先全部 concat 再统一分发」的写法都会让这条保证失效。

const { normalizeGroupId, DEFAULT_SERIAL_GROUP_ID } = require('./serial-group-registry');

const DEFAULT_HIGH_WATER_BYTES = 1024 * 1024;

function normalizeHighWater(value) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_HIGH_WATER_BYTES;
}

// 入站字节在渲染层有三种来源：主进程 IPC 传来的 Buffer 视图、Uint8Array、普通数组。
// 统一成 Buffer 视图（零拷贝，不复制主进程已经拷过一次的数据）。
function toChunk(bytes) {
  if (bytes instanceof Uint8Array) {
    if (Buffer.isBuffer(bytes)) return bytes;
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (Array.isArray(bytes)) return Buffer.from(bytes);
  return null;
}

class SerialOutputBuckets {
  constructor({ highWaterBytes = DEFAULT_HIGH_WATER_BYTES, defaultGroupId = DEFAULT_SERIAL_GROUP_ID } = {}) {
    this.defaultGroupId = normalizeGroupId(defaultGroupId);
    this.highWaterBytes = normalizeHighWater(highWaterBytes);
    // groupId -> { groupId, chunks: Buffer[], byteLength: number }
    // Map 的插入顺序即「该分组第一次入队的顺序」，drain() 沿用这个顺序，
    // 让单分组与多分组下的分发次序都是确定的、可复现的。
    this.buckets = new Map();
  }

  // 入队一段字节。返回本分组当前累计待写字节数，以及是否应立刻 flush。
  // shouldFlush 只看**本分组**的水位：一个分组淹没自己的缓冲，不应该连带打断另一个
  // 分组正在正常收数据的节奏。
  push(groupId, bytes) {
    const id = normalizeGroupId(groupId);
    const chunk = toChunk(bytes);
    if (!chunk || chunk.length === 0) {
      return { groupId: id, queuedBytes: this.pendingBytes(id), shouldFlush: false };
    }
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = { groupId: id, chunks: [], byteLength: 0 };
      this.buckets.set(id, bucket);
    }
    bucket.chunks.push(chunk);
    bucket.byteLength += chunk.length;
    return {
      groupId: id,
      queuedBytes: bucket.byteLength,
      shouldFlush: bucket.byteLength >= this.highWaterBytes
    };
  }

  // 取走全部分组的待写字节。每一项严格只含一个分组的字节。
  // 返回 [{ groupId, buffer, byteLength }]，按首次入队顺序排列；空分组不会出现。
  drain() {
    if (this.buckets.size === 0) return [];
    const batches = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.chunks.length === 0) continue;
      batches.push({
        groupId: bucket.groupId,
        buffer: Buffer.concat(bucket.chunks, bucket.byteLength),
        byteLength: bucket.byteLength
      });
    }
    this.buckets.clear();
    return batches;
  }

  // 只取走一个分组。用于「该分组已经断开」这类需要定向丢弃/冲刷的场景。
  drainGroup(groupId) {
    const id = normalizeGroupId(groupId);
    const bucket = this.buckets.get(id);
    if (!bucket || bucket.chunks.length === 0) return null;
    this.buckets.delete(id);
    return {
      groupId: id,
      buffer: Buffer.concat(bucket.chunks, bucket.byteLength),
      byteLength: bucket.byteLength
    };
  }

  pendingBytes(groupId) {
    const bucket = this.buckets.get(normalizeGroupId(groupId));
    return bucket ? bucket.byteLength : 0;
  }

  totalPendingBytes() {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.byteLength;
    return total;
  }

  pendingGroupIds() {
    return Array.from(this.buckets.keys());
  }

  hasPending() {
    for (const bucket of this.buckets.values()) {
      if (bucket.chunks.length > 0) return true;
    }
    return false;
  }

  // 丢弃某个分组的待写字节（分组被关闭时用）。默认分组也允许清空：
  // 「清空终端」本来就该把还没上屏的字节一起丢掉，否则清空后旧数据又冒出来。
  clear(groupId) {
    return this.buckets.delete(normalizeGroupId(groupId));
  }

  clearAll() {
    const count = this.buckets.size;
    this.buckets.clear();
    return count;
  }
}

module.exports = {
  SerialOutputBuckets,
  DEFAULT_HIGH_WATER_BYTES,
  normalizeHighWater
};
