'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { SerialPortClaimTable, normalizePortKey } = require('../serial-port-claims');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

function createFixture(config = {}) {
  const files = new Map();
  const handles = {};
  const listeners = {};
  const ports = [];
  const events = [];
  let failedFolder = '';
  let today = '2026-11-13';
  let deferOpen = false;
  class FakePort extends EventEmitter {
    constructor(options) { super(); this.path = options.path; this.isOpen = false; ports.push(this); }
    open(callback) {
      this.finishOpen = error => { this.isOpen = !error; callback(error); };
      if (!deferOpen) queueMicrotask(() => this.finishOpen(null));
    }
    close(callback) { this.isOpen = false; this.emit('close'); callback?.(); }
    write(bytes, callback) { callback(null); }
    static list() { return []; }
  }
  const context = vm.createContext({
    Buffer, Uint8Array, Map, Set, Date, Number, String, console, path,
    fs: {
      existsSync: name => files.has(name), mkdirSync: () => {},
      appendFileSync: (name, bytes) => {
        if (failedFolder && name.includes(failedFolder)) throw new Error('disk unavailable');
        files.set(name, Buffer.concat([files.get(name) || Buffer.alloc(0), Buffer.from(bytes)]));
      },
      writeFileSync: (name, text) => files.set(name, Buffer.from(text))
    },
    currentConfig: {
      logEnabled: true, saveAllTabsLogToFiles: false, saveRawSerialToFile: true,
      saveShellTabsLogToFiles: false, logCreateDateFolder: false, logPath: '/logs',
      rawBufferAutoFlushMB: 10, rawLogFileNameFormat: 'raw.bin', logFileNameFormat: 'log.txt', logEncoding: 'utf8', ...config
    },
    iconv: { encode: text => Buffer.from(text) }, log: { error: () => {} },
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } },
    formatLocalDate: () => today,
    getLogDirectory: (base, dated) => dated ? path.join(base, today) : base,
    // 注入真实实现而不是桩：端口目录名（含 port_ 前缀）是本次修复的核心，
    // 用桩会让测试失去对目录结构的校验能力。名字必须与 main.js 中的别名一致。
    buildPortFolderName: require('../log-directory').buildPortLogFolderName,
    SerialPort: FakePort, SerialPortClaimTable, normalizePortKey,
    ipcMain: { handle: (name, fn) => handles[name] = fn, on: (name, fn) => listeners[name] = fn },
    setInterval: () => 1, clearInterval: () => {}, setImmediate: () => {},
    SERIAL_ENCODINGS: new Set(['utf8', 'ascii', 'gbk']), oneOf: (value, values, fallback) => values.has(value) ? value : fallback,
    buildSerialWriteBuffer: () => ({ ok: true, bytes: Buffer.from('x') }),
    normalizeConfig: value => value, configPath: '/profile/config.json', telemetryReporter: null,
    startLogCleanupTimer: () => {}
  });
  const run = code => vm.runInContext(code, context);
  run(section('const SERIAL_LOG_FOLDER_SHELL', 'async function runLogCleanup'));
  run(section('const serialSessions = new Map()', "    ipcMain.on('renderer-log'"));
  run(section('function saveConfig(config)', 'function persistTelemetryState'));
  return {
    files, ports, handles, listeners, events, run, context,
    fail: folder => { failedFolder = folder; }, date: value => { today = value; },
    deferOpen: value => { deferOpen = value; },
    connect: (groupId, port) => handles['connect-serial']({}, { groupId, path: port, baudRate: '9600' }),
    text: folder => [...files].filter(([name]) => name.includes(folder)).map(([, value]) => value.toString()).join('')
  };
}

module.exports = { createFixture };
