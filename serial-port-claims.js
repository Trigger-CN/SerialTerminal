'use strict';

// 串口占用表：同一个物理端口同一时刻只允许一个串口分组占用。
//
// 为什么需要这一层：Windows 上重复打开同一 COM 口通常会被驱动拒绝（Access
// denied），但那是**驱动行为**而不是应用保证。部分虚拟串口驱动、USB 复合设备、
// 或者带共享模式的驱动确实允许第二次打开，此时应用里两个分组会各拿到一个
// 句柄，谁也不报错，于是同一份字节流被两边同时消费、日志写两份——这类问题不会
// 抛异常，只会让数据显示错乱，事后极难定位。
//
// 这一层只做「谁占了哪个端口」的判定，不碰 SerialPort、DOM 或 IPC，因此可以在
// Node 里直接断言。

function normalizePortPath(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Windows 端口名大小写不敏感（随 `Mode COM1:` 等写法），
// 因此占用表按统一大写比较，避免 "com6" 与 "COM6" 被当成两个端口。
function normalizePortKey(value) {
  return normalizePortPath(value).toUpperCase();
}

class SerialPortClaimTable {
  constructor() {
    // 端口键 -> 占用它的 groupId
    this.claims = new Map();
  }

  // 申请占用。同一个分组重复申请同一个端口是允许的（重连），
  // 换成别的端口时会先释放它自己原来的占用。
  claim(groupId, portPath) {
    const key = normalizePortKey(portPath);
    if (!key) return { ok: false, reason: 'empty-port', portKey: '' };
    const owner = this.claims.get(key);
    if (owner && owner !== groupId) {
      return { ok: false, reason: 'port-in-use', portKey: key, ownerGroupId: owner };
    }
    this.releaseGroup(groupId);
    this.claims.set(key, groupId);
    return { ok: true, reason: 'claimed', portKey: key, ownerGroupId: groupId };
  }

  // 释放某个分组的占用。返回被释放的端口键（没有占用时为 null）。
  releaseGroup(groupId) {
    for (const [key, owner] of this.claims) {
      if (owner === groupId) {
        this.claims.delete(key);
        return key;
      }
    }
    return null;
  }

  // 归还「某分组占用的某个具体端口」。只有键与所有者同时匹配才释放，
  // 避免一个迟到的断开事件把该分组已经换到的新端口释放掉。
  releasePort(groupId, portPath) {
    const key = normalizePortKey(portPath);
    if (!key) return false;
    if (this.claims.get(key) !== groupId) return false;
    this.claims.delete(key);
    return true;
  }

  ownerOf(portPath) {
    const key = normalizePortKey(portPath);
    return key ? (this.claims.get(key) || null) : null;
  }

  isClaimedByOther(groupId, portPath) {
    const owner = this.ownerOf(portPath);
    return Boolean(owner) && owner !== groupId;
  }

  size() {
    return this.claims.size;
  }

  clear() {
    this.claims.clear();
  }
}

module.exports = {
  SerialPortClaimTable,
  normalizePortPath,
  normalizePortKey
};
