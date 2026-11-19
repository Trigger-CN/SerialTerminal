'use strict';

const path = require('node:path');

function formatLocalDate(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function getLogDirectory(basePath, createDateFolder, date = new Date()) {
  return createDateFolder ? path.join(basePath, formatLocalDate(date)) : basePath;
}

// DOS 保留设备名（不区分大小写）：COM0-COM9 / LPT0-LPT9 / CON / PRN / AUX / NUL。
// 这些名字不能安全地用作 Windows 目录名。
const RESERVED_DEVICE_NAME = /^(?:COM[0-9]|LPT[0-9]|CON|PRN|AUX|NUL)$/i;

const PORT_FOLDER_PREFIX = 'port_';

// 端口路径里可能出现的路径分隔符：Windows 的 \ 与 POSIX 的 /。
// 不用 path.basename()：它按运行平台决定是否把 \ 当分隔符，
// 导致同一输入在 Windows（'\\.\COM6' -> 'COM6'）与 Linux（整串保留）
// 得到不同目录名，日志目录结构随平台漂移。
const PATH_SEPARATOR = /[\\/]/;

/**
 * 把端口路径转成日志目录名。
 *
 * 统一加前缀而不是只给保留名打补丁：COM1-COM9 是企业加密/DLP 驱动
 * （实测天锐绿盾 TFsdframe / TsdEncrypt）的重点管控对象，同名目录会被改写成
 * Low Mandatory Level + 全显式 ACE，导致资源管理器报“无权访问”，且 takeown /
 * icacls 从驱动层就被拒绝，用户无法自行修复。加前缀后不再命中保留名，
 * 规则也更好预测。
 *
 * @param {string} portPath 原始端口路径（Windows: COM6 或 \\.\COM6；Linux: /dev/ttyUSB0）
 * @returns {string} 目录名；端口路径为空时返回空串，由调用方决定回退值
 */
function buildPortLogFolderName(portPath) {
  const raw = String(portPath || '').trim();
  // 两种分隔符都切：Linux 的 /dev/ttyUSB0 与 Windows 的 \\.\COM6 都要取末段。
  const segments = raw.split(PATH_SEPARATOR);
  const base = segments[segments.length - 1] || '';
  const safe = base
    // 剩余非法字符（: * ? " < > |）替换为下划线；分隔符已在上面切掉。
    .replace(/[:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // 去尾部点和空格：Windows 会静默剥离它们，导致目录名与预期不一致。
    .replace(/[. ]+$/g, '');
  if (!safe) return '';
  return `${PORT_FOLDER_PREFIX}${safe}`;
}

module.exports = {
  formatLocalDate,
  getLogDirectory,
  buildPortLogFolderName,
  RESERVED_DEVICE_NAME,
  PORT_FOLDER_PREFIX
};
