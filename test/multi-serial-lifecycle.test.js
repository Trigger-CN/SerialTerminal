'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./main-serial-fixture');

function seed(f) { f.run("getOrCreateSerialSession('default','COM_A'); getOrCreateSerialSession('g-1','COM_B');"); }

test('ordinary and RAW buffers retain each source group', () => {
  const f = createFixture(); seed(f);
  f.run("writeTabLog('tab-main','A','A_TEXT','default'); writeTabLog('tab-main-g-1','B','B_TEXT','g-1'); bufferRawSerialBytes(Buffer.from('A_RAW'),'default'); bufferRawSerialBytes(Buffer.from('B_RAW'),'g-1'); flushPendingLogs();");
  assert.equal(f.text('COM_A'), 'A_RAWA_TEXT');
  assert.equal(f.text('COM_B'), 'B_RAWB_TEXT');
  assert.equal(f.run('getActiveLogFilePaths().length'), 4);
});

test('connecting another group cannot replace pending tab logs or paths', async () => {
  const f = createFixture({ saveAllTabsLogToFiles: true });
  await f.connect('default', 'COM_A');
  f.run("writeTabLog('tab-main','A','A_PENDING','default')");
  const entry = f.run("tabLogBuffers.get('tab-main')");
  const filePath = entry.filePath;
  await f.connect('g-1', 'COM_B');
  assert.equal(f.run("tabLogBuffers.get('tab-main')"), entry);
  assert.equal(entry.filePath, filePath);
  f.run("writeTabLog('tab-main-g-1','B','B_PENDING','g-1'); saveAllTabLogs({notify:false});");
  assert.equal(f.text('COM_A'), 'A_PENDING');
  assert.equal(f.text('COM_B'), 'B_PENDING');
});

test('failed streams retain their bytes and do not block another group', () => {
  const f = createFixture(); seed(f); f.fail('COM_A');
  f.run("writeLog('A','default'); writeLog('B','g-1'); bufferRawSerialBytes(Buffer.from('RA'),'default'); bufferRawSerialBytes(Buffer.from('RB'),'g-1'); flushPendingLogs();");
  assert.equal(f.text('COM_A'), ''); assert.equal(f.text('COM_B'), 'RBB');
  assert.equal(f.run("getGroupLogState('default').text.buffer.join('')"), 'A');
  f.fail(''); f.run('flushPendingLogs()');
  assert.equal(f.text('COM_A'), 'RAA'); assert.equal(f.text('COM_B'), 'RBB');
});

test('date rotation keeps pending failures on their original path', () => {
  const f = createFixture({ logCreateDateFolder: true }); seed(f);
  f.run("writeLog('OLD','default'); bufferRawSerialBytes(Buffer.from('RAW'),'default')");
  f.fail('COM_A'); f.date('2026-11-14');
  f.run("writeLog('NEXT','g-1')");
  f.fail(''); f.run('flushPendingLogs()');
  assert.equal([...f.files].filter(([p]) => p.includes('2026-11-13')).map(([,b]) => b.toString()).join(''), 'RAWOLD');
  assert.equal(f.text('COM_B'), 'NEXT');
});

test('settings changes cannot move failed pending logs to another destination', () => {
  const f = createFixture(); seed(f); f.run("writeLog('PENDING','default')"); f.fail('COM_A');
  assert.throws(() => f.run("saveConfig({logPath:'/new'})"), /Failed to flush/);
  assert.equal(f.context.currentConfig.logPath, '/logs');
  assert.throws(() => f.run('saveConfig({logEnabled:false})'), /Failed to flush/);
  assert.equal(f.context.currentConfig.logEnabled, true);
  f.fail(''); f.run('saveConfig({logEnabled:false})');
  assert.equal(f.text('COM_A'), 'PENDING');
  f.run("writeTabLog('tab-main','A','IGNORED','default'); flushPendingLogs()");
  assert.equal(f.text('COM_A'), 'PENDING');
});

test('Shell logging remains opt-in and closing its sessions does not close serial tabs', () => {
  const f = createFixture({saveAllTabsLogToFiles:true}); seed(f);
  f.run("writeTabLog('tab-shell-1','Shell','NO');"); assert.equal(f.run('tabLogBuffers.size'),0);
  f.run("currentConfig.saveShellTabsLogToFiles=true; writeTabLog('tab-shell-1','Shell','YES'); writeTabLog('tab-main','Main','SERIAL'); closeShellTabLogSessions();");
  assert.equal(f.text('_shell'),'YES'); assert.equal(f.run("tabLogBuffers.has('tab-main')"),true);
});

test('reconnect retains the new claim and rejects another group', async () => {
  const f = createFixture(); await f.connect('default','COM_A'); await f.connect('default','COM_A');
  assert.equal(f.run("serialPortClaims.ownerOf('COM_A')"),'default');
  await assert.rejects(f.connect('g-1','COM_A'), /SERIAL_PORT_IN_USE/);
  assert.equal(f.ports.filter(p=>p.isOpen).length,1);
});

test('failed log flush prevents changing a group port and preserves its pending data', async () => {
  const f = createFixture(); await f.connect('default','COM_A');
  f.run("writeLog('PENDING','default')"); f.fail('COM_A');
  await assert.rejects(f.connect('default','COM_B'), /Failed to flush/);
  assert.equal(f.run("getSerialSession('default').portPath"),'COM_A');
  assert.equal(f.run("serialPortClaims.ownerOf('COM_B')"),null);
  f.fail(''); await f.connect('default','COM_B'); f.run('flushPendingLogs()');
  assert.match(f.text('COM_A'), /PENDING/); assert.doesNotMatch(f.text('COM_B'), /PENDING/);
});

test('duplicate opening is rejected without changing claims; cancellation closes late open', async () => {
  const f=createFixture(); f.deferOpen(true);
  const pending=f.connect('default','COM_A');
  await assert.rejects(f.connect('default','COM_B'), /already in progress/);
  assert.equal(f.run("serialPortClaims.ownerOf('COM_A')"),'default');
  assert.equal(f.run("serialPortClaims.ownerOf('COM_B')"),null);
  f.listeners['disconnect-serial']({}, {groupId:'default'});
  assert.equal(f.run("serialPortClaims.ownerOf('COM_A')"),'default');
  f.ports[0].finishOpen(null);
  await assert.rejects(pending,/cancelled/);
  assert.equal(f.ports[0].isOpen,false); assert.equal(f.run('serialPortClaims.size()'),0);
  assert.equal(f.events.some(e=>e[0]==='serial-throughput-update' && e[1].connected),false);
});

test('open failure releases claim for the next connection', async () => {
  const f=createFixture(); f.deferOpen(true); const pending=f.connect('default','COM_A');
  f.ports[0].finishOpen(new Error('open failed')); await assert.rejects(pending);
  assert.equal(f.run('serialPortClaims.size()'),0);
});


test('old port stays claimed while close is pending and close failure preserves its owner',async()=>{
  const f=createFixture();await f.connect('default','COM_A');
  const old=f.ports[0];let finishClose;
  old.close=callback=>{finishClose=callback;};
  const switching=f.connect('default','COM_B');
  await assert.rejects(f.connect('g-1','COM_A'),/SERIAL_PORT_IN_USE/);
  finishClose(new Error('close failed'));await assert.rejects(switching,/close failed/);
  assert.equal(f.run("serialPortClaims.ownerOf('COM_A')"),'default');
  assert.equal(f.run("serialPortClaims.ownerOf('COM_B')"),null);
  assert.equal(old.isOpen,true);
});

test('same-port close failure restores the live connection claim',async()=>{
  const f=createFixture();await f.connect('default','COM_A');
  f.ports[0].close=callback=>callback(new Error('close failed'));
  await assert.rejects(f.connect('default','COM_A'),/close failed/);
  assert.equal(f.run("serialPortClaims.ownerOf('COM_A')"),'default');
  await assert.rejects(f.connect('g-1','COM_A'),/SERIAL_PORT_IN_USE/);
});

test('tab logging failure is isolated and mode switching preserves pending bytes',()=>{
  const f=createFixture({saveAllTabsLogToFiles:true});seed(f);f.fail('COM_A');
  f.run("writeTabLog('tab-main','A','A','default');writeTabLog('tab-main-g-1','B','B','g-1');saveAllTabLogs({notify:false,closeEntries:false})");
  assert.equal(f.text('COM_B'),'B');
  assert.throws(()=>f.run('saveConfig({saveAllTabsLogToFiles:false})'),/Failed to flush/);
  assert.equal(f.run("tabLogBuffers.get('tab-main').buffer.join('')"),'A');
  f.fail('');f.run('saveConfig({saveAllTabsLogToFiles:false})');assert.equal(f.text('COM_A'),'A');
});

test('manual close rotates each group file and tab titles receive distinct paths',()=>{
  const f=createFixture();seed(f);
  f.run("writeLog('OLD','default');closeMainLogSession({notify:false});writeLog('NEW','default');saveLog({notify:false})");
  assert.equal([...f.files.keys()].filter(p=>p.includes('COM_A')).length,2);
  f.run("currentConfig.saveAllTabsLogToFiles=true;writeTabLog('tab-filter-1','Same','ONE');writeTabLog('tab-filter-2','Same','TWO');saveAllTabLogs({notify:false})");
  const tabFiles=[...f.files].filter(([p])=>p.includes('Same'));
  assert.equal(tabFiles.length,2);assert.deepEqual(tabFiles.map(([,b])=>b.toString()),['ONE','TWO']);
});


test('first flush after midnight never appends the same pending bytes twice',()=>{
  for(const perTab of [false,true]) {
    const f=createFixture({logCreateDateFolder:true,saveAllTabsLogToFiles:perTab});seed(f);
    f.run("writeTabLog('tab-main','Main','TEXT');bufferRawSerialBytes(Buffer.from('RAW'),'default')");
    f.date('2026-11-14');f.run('flushPendingLogs()');
    assert.equal(f.text('COM_A'),'RAWTEXT');
    f.run('flushPendingLogs()');assert.equal(f.text('COM_A'),'RAWTEXT');
  }
});
