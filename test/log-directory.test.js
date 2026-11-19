'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  formatLocalDate,
  getLogDirectory,
  buildPortLogFolderName,
  RESERVED_DEVICE_NAME,
  PORT_FOLDER_PREFIX
} = require('../log-directory');

test('formats local dates and optionally creates a dated log path', () => {
  const date = new Date(2026, 7, 14, 23, 59, 59);

  assert.equal(formatLocalDate(date), '2026-08-14');
  assert.equal(getLogDirectory('D:\\logs', false, date), 'D:\\logs');
  assert.equal(getLogDirectory('D:\\logs', true, date), path.join('D:\\logs', '2026-08-14'));
});

test('port log folders never collide with DOS reserved device names', () => {
  // 真实缺陷：企业加密/DLP 驱动（天锐绿盾 TFsdframe / TsdEncrypt）会给
  // COM1-COM9 这类保留设备名的目录写入 Low Mandatory Level 与全显式 ACE，
  // 导致资源管理器报“无权访问”，且 takeown / icacls 从驱动层被拒绝。
  // 实测 COM6 / COM8 必现，COM11 不受影响（两位数字不匹配保留名）。
  const reserved = ['COM1', 'COM6', 'COM8', 'COM9', 'COM0', 'LPT1', 'LPT9', 'CON', 'PRN', 'AUX', 'NUL'];

  for (const name of reserved) {
    const folder = buildPortLogFolderName(name);
    assert.ok(RESERVED_DEVICE_NAME.test(name), `${name} 应被视为保留设备名`);
    assert.equal(
      RESERVED_DEVICE_NAME.test(folder),
      false,
      `${name} 生成的目录名 ${folder} 不得再次命中保留设备名`
    );
    assert.equal(folder, `port_${name}`);
  }
});

test('port log folders keep the port name recognizable', () => {
  assert.equal(PORT_FOLDER_PREFIX, 'port_');
  assert.equal(buildPortLogFolderName('COM6'), 'port_COM6');
  assert.equal(buildPortLogFolderName('COM11'), 'port_COM11');
  assert.equal(buildPortLogFolderName('  COM3  '), 'port_COM3');
  // 端口名的大小写原样保留，便于用户对照设备管理器。
  assert.equal(buildPortLogFolderName('com6'), 'port_com6');
});

test('port log folder names are safe for both Windows and POSIX paths', () => {
  // Linux 的 /dev/ttyUSB0 直接当目录名会带斜杠，必须取 basename。
  assert.equal(buildPortLogFolderName('/dev/ttyUSB0'), 'port_ttyUSB0');
  assert.equal(buildPortLogFolderName('/dev/serial/by-id/usb-abc'), 'port_usb-abc');
  assert.equal(buildPortLogFolderName('\\\\.\\COM6'), 'port_COM6');

  // Windows 非法字符替换为下划线，不得出现在结果里。
  const weird = buildPortLogFolderName('COM:6?*"<>|');
  assert.match(weird, /^port_/);
  assert.doesNotMatch(weird, /[\\/:*?"<>|]/);
});

test('port log folder name strips trailing dots and spaces', () => {
  // Windows 会静默剥离尾部点和空格，若不清除会导致目录名与预期不一致。
  assert.equal(buildPortLogFolderName('COM6.'), 'port_COM6');
  assert.equal(buildPortLogFolderName('COM6  '), 'port_COM6');
  assert.equal(buildPortLogFolderName('COM6. . '), 'port_COM6');
});

test('empty port path returns empty string so callers can fall back to group id', () => {
  // 空值由调用方（main.js 的 buildPortLogFolderName）回退到 groupId，
  // 这里只负责返回空串，不自行编造目录名。
  assert.equal(buildPortLogFolderName(''), '');
  assert.equal(buildPortLogFolderName(null), '');
  assert.equal(buildPortLogFolderName(undefined), '');
  assert.equal(buildPortLogFolderName('   '), '');
  assert.equal(buildPortLogFolderName('.'), '');
});
