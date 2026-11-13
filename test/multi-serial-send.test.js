'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(invoke) {
  const sessions = new Map([['default', 1], ['g-1', 1]]);
  const records = [];
  const scrolls = [];
  const context = vm.createContext({
    Buffer, serialWriteChains: new Map(), SEND_LIMITS: {main:100,quick:100},
    REGISTRY_DEFAULT_GROUP_ID:'default', resolveSerialGroupId:value=>value || 'default',
    activeGroupId:'default', isGroupConnected:group=>sessions.has(group),
    getGroupDisplay:()=>({sendEncoding:'utf8',newlineMode:'crlf'}),
    validateSendContent:()=>({ok:true,bytes:Buffer.from('x')}),
    getGroupSessionId:group=>sessions.get(group), ipcRenderer:{invoke},
    scrollToBottomOnSend:true,
    serialRuntimes:{get:group=>({term:{scrollToBottom:()=>scrolls.push(group)}})},
    requestAnimationFrame:callback=>callback(),
    renderSentRecord:(record,group)=>records.push(group),formatTimestamp:()=>'',
    setActionStatus:()=>{},trFallback:()=>'',quickSendTriggerInFlight:new Set(),flashQuickSendItem:()=>{}
  });
  vm.runInContext(section('function scrollMainTerminalToBottom(', 'function drainTerminalOutput('),context);
  vm.runInContext(section('async function sendSerialRequest(', 'function putTextInMainInput('),context);
  vm.runInContext(section('async function triggerQuickSendItem(', 'function showQuickSendClickResult('),context);
  return {context,sessions,records,scrolls,run:code=>vm.runInContext(code,context)};
}

test('slow writes block only their own group, preserving per-group order and target scroll',async()=>{
  const calls=[];let release;
  const f=fixture((_,request)=>{
    calls.push(request.content);
    if(request.content==='A1') return new Promise(resolve=>release=resolve);
    return Promise.resolve({ok:true});
  });
  const a1=f.run("sendSerialRequest({groupId:'default',content:'A1'})");
  const a2=f.run("sendSerialRequest({groupId:'default',content:'A2'})");
  const b=f.run("sendSerialRequest({groupId:'g-1',content:'B'})");
  await b; assert.deepEqual(calls,['A1','B']); assert.deepEqual(f.scrolls,['g-1']);
  release({ok:true}); await Promise.all([a1,a2]);
  assert.deepEqual(calls,['A1','B','A2']);
  assert.deepEqual(f.records,['g-1','default','default']);
});

test('queued writes from an old session are rejected and failed writes do not poison the chain',async()=>{
  let release;const calls=[];
  const f=fixture((_,r)=>{calls.push(r.content);if(r.content==='slow')return new Promise(resolve=>release=resolve);throw new Error('write failed');});
  const first=f.run("sendSerialRequest({groupId:'default',content:'slow'})");
  const old=f.run("sendSerialRequest({groupId:'default',content:'old'})");
  await tick(); f.sessions.set('default',2); release({ok:false}); await first;
  assert.equal((await old).code,'STALE_SERIAL_SESSION'); assert.deepEqual(calls,['slow']);
  assert.equal((await f.run("sendSerialRequest({groupId:'default',content:'fail1'})")).code,'SERIAL_WRITE_FAILED');
  assert.equal((await f.run("sendSerialRequest({groupId:'default',content:'fail2'})")).code,'SERIAL_WRITE_FAILED');
  assert.deepEqual(calls,['slow','fail1','fail2']);
});

test('same auto-trigger command runs once per group and releases after completion',async()=>{
  const calls=[];const releases=[];
  const f=fixture((_,r)=>{calls.push(r.groupId);return new Promise(resolve=>releases.push(resolve));});
  f.context.item={id:'shared',content:'reply',mode:'text'};
  const a=f.run("triggerQuickSendItem(item,'default')");
  const duplicate=f.run("triggerQuickSendItem(item,'default')");
  const b=f.run("triggerQuickSendItem(item,'g-1')");
  await tick(); assert.deepEqual(calls,['default','g-1']);
  releases.forEach(resolve=>resolve({ok:true})); await Promise.all([a,b,duplicate]);
  assert.equal(f.context.quickSendTriggerInFlight.size,0);
});
