import { shortestPath, haversine } from '../src/routing/index.js';
import { SensorPipeline } from '../src/sensor-pipeline.js';
import { withinCornell } from '../src/ui/cornell.js';
import { TelemetryEngine } from './engine.js';

function midpoint(segment) {
  let distance=0;const target=segment.distanceMeters/2;
  for(let i=1;i<segment.geometry.length;i++){
    const a=segment.geometry[i-1],b=segment.geometry[i],length=haversine(a,b);
    if(distance+length>=target){const f=(target-distance)/length;return {lat:a.lat+(b.lat-a.lat)*f,lon:a.lon+(b.lon-a.lon)*f,tangent:[a,b]};}
    distance+=length;
  }
}
export function generatedMotion({tumble=false}={}) {
  const pipeline=new SensorPipeline({rotationLimitRadS:300*Math.PI/180}),candidates=[];let dropped=0;
  [...Array(12).fill(0),0,2,8,2,0].forEach((height,i)=>{
    const result=pipeline.push({timestamp:i*20,accelerationIncludingGravity:{x:0,y:0,z:9.81+height},rotationRate:{alpha:tumble&&height>0?500:0,beta:0,gamma:0}});
    candidates.push(...result.candidates);if(result.droppedReason==='tumble')dropped++;
  });
  return {candidates,dropped};
}
export class ScenarioRunner {
  constructor(graph,{baseTime=Date.now()/1000}={}) {
    this.graph=graph;this.baseTime=baseTime;this.offset=0;this.history=[];this.results=[];
    this.engine=new TelemetryEngine(graph,{now:()=>this.baseTime+this.offset,enforceCoverage:false});
    this.corridor=this.findCorridor();
  }
  findCorridor(){
    for(const segment of this.graph.segments){
      if(segment.distanceMeters<8||segment.distanceMeters>100||!withinCornell(segment.geometry[0]))continue;
      const edge=this.graph.edges.get(segment.edgeIds[0]),baseline=shortestPath(this.graph,edge.from,edge.to),center=midpoint(segment);
      if(!baseline||baseline.edgeIds.length!==1||baseline.edgeIds[0]!==edge.id||this.engine.index.nearest(center,{maxDistanceMeters:1})?.segmentId!==segment.id)continue;
      const alternative=shortestPath(this.graph,edge.from,edge.to,{weight:id=>this.graph.edges.get(id).segmentId===segment.id?Infinity:this.graph.edges.get(id).distanceMeters});
      const delta=alternative?.distanceMeters-baseline.distanceMeters;
      if(delta>15&&delta<45)return {segment,edge,baseline,alternative,delta,center};
    }
    throw new Error('No campus corridor with a short alternate path was found.');
  }
  reset(){this.engine.dispose();this.offset=0;this.history=[];this.engine=new TelemetryEngine(this.graph,{now:()=>this.baseTime+this.offset,enforceCoverage:false});}
  route(){return shortestPath(this.graph,this.corridor.edge.from,this.corridor.edge.to,{costs:this.engine.costs,timestamp:this.baseTime+this.offset});}
  inject(coordinate,metricType='SENSOR_SHOCK'){
    const metricSource=metricType.startsWith('MANUAL_')?'manual':metricType==='TERRAIN_DRAG'?'health_connect':'web_motion';
    const payload={device_id:'simulation',event_id:globalThis.crypto.randomUUID(),lat:coordinate.lat,lng:coordinate.lon??coordinate.lng,source:metricSource,metric_type:metricType,severity:1,timestamp:this.baseTime+this.offset,
      ...(metricType==='SENSOR_SHOCK'?{evidence:{gyro_deg_s:0,peak_acceleration:17.81,peak_jerk:300,fwhm_ms:26.67}}:{})};
    const result=this.engine.ingest(payload);if(result.accepted)this.history.push({kind:'event',offset:this.offset,payload,id:result.id});return result;
  }
  verify(id,action){const original=this.history.find(item=>item.kind==='event'&&item.id===id);if(!original)throw new Error('Simulation report no longer exists.');const result=this.engine.verify(id,action);original.id=result.id;this.history.push({kind:'verify',offset:this.offset,eventId:original.payload.event_id,action});}
  seedShock(){this.reset();this.inject(this.corridor.center);}
  seek(minutes){
    if(!Number.isFinite(minutes)||minutes<0||minutes>60)throw new RangeError('Simulation time must be between 0 and 60 minutes.');
    const target=minutes*60;this.engine.dispose();this.offset=0;this.engine=new TelemetryEngine(this.graph,{now:()=>this.baseTime+this.offset,enforceCoverage:false});
    for(const action of this.history.filter(item=>item.offset<=target).sort((a,b)=>a.offset-b.offset)){
      this.offset=action.offset;if(action.kind==='event'){const result=this.engine.ingest(action.payload);action.id=result.id;}else if(action.kind==='verify'){const original=this.history.find(item=>item.kind==='event'&&item.payload.event_id===action.eventId);if(original&&[...this.engine.metadata.values()].some(item=>item.id===original.id)){const result=this.engine.verify(original.id,action.action);original.id=result.id;}}else this.engine.passage(action.payload);
    }
    this.offset=target;return this.snapshot();
  }
  bypassTrack(offsetMeters,startOffset){
    const {center}=this.corridor,[a,b]=center.tangent;
    const scaleY=111195,scaleX=111195*Math.cos(center.lat*Math.PI/180);
    const dx=(b.lon-a.lon)*scaleX,dy=(b.lat-a.lat)*scaleY,length=Math.hypot(dx,dy),ux=dx/length,uy=dy/length;
    return Array.from({length:9},(_,i)=>{
      const along=-4+i;
      return {lat:center.lat+(uy*along+ux*offsetMeters)/scaleY,lng:center.lon+(ux*along-uy*offsetMeters)/scaleX,
        timestamp:this.baseTime+startOffset+i*.5,accuracy_meters:.1};
    });
  }
  run(name){
    const checks=[];
    if(name==='A'){
      this.seedShock();const motion=generatedMotion();const route=this.route();
      checks.push({name:'Gated impact candidate generated',passed:motion.candidates.length===1},
        {name:'Street X avoided via Street Y',passed:!route.edgeIds.includes(this.corridor.edge.id),detail:`${Math.round(this.corridor.baseline.distanceMeters)} m → ${Math.round(route.distanceMeters)} m`});
    }else if(name==='B'){
      const before=this.engine.events().length,motion=generatedMotion({tumble:true});
      const result=this.engine.ingest({device_id:'simulation',lat:this.corridor.center.lat,lng:this.corridor.center.lon,source:'web_motion',metric_type:'SENSOR_SHOCK',severity:1,timestamp:this.baseTime+this.offset,
        evidence:{gyro_deg_s:500,peak_acceleration:30,peak_jerk:900,fwhm_ms:20}});
      checks.push({name:'Client tumble gate suppresses the payload',passed:motion.candidates.length===0&&motion.dropped>0},
        {name:'Backend rejects high-G + high-gyro evidence',passed:!result.accepted&&result.reason==='bag-tumble'&&this.engine.events().length===before});
    }else if(name==='C'){
      this.seedShock();let preserved=true;
      for(let i=0;i<5;i++){
        const start=this.offset+1,trace=this.bypassTrack(1.2+i*.1,start);this.offset=start+4;
        const payload={device_id:`walker-${i}`,passage_id:`bypass-${i}`,trace,shock_detected:false};
        const result=this.engine.passage(payload);this.history.push({kind:'passage',offset:this.offset,payload});
        preserved&&=result.updates.some(update=>update.classification==='avoidance'&&update.updated);
      }
      checks.push({name:'Five independent bypasses reinforce the hazard',passed:preserved},
        {name:'The route still avoids Street X',passed:this.engine.events().length===1&&!this.route().edgeIds.includes(this.corridor.edge.id)});
    }else if(name==='D'){
      this.seedShock();const penalties=[];
      for(const minute of [15,30,60]){this.seek(minute);penalties.push(this.snapshot().events[0]?.remaining_penalty??0);}
      checks.push({name:'15 / 30 / 60 min decay is 25 / 12.5 / 3.125 m',passed:penalties.every((penalty,i)=>Math.abs(penalty-[25,12.5,3.125][i])<1e-6),detail:penalties.map(p=>`${p.toFixed(3)} m`).join(' / ')},
        {name:'Original path restored after decay',passed:this.route().edgeIds.includes(this.corridor.edge.id)});
    }else throw new Error('Unknown scenario.');
    const result={scenario:name,passed:checks.every(check=>check.passed),checks};this.results.push(result);return result;
  }
  snapshot(){return {...this.engine.snapshot(),simulation_minutes:this.offset/60,route:this.route(),corridor:{from:this.graph.nodes.get(this.corridor.edge.from),to:this.graph.nodes.get(this.corridor.edge.to),coordinate:this.corridor.center}};}
  dispose(){this.engine.dispose();}
}
