import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { buildWalkingGraph } from '../src/routing/graph.js';
import { RoadBlocks } from '../src/routing/road-blocks.js';
import { TelemetryEngine } from '../backend/engine.js';
import { createTelemetryServer } from '../backend/server.js';
import { localDeviceId, WebSocketMotionTransport } from '../frontend/connection.js';
import { NotificationChime } from '../frontend/notification-chime.js';

const nodes = Array.from({length:6},(_,i)=>({type:'node',id:i+1,lat:42.445,lon:-76.485+i*.0002,...(i===1?{tags:{crossing:'marked'}}:{})}));
const graph = buildWalkingGraph({elements:[...nodes,{type:'node',id:7,lat:42.4452,lon:-76.4844},
  {type:'way',id:10,nodes:[1,2,3],tags:{highway:'residential',name:'Main'}},
  {type:'way',id:11,nodes:[3,4,5,6],tags:{highway:'residential',name:'Main'}},
  {type:'way',id:12,nodes:[4,7],tags:{highway:'footway'}}]});

test('closure blocks both directions across tagged splits and same-name way boundaries, stopping at intersections',()=>{
  const blocks=new RoadBlocks(graph), ids=blocks.edges('10:0-1');
  assert.equal(ids.length,6); assert.ok(ids.includes('11:0-1:backward'));
  assert.ok(!ids.includes('11:1-3:forward')); assert.ok(!ids.includes('12:0-1:forward'));
  const engine=new TelemetryEngine(graph,{now:()=>1800000000});
  try {
    const payload={device_id:'phone',event_id:'closure',lat:42.445,lng:-76.4849,source:'manual',metric_type:'MANUAL_CLOSURE',severity:1,timestamp:1800000000};
    const result=engine.ingest(payload);assert.deepEqual(new Set(result.edge_ids),new Set(ids));
    assert.deepEqual(new Set(engine.snapshot().events[0].edge_ids),new Set(ids));
    assert.equal(engine.route({lat:42.445,lon:-76.48475},{lat:42.445,lon:-76.4845}).status,'unreachable');
    engine.verify(result.id,'resolve');
    assert.equal(engine.route({lat:42.445,lon:-76.48475},{lat:42.445,lon:-76.4845}).status,'ok');
    const finite=engine.ingest({...payload,event_id:'pothole',metric_type:'MANUAL_HAZARD'});assert.equal(finite.edge_ids.length,2);
  }finally{engine.dispose();}
});

test('device IDs persist locally without containing a bearer credential',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const first=localDeviceId(storage);assert.equal(localDeviceId(storage),first);assert.match(first,/^[\w:-]{1,80}$/);assert.equal(values.size,1);
});

const next=socket=>once(socket,'message').then(([bytes])=>JSON.parse(bytes.toString()));
test('a directly registered phone authenticates WSS, gates samples, and broadcasts hazards without observer pairing',async()=>{
  const now=1800000000, service=await createTelemetryServer({graph,now:()=>now,production:true,adminToken:'a'.repeat(32),broadcastMs:60000});
  const {port}=await service.listen(0),api=`http://127.0.0.1:${port}`;
  const sockets=[];
  const open=async(path)=>{const socket=new WebSocket(`ws://127.0.0.1:${port}${path}`);sockets.push(socket);await once(socket,'open');return socket;};
  try {
    const response=await fetch(`${api}/api/devices/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_id:'direct-phone'})});
    assert.equal(response.status,201);const credentials=await response.json();assert.ok(credentials.token);
    const observer=new WebSocket(`ws://127.0.0.1:${port}/ws/stream`);sockets.push(observer);await next(observer);
    const phone=await open('/ws/device'),authenticated=next(phone);
    phone.send(JSON.stringify({type:'authenticate',token:credentials.token,device_id:'direct-phone'}));assert.equal((await authenticated).type,'authenticated');
    const pulse=[...Array(12).fill(0),0,2,8,2,0];
    const ack=next(phone),hazard=new Promise(resolve=>observer.on('message',bytes=>{const value=JSON.parse(bytes);if(value.events.length)resolve(value);}));
    phone.send(JSON.stringify({type:'telemetry',device_id:'direct-phone',location:{lat:42.445,lng:-76.4849,accuracy_meters:3,timestamp:now},samples:pulse.map((height,i)=>({timestamp:now*1000-400+i*20,accelerationIncludingGravity:{x:0,y:0,z:9.81+height},rotationRate:{alpha:0,beta:0,gamma:0}}))}));
    assert.equal((await ack).events.length,1);assert.equal((await hazard).events[0].source,'web_motion');
    const error=next(phone);phone.send(JSON.stringify({type:'heartbeat',device_id:'someone-else'}));assert.equal((await error).status,403);
    const unauthorized=await open('/ws/device'),rejected=next(unauthorized);unauthorized.send(JSON.stringify({type:'telemetry',device_id:'direct-phone'}));assert.equal((await rejected).status,401);
    const manual=await fetch(`${api}/api/telemetry/event`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${credentials.token}`},body:JSON.stringify({device_id:'direct-phone',event_id:'dragged',source:'manual',metric_type:'MANUAL_HAZARD',severity:1,lat:42.445,lng:-76.4845,timestamp:now,accuracy_meters:0})});
    assert.equal(manual.status,201);assert.equal((await manual.json()).coordinate.lng,-76.4845);
  }finally{for(const socket of sockets)socket.terminate();await service.close();}
});

test('notification unlock synchronously primes one reusable, unmuted audio element',async()=>{
  const originalAudio=globalThis.Audio,originalWindow=globalThis.window,calls=[];
  globalThis.Audio=class{constructor(src){this.src=src;calls.push('new');}play(){calls.push(['play',this.src,this.muted]);return Promise.resolve();}pause(){}load(){}};
  globalThis.window={};
  try{const chime=new NotificationChime();chime.unlock();assert.deepEqual(calls[1],['play','/public/silence.wav',false]);await new Promise(resolve=>setImmediate(resolve));chime.play();assert.equal(calls.filter(call=>call==='new').length,1);assert.deepEqual(calls[2],['play','/public/chime.wav',false]);}
  finally{globalThis.Audio=originalAudio;globalThis.window=originalWindow;}
});

test('WebSocket transport authenticates before sending and keeps only fresh samples with one batch in flight',()=>{
  const Original=globalThis.WebSocket,sent=[];
  globalThis.WebSocket=class{constructor(){this.readyState=1;}send(data){sent.push(JSON.parse(data));}close(){this.onclose?.();}};
  const transport=new WebSocketMotionTransport({api:'https://clearpath.wiki',token:'scoped',deviceId:'test',getLocation:()=>null});
  try{
    transport.start();transport.enqueue({timestamp:Date.now()});transport.flush();assert.equal(sent.length,0);
    transport.socket.onopen();assert.equal(sent[0].type,'authenticate');
    transport.socket.onmessage({data:JSON.stringify({type:'authenticated'})});transport.flush();assert.equal(sent[1].type,'telemetry');
    transport.enqueue({timestamp:Date.now()});transport.flush();assert.equal(sent.length,2);
    transport.socket.onmessage({data:JSON.stringify({type:'telemetry_ack',events:[]})});transport.flush();assert.equal(sent.length,3);
  }finally{transport.stop();globalThis.WebSocket=Original;}
});
