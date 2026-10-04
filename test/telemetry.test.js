import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {buildWalkingGraph} from '../src/routing/index.js';
import {TelemetryEngine} from '../backend/engine.js';
import {ScenarioRunner} from '../backend/simulator.js';
import {createTelemetryServer} from '../backend/server.js';
import {HealthAnalyzer} from '../frontend/health-analysis.js';
import {SHOCK_GATE} from '../src/telemetry/policy.js';
const graph=buildWalkingGraph(JSON.parse(await readFile(new URL('../public/cornell-osm.json',import.meta.url),'utf8')));
const fixture=()=>new ScenarioRunner(graph,{baseTime:1800000000});
const payload=(runner,overrides={})=>({device_id:'phone-1',event_id:crypto.randomUUID(),lat:runner.corridor.center.lat,lng:runner.corridor.center.lon,source:'web_motion',metric_type:'SENSOR_SHOCK',severity:1,timestamp:runner.baseTime,evidence:{gyro_deg_s:0,peak_acceleration:17.81,peak_jerk:300,fwhm_ms:26.67},...overrides});
test('actual Cornell scenarios A–D pass and rewind restores the original hazard',()=>{
 const runner=fixture();for(const name of ['A','B','C','D'])assert.equal(runner.run(name).passed,true,name);runner.seek(0);assert.equal(runner.snapshot().events[0].remaining_penalty,50);runner.verify(runner.snapshot().events[0].id,'resolve');runner.seek(0);assert.equal(runner.snapshot().events.length,0);runner.dispose();
});
test('schema, freshness, coverage, and shock proof reject invalid evidence without mutation',()=>{
 const runner=fixture(),engine=runner.engine;
 for(const overrides of [{severity:0},{timestamp:runner.baseTime-121},{lat:0,lng:0},{source:'healthkit',metric_type:'MANUAL_CLOSURE'}])assert.throws(()=>engine.ingest(payload(runner,overrides)));
 for(const evidence of [{gyro_deg_s:301,peak_jerk:900,peak_acceleration:30,fwhm_ms:20},{gyro_deg_s:0,peak_jerk:SHOCK_GATE.jerkThreshold,peak_acceleration:20,fwhm_ms:20},{gyro_deg_s:0,peak_jerk:90,peak_acceleration:SHOCK_GATE.accelerationThreshold,fwhm_ms:20},{gyro_deg_s:0,peak_jerk:90,peak_acceleration:20,fwhm_ms:45},{}])assert.equal(engine.ingest(payload(runner,{evidence})).accepted,false);
 assert.equal(engine.events().length,0);const input=payload(runner);const first=engine.ingest(input);assert.equal(engine.ingest(input).id,first.id);assert.equal(engine.events().length,1);assert.equal(JSON.stringify(engine.snapshot()).includes('phone-1'),false);runner.dispose();
});
test('all policy penalties and hard-closure expiration match the requested half-lives',()=>{
 const runner=fixture(),engine=runner.engine;
 const types=[['SENSOR_SHOCK','web_motion',50,900],['TERRAIN_DRAG','healthkit',100,1800],['MANUAL_HAZARD','manual',300,3600],['MANUAL_CLOSURE','manual',null,14400]];
 for(const [metric_type,source]of types)engine.ingest(payload(runner,{metric_type,source}));
 const events=engine.snapshot().events;types.forEach(([type,,penalty,halfLife],i)=>{assert.equal(events[i].metric_type,type);assert.equal(events[i].initial_penalty,penalty);assert.equal(events[i].half_life,halfLife);});
 runner.offset=14400;assert.equal(engine.snapshot().events.some(event=>event.blocked),false);runner.dispose();
});
test('sub-meter smooth crossing halves a shock and uncertain GPS cannot clear it',()=>{
 const runner=fixture();runner.seedShock();const trace=runner.bypassTrack(0,1);runner.offset=5;
 const input={device_id:'smooth-walker',passage_id:'first',trace,shock_detected:false};
 const result=runner.engine.passage(input);assert.equal(result.updates[0].classification,'clearance');assert.equal(result.updates[0].updated,true);assert.ok(runner.snapshot().events[0].remaining_penalty<25);
 const before=runner.snapshot().events[0].remaining_penalty;runner.engine.passage({...input,passage_id:'uncertain',trace:trace.map(point=>({...point,accuracy_meters:5}))});assert.equal(runner.snapshot().events[0].remaining_penalty,before);runner.dispose();
});
test('health analyzer matches fresh samples, rejects delayed records, and normalizes stopped cadence',()=>{
 const analyzer=new HealthAnalyzer(),now=1800000000,fix={lat:42.4468,lon:-76.485,accuracyMeters:3,timestamp:now};
 const samples=Array.from({length:5},(_,i)=>({id:`base-${i}`,metric:'speed',value:1.4,start:now-10+i,end:now-10+i,source:'healthkit'}));
 assert.equal(analyzer.ingest(samples,[fix],now).length,0);
 assert.equal(analyzer.ingest([{id:'slow',metric:'speed',value:.5,start:now,end:now,source:'healthkit'}],[fix],now).length,1);
 assert.equal(analyzer.ingest([{id:'delayed',metric:'speed',value:.1,start:now-3600,end:now-3600,source:'healthkit'}],[fix],now).length,0);
 const other=new HealthAnalyzer();other.ingest(samples,[fix],now);
 assert.equal(other.ingest([{id:'stop-steps',metric:'steps',value:0,start:now-5,end:now,source:'health_connect'},{id:'stop-speed',metric:'speed',value:0,start:now,end:now,source:'health_connect'}],[fix],now).length,0);
 const asym=new HealthAnalyzer();asym.ingest(samples.map(s=>({...s,metric:'asymmetry',value:.1})),[fix],now);
 assert.equal(asym.ingest([{id:'jump',metric:'asymmetry',value:.12,start:now,end:now,source:'healthkit'}],[fix],now).length,1);
 assert.equal(asym.ingest([{id:'jump',metric:'asymmetry',value:.12,start:now,end:now,source:'healthkit'}],[fix],now).length,0);
});
test('HTTP pairing, authorization, CORS, fanout to two observers, dedup, and expiry',async t=>{
 const runner=fixture();let now=runner.baseTime;const service=await createTelemetryServer({graph,now:()=>now,production:true,adminToken:'a'.repeat(40),allowedOrigins:['https://clearpath.example'],publicApiUrl:'https://api.clearpath.example',broadcastMs:60000});
 const address=await service.listen(0);const base=`http://127.0.0.1:${address.port}`;t.after(()=>service.close());
 const post=async(path,body,token,origin='https://clearpath.example')=>fetch(`${base}${path}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
 assert.equal((await post('/api/pairing',{},null)).status,401);assert.equal((await post('/api/pairing',{},service.adminToken,'https://evil.example')).status,403);
 const paired=await post('/api/pairing',{mobile_url:'https://clearpath.example/mobile'},service.adminToken);assert.equal(paired.status,201);const link=new URL((await paired.json()).url),fragment=new URLSearchParams(link.hash.slice(1)),token=fragment.get('token'),device=fragment.get('device_id');
 assert.equal(link.search,'');assert.equal(fragment.get('api'),'https://api.clearpath.example');
 const streams=[1,2].map(()=>new WebSocket(`${base.replace('http:','ws:')}/ws/stream`,{origin:'https://clearpath.example'}));
 const first=await Promise.all(streams.map(socket=>new Promise((resolve,reject)=>{socket.once('message',data=>resolve(JSON.parse(data)));socket.once('error',reject);})));assert.equal(first[0].events.length,0);
 assert.equal((await post('/api/devices/heartbeat',{device_id:'wrong'},token)).status,403);
 assert.equal((await post('/api/devices/heartbeat',{device_id:device},token)).status,200);
 const event=payload(runner,{device_id:device});const updates=Promise.all(streams.map(socket=>new Promise(resolve=>socket.once('message',data=>resolve(JSON.parse(data))))));
 const accepted=await post('/api/telemetry/event',event,token);assert.equal(accepted.status,201);const id=(await accepted.json()).id;
 const snapshots=await updates;for(const data of snapshots){assert.equal(data.events.length,1);assert.equal(data.connected_devices,1);assert.equal(JSON.stringify(data).includes(device),false);}
 const duplicate=await post('/api/telemetry/event',event,token);assert.equal((await duplicate.json()).duplicate,true);
 assert.equal((await post('/api/telemetry/verify',{id,action:'resolve'},token)).status,401);
 assert.equal((await post('/api/telemetry/verify',{id,action:'resolve'},service.adminToken)).status,200);
 assert.equal(service.engine.events().length,0);
 assert.equal((await post('/api/telemetry/passage',{device_id:device,passage_id:'bad',trace:[0,1,2].map(()=>({lat:event.lat,lng:event.lng,accuracy_meters:1,timestamp:'invalid'})),shock_detected:false},token)).status,400);
 assert.equal((await post('/api/route',{from:runner.corridor.center,to:runner.corridor.center})).status,200);
 now+=14400;assert.equal((await post('/api/devices/heartbeat',{device_id:device},token)).status,401);
 streams.forEach(socket=>socket.close());runner.dispose();
});

test('renewed simulation closures can resolve and replay without resurrecting',()=>{
 const runner=fixture();const result=runner.inject(runner.corridor.center,'MANUAL_CLOSURE');runner.verify(result.id,'confirm');const renewed=runner.snapshot().events[0].id;assert.notEqual(renewed,result.id);runner.verify(renewed,'resolve');runner.seek(0);assert.equal(runner.snapshot().events.length,0);runner.dispose();
});
test('phone transport discards invalid reports so later valid reports are delivered',async()=>{
 const {DeviceTransport}=await import('../frontend/connection.js');const original=globalThis.fetch;const statuses=[],sent=[];let calls=0;
 globalThis.fetch=async()=>{calls++;return {ok:calls>1,status:calls>1?201:422,json:async()=>calls>1?{accepted:true}:{error:'No walking path nearby.'}};};
 try{const device=new DeviceTransport({api:'http://localhost',token:'test',deviceId:'test',onRejected:error=>statuses.push(error),onSent:value=>sent.push(value)});device.enabled=true;device.queue=[{timestamp:Date.now()/1000},{timestamp:Date.now()/1000}];await device.flush();assert.equal(device.queue.length,0);assert.equal(sent.length,1);assert.deepEqual(statuses,['No walking path nearby.']);}finally{globalThis.fetch=original;}
});
