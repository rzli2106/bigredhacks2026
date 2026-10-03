import test from 'node:test';
import assert from 'node:assert/strict';
import { RawMotionTransport } from '../frontend/connection.js';
for (const status of [401,403]) test(`raw sensor authentication failure ${status} stops transport and requests pairing recovery`,async t=>{
  t.mock.method(globalThis,'setInterval',()=>1);t.mock.method(globalThis,'clearInterval',()=>{});
  let calls=0;const rejected=[];
  t.mock.method(globalThis,'fetch',async()=>{calls++;return {ok:false,status,json:async()=>({error:'Pairing ended.'})};});
  const transport=new RawMotionTransport({api:'https://example.test',token:'synthetic',deviceId:'synthetic-device',getLocation:()=>null,onRejected:(...args)=>rejected.push(args)});
  t.after(()=>transport.stop());transport.start();transport.enqueue({timestamp:Date.now()});await transport.flush();
  assert.equal(transport.enabled,false);assert.deepEqual(rejected,[['Pairing ended.',status]]);
  transport.enqueue({timestamp:Date.now()});await transport.flush();assert.equal(calls,1);
});
