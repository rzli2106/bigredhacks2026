import test from 'node:test';
import assert from 'node:assert/strict';
import { PassedHazards, HazardCheckPrompt } from '../frontend/passed-hazard.js';
import { TelemetryEngine } from '../backend/engine.js';
import { buildWalkingGraph } from '../src/routing/graph.js';
const T=1800000000, center={lat:42.445,lon:-76.485};
const route={status:'ok',geometry:[{...center,lon:center.lon-.001},{...center,lon:center.lon+.001}],edgeIds:['edge']};
const event={id:'hazard',edge_ids:['edge'],coordinate:{lat:center.lat,lng:center.lon}};
const snapshot={instance_id:'server',events:[event]};
const fix=(offset,time=T,accuracyMeters=1)=>({...center,lon:center.lon+offset,timestamp:time,accuracyMeters});
test('a fresh ahead-to-behind crossing prompts once, including after a report refresh',()=>{
  const tracker=new PassedHazards();assert.deepEqual(tracker.observe(route,snapshot,fix(-.0001),T),[]);
  assert.deepEqual(tracker.observe(route,snapshot,fix(.00018,T+4),T+4),[event]);
  assert.deepEqual(tracker.observe(route,snapshot,fix(.0002,T+5),T+5),[]);
  tracker.observe(route,snapshot,fix(-.0001,T+10),T+10);
  assert.deepEqual(tracker.observe(route,{...snapshot,events:[{...event,timestamp:T+10}]},fix(.00018,T+14),T+14),[]);
});
test('starting behind, stale fixes, GPS jitter, inaccurate positions and teleports do not prompt',()=>{
  assert.deepEqual(new PassedHazards().observe(route,snapshot,fix(.0001),T),[]);
  for(const bad of [fix(.0001,T+20),fix(.0001,T+4,30),fix(.0001,T+1)]){
    const tracker=new PassedHazards();tracker.observe(route,snapshot,fix(-.0001),T);
    assert.deepEqual(tracker.observe(route,snapshot,bad,bad.timestamp),[]);
  }
  const tracker=new PassedHazards();tracker.observe(route,snapshot,fix(-.0001),T);
  assert.deepEqual(tracker.observe(route,snapshot,fix(.0001),T+11),[]);
  assert.deepEqual(tracker.observe(route,snapshot,fix(.00001,T+4,5),T+4),[]);
});
test('nearby hazards on another edge and server changes do not count as passage',()=>{
  const tracker=new PassedHazards();tracker.observe(route,snapshot,fix(-.0001),T);
  assert.deepEqual(tracker.observe({...route,edgeIds:['different']},snapshot,fix(.00018,T+4),T+4),[]);
  assert.deepEqual(tracker.observe(route,{...snapshot,instance_id:'new'},fix(.0002,T+5),T+5),[]);
});
function promptFixture(){
  const element={hidden:true}, label={},yes={},no={},timers=new Map(),answers=[];let n=0;
  const prompt=new HazardCheckPrompt({element,label,yes,no,onAnswer:(...args)=>answers.push(args),schedule:(fn,ms)=>{timers.set(++n,{fn,ms});return n;},cancel:id=>timers.delete(id)});
  return {prompt,element,label,yes,no,timers,answers};
}
test('prompt dismisses at three seconds without changing the hazard or taking focus',()=>{
  const f=promptFixture();f.prompt.show(event,'Pothole');assert.equal(f.element.hidden,false);assert.match(f.label.textContent,/is this still here/);
  const timer=[...f.timers.values()][0];assert.equal(timer.ms,3000);timer.fn();assert.equal(f.element.hidden,true);assert.equal(f.answers.length,0);
});
test('answers dismiss immediately and send only one explicit response; replaced timers cannot hide the new prompt',async()=>{
  const f=promptFixture();f.prompt.show(event,'Pothole');const old=[...f.timers.values()][0];
  f.prompt.show({...event,id:'second'},'Obstacle');old.fn();assert.equal(f.element.hidden,false);
  f.yes.onclick();f.no.onclick();await Promise.resolve();assert.equal(f.answers.length,1);assert.equal(f.answers[0][0].id,'second');assert.equal(f.answers[0][1],'confirm');assert.equal(f.element.hidden,true);
  f.prompt.show(event,'Pothole');f.no.onclick();await Promise.resolve();assert.equal(f.answers[1][1],'resolve');
});
const graph=buildWalkingGraph({elements:[{type:'node',id:1,...center},{type:'node',id:2,...center,lon:center.lon+.001},{type:'way',id:1,nodes:[1,2],tags:{highway:'footway'}}]});
test('nearby feedback rejects stale/far/uncertain observations and accepts explicit confirm and resolve idempotently',()=>{
  let now=T;const engine=new TelemetryEngine(graph,{now:()=>now});
  try{
    const report=engine.ingest({device_id:'walker',event_id:'report',source:'manual',metric_type:'MANUAL_HAZARD',severity:1,timestamp:T,lat:center.lat,lng:center.lon});
    const feedback={device_id:'walker',id:report.id,action:'confirm',lat:center.lat,lng:center.lon,accuracy_meters:1,timestamp:T};
    assert.throws(()=>engine.nearbyFeedback({...feedback,lng:center.lon+.01}),/near this hazard/);
    assert.throws(()=>engine.nearbyFeedback({...feedback,timestamp:T-11}),/fresh location/);
    assert.throws(()=>engine.nearbyFeedback({...feedback,accuracy_meters:30}),/fresh location/);
    now+=5;engine.nearbyFeedback({...feedback,timestamp:now});assert.equal(engine.snapshot().events[0].timestamp,now);
    assert.equal(engine.nearbyFeedback({...feedback,timestamp:now}).duplicate,true);
    engine.nearbyFeedback({...feedback,timestamp:now,action:'resolve'});assert.equal(engine.snapshot().events.length,0);
    assert.equal(engine.nearbyFeedback({...feedback,timestamp:now,action:'resolve'}).duplicate,true);
  }finally{engine.dispose();}
});
test('the feedback endpoint requires the device session and rejects another device identity',async()=>{
  const {createTelemetryServer}=await import('../backend/server.js');
  const service=await createTelemetryServer({graph,now:()=>T,production:true,adminToken:'a'.repeat(32)});
  try{
    const {port}=await service.listen(0),api=`http://127.0.0.1:${port}`;
    const post=(path,data,token)=>fetch(api+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});
    const credentials=await (await post('/api/devices/register',{device_id:'walker'})).json();
    const report=service.engine.ingest({device_id:'walker',source:'manual',metric_type:'MANUAL_HAZARD',severity:1,timestamp:T,lat:center.lat,lng:center.lon});
    const data={device_id:'walker',id:report.id,action:'resolve',lat:center.lat,lng:center.lon,accuracy_meters:1,timestamp:T};
    assert.equal((await post('/api/telemetry/feedback',data)).status,401);
    assert.equal((await post('/api/telemetry/feedback',{...data,device_id:'someone-else'},credentials.token)).status,403);
    assert.equal(service.engine.snapshot().events.length,1);
    assert.equal((await post('/api/telemetry/feedback',data,credentials.token)).status,200);
    assert.equal(service.engine.snapshot().events.length,0);
  }finally{await service.close();}
});
