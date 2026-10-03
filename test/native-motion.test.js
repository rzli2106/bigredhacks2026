import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeMotionService} from '../frontend/native-motion.js';
import {ScenarioRunner} from '../backend/simulator.js';
import {readFile} from 'node:fs/promises';
import {buildWalkingGraph} from '../src/routing/index.js';

function fixture(startMotion=async()=>{}) {
  const listeners=new Set();let stops=0;
  const bridge={startMotion,stopMotion:async()=>{stops++;},addListener:async(name,fn)=>{assert.equal(name,'motionSample');listeners.add(fn);return{remove:async()=>listeners.delete(fn)};}};
  const document=new EventTarget();document.hidden=false;
  return {bridge,document,emit:sample=>{for(const fn of listeners)fn(sample);},listeners,get stops(){return stops;}};
}
const pulse=emit=>[...Array(13).fill(0),2,8,2,0].forEach((height,i)=>emit({timestamp:i*20,accelerationIncludingGravity:{x:0,y:0,z:9.81+height},rotationRate:{alpha:0,beta:0,gamma:0}}));
test('native motion produces backend-accepted evidence and ignores stopped/hidden sensors',async()=>{
  const f=fixture(),candidates=[];
  const service=new NativeMotionService({...f,onCandidate:c=>candidates.push(c)});
  await service.start();await service.start();assert.equal(f.listeners.size,1);
  f.document.hidden=true;pulse(f.emit);assert.equal(candidates.length,0);
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));pulse(f.emit);assert.equal(candidates.length,1);
  const runner=new ScenarioRunner(buildWalkingGraph(JSON.parse(await readFile(new URL('../public/cornell-osm.json',import.meta.url),'utf8'))));
  const c=candidates[0];assert.equal(runner.engine.ingest({device_id:'native-test',event_id:'impact',source:'native_motion',metric_type:'SENSOR_SHOCK',severity:1,timestamp:runner.baseTime,lat:runner.corridor.center.lat,lng:runner.corridor.center.lon,evidence:{gyro_deg_s:c.peakAngularSpeed*180/Math.PI,peak_jerk:c.peakJerk,peak_acceleration:c.peakAcceleration,fwhm_ms:c.fwhmMs}}).accepted,true);runner.dispose();
  await service.stop();pulse(f.emit);assert.equal(f.listeners.size,0);assert.equal(candidates.length,1);
});
test('native stop during asynchronous startup prevents late sensor/listener activation',async()=>{
  let release,started;
  const ready=new Promise(resolve=>started=resolve);
  let first=true;
  const f=fixture(()=>{if(!first)return Promise.resolve();first=false;return new Promise(resolve=>{release=resolve;started();});});
  const service=new NativeMotionService(f);const pending=service.start();await ready;
  const stopping=service.stop();release();await pending;await stopping;
  assert.equal(service.running,false);assert.equal(f.listeners.size,0);assert.ok(f.stops>=1);
  await service.start();assert.equal(service.running,true);await service.stop();assert.equal(f.listeners.size,0);
});
test('missing native sensors rejects cleanly and permits a retry',async()=>{
  let fail=true;const f=fixture(async()=>{if(fail)throw new Error('Gyroscope unavailable');});const service=new NativeMotionService(f);
  await assert.rejects(service.start(),/Gyroscope/);assert.equal(f.listeners.size,0);assert.equal(service.running,false);
  fail=false;await service.start();assert.equal(service.running,true);await service.stop();
});
