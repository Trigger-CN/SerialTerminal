'use strict';

// 渲染层多串口分组注册表（P2 基础设施）。
//
// 这一层只负责「哪个分组当前是激活的」「某个 sessionId 属于哪个分组」这类可判定的
// 路由问题，不持有 Terminal / parser / formatter 等 DOM 相关对象。把这些判断从
// renderer.js 里剥出来，是为了让「字节是否应当被本分组消费」这件事可以被单元测试
// 直接验证——这是多串口下最危险的一类错误（数据显示到错误的分组），一旦写错，
// 只有靠肉眼盯着两个终端才能发现。
//
// 术语：
//   groupId   — 串口分组标识，单串口模式固定为 'default'
//   sessionId — 每次连接由主进程分配的会话号，断开/重连都会变

const DEFAULT_SERIAL_GROUP_ID = 'default';

function normalizeGroupId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id || DEFAULT_SERIAL_GROUP_ID;
}

class SerialGroupRegistry {
  constructor({ defaultGroupId = DEFAULT_SERIAL_GROUP_ID } = {}) {
    this.defaultGroupId = normalizeGroupId(defaultGroupId);
    // groupId -> { groupId, sessionId, connected, portPath }
    this.groups = new Map();
    // 最近一次被创建的 sessionId -> groupId；用于把迟到的 IPC 消息归位
    this.sessionToGroup = new Map();
    this.activeGroupId = this.defaultGroupId;
    this.ensureGroup(this.defaultGroupId);
  }

  ensureGroup(groupId, { portPath = '' } = {}) {
    const id = normalizeGroupId(groupId);
    let group = this.groups.get(id);
    if (!group) {
      group = { groupId: id, sessionId: 0, connected: false, portPath: '' };
      this.groups.set(id, group);
    }
    if (portPath) group.portPath = String(portPath);
    return group;
  }

  getGroup(groupId) {
    return this.groups.get(normalizeGroupId(groupId)) || null;
  }

  listGroupIds() {
    return Array.from(this.groups.keys());
  }

  // 单串口模式下永远只有一个分组；多分组时由 UI 切换。
  setActiveGroup(groupId) {
    const id = normalizeGroupId(groupId);
    this.ensureGroup(id);
    this.activeGroupId = id;
    return this.activeGroupId;
  }

  // 连接成功后登记新的会话号。会话号必须单调更新：断开时 renderer 会自增本地的
  // sessionId 来作废迟到的数据，主进程分配的号也走这里。
  beginSession(groupId, sessionId) {
    const id = normalizeGroupId(groupId);
    const group = this.ensureGroup(id);
    const next = Number.isInteger(sessionId) ? sessionId : group.sessionId + 1;
    group.sessionId = next;
    group.connected = true;
    this.sessionToGroup.set(next, id);
    return next;
  }

  // 只递增本地计数，用于「断开后不应再接收旧会话数据」。
  invalidateSession(groupId) {
    const id = normalizeGroupId(groupId);
    const group = this.ensureGroup(id);
    group.sessionId += 1;
    group.connected = false;
    return group.sessionId;
  }

  // 某个 sessionId 属于哪个分组；未知时返回 null（不能假设是激活分组）。
  groupIdForSession(sessionId) {
    if (!Number.isInteger(sessionId)) return null;
    return this.sessionToGroup.get(sessionId) || null;
  }

  // 判断一条入站消息是否应当被渲染层消费。
  //   - 带 sessionId：只接受本分组当前会话的数据
  //   - 不带 sessionId：退化为按 groupId 判定（兼容旧主进程）
  // 返回 { accepted, reason, groupId }，reason 便于日志与测试断言。
  accepts({ groupId, sessionId } = {}) {
    const id = normalizeGroupId(groupId);
    const group = this.groups.get(id);
    if (!group) return { accepted: false, reason: 'unknown-group', groupId: id };

    if (Number.isInteger(sessionId)) {
      const owner = this.sessionToGroup.get(sessionId);
      if (owner && owner !== id) return { accepted: false, reason: 'session-other-group', groupId: id };
      if (sessionId !== group.sessionId) return { accepted: false, reason: 'stale-session', groupId: id };
    }
    return { accepted: true, reason: 'ok', groupId: id };
  }

  // 该分组的字节是否应该显示在当前界面上。首版只有「激活分组」显示。
  isVisible(groupId) {
    return normalizeGroupId(groupId) === this.activeGroupId;
  }

  removeGroup(groupId) {
    const id = normalizeGroupId(groupId);
    if (id === this.defaultGroupId) return false;
    const group = this.groups.get(id);
    if (!group) return false;
    this.sessionToGroup.delete(group.sessionId);
    this.groups.delete(id);
    if (this.activeGroupId === id) this.activeGroupId = this.defaultGroupId;
    return true;
  }
}

module.exports = { SerialGroupRegistry, normalizeGroupId, DEFAULT_SERIAL_GROUP_ID };
