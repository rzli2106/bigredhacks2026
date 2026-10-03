import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceTransport } from '../frontend/connection.js';

const settle = async () => { for (let i=0;i<10;i++) await Promise.resolve(); };
function fixture(t, { ignoreAbort = false } = {}) {
  const calls=[],timers=[],statuses=[],sent=[],rejected=[],rejectedCodes=[];
  t.mock.method(globalThis,'setInterval',()=>1); t.mock.method(globalThis,'clearInterval',()=>{});
  t.mock.method(globalThis,'setTimeout',(callback,ms)=>{const timer={callback,ms,cleared:false};timers.push(timer);return timer;});
  t.mock.method(globalThis,'clearTimeout',timer=>{timer.cleared=true;});
  t.mock.method(globalThis,'fetch',(url,options)=>new Promise((resolve,reject)=>{
    const call={url,options,body:JSON.parse(options.body),respond:(body={},status=200)=>resolve({ok:status<400,status,json:async()=>body})};calls.push(call);
    if(!ignoreAbort)options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
  }));
  const transport=new DeviceTransport({api:'https://example.test',token:'synthetic-token',deviceId:'synthetic-device',onStatus:s=>statuses.push(s),onSent:s=>sent.push(s),onRejected:(s,code)=>{rejected.push(s);rejectedCodes.push(code);}});
  t.after(()=>transport.stop());
  return {transport,calls,timers,statuses,sent,rejected,rejectedCodes};
}

test('heartbeats do not overlap and stopping aborts both heartbeat and report requests',async t=>{
  const {transport,calls,statuses,sent}=fixture(t);
  transport.start();transport.start();transport.heartbeat();
  assert.equal(calls.length,1);
  transport.enqueue({timestamp:Date.now()/1000});assert.equal(calls.length,2);
  transport.stop();await settle();
  assert.ok(calls.every(call=>call.options.signal.aborted));assert.equal(transport.queue.length,0);
  assert.deepEqual(statuses,[]);assert.deepEqual(sent,[]);
});

test('timed-out uploads release the queue and retry with the same idempotency ID',async t=>{
  const {transport,calls,timers,statuses,sent}=fixture(t);transport.start();
  calls[0].respond();await settle();
  transport.enqueue({timestamp:Date.now()/1000});const original=calls[1].body.event_id;
  timers.find(timer=>timer.ms===10000&&!timer.cleared).callback();await settle();
  assert.equal(transport.running,false);assert.equal(transport.queue.length,1);assert.match(statuses.at(-1),/timed out/);
  const retry=transport.flush();assert.equal(calls[2].body.event_id,original);
  calls[2].respond({accepted:true});await retry;
  assert.equal(transport.queue.length,0);assert.equal(sent.length,1);
});

test('late responses from a stopped generation cannot consume a restarted queue',async t=>{
  const {transport,calls,sent}=fixture(t,{ignoreAbort:true});transport.start();
  transport.enqueue({timestamp:Date.now()/1000});const old=calls[1];transport.stop();transport.start();
  transport.enqueue({timestamp:Date.now()/1000});const fresh=calls[3];
  old.respond({accepted:true});await settle();
  assert.equal(transport.queue[0].event_id,fresh.body.event_id);assert.equal(transport.running,true);assert.equal(sent.length,0);
  fresh.respond({accepted:true});await settle();assert.equal(transport.queue.length,0);assert.equal(sent.length,1);
});

test('expired device credentials stop requests and report the pairing error once',async t=>{
  const {transport,calls,rejected,rejectedCodes}=fixture(t);transport.start();
  calls[0].respond({error:'Pairing expired.'},401);await settle();
  assert.equal(transport.enabled,false);transport.enqueue({timestamp:Date.now()/1000});transport.heartbeat();
  assert.equal(calls.length,1);assert.deepEqual(rejected,['Pairing expired.']);assert.deepEqual(rejectedCodes,[401]);
});

test('overflowing a busy queue does not discard an extra unsent report on acknowledgement',async t=>{
  const {transport,calls}=fixture(t);transport.start();calls[0].respond();await settle();
  for(let i=0;i<101;i++)transport.enqueue({timestamp:Date.now()/1000,sequence:i});
  assert.equal(transport.queue.length,100);assert.equal(transport.queue[0].sequence,1);
  calls[1].respond({accepted:true});await settle();
  assert.equal(calls[2].body.sequence,1);assert.equal(transport.queue.length,100);
});

 test('rejecting an evicted report preserves the next unsent report',async t=>{
  const {transport,calls,rejected,rejectedCodes}=fixture(t);transport.start();calls[0].respond();await settle();
  for(let i=0;i<101;i++)transport.enqueue({timestamp:Date.now()/1000,sequence:i});
  calls[1].respond({error:'Invalid report.'},422);await settle();
  assert.equal(calls[2].body.sequence,1);assert.equal(transport.queue.length,100);
  assert.deepEqual(rejected,['Invalid report.']);
});
