const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
/** Raw health measurements stay on the phone. Only matched, derived anomalies leave it. */
export class HealthAnalyzer {
  constructor(){this.history=new Map();this.seen=new Set();this.lastEvent=-Infinity;this.cadence=[];}
  ingest(samples,locations,now=Date.now()/1000){
    const events=[];
    for(const sample of samples)if(sample.metric==='steps'&&!this.seen.has(sample.id)&&Number.isFinite(sample.value)&&sample.value>=0&&Number.isFinite(sample.start)&&Number.isFinite(sample.end)){const duration=sample.end-sample.start;if(duration>0&&duration<=60)this.cadence.push({start:sample.start,end:sample.end,value:sample.value/duration});}
    this.cadence=this.cadence.slice(-30);
    for(const sample of [...samples].sort((a,b)=>a.end-b.end)){
      if(this.seen.has(sample.id))continue;this.seen.add(sample.id);
      if(this.seen.size>2000)this.seen.delete(this.seen.values().next().value);
      if(!Number.isFinite(sample.value)||!Number.isFinite(sample.end)||sample.value<0)continue;
      if(sample.metric==='steps')continue;
      const history=this.history.get(sample.metric)??[];
      const baseline=history.length>=5?median(history):null;
      history.push(sample.value);if(history.length>15)history.shift();this.history.set(sample.metric,history);
      // Delayed or aggregated records cannot be assigned to a present-day coordinate.
      if(now-sample.end>120||sample.end>now+5||sample.end-sample.start>60||baseline===null||baseline<=0)continue;
      const cadence=this.cadence.find(point=>point.start<=sample.end&&point.end>=sample.end-5);
      if(cadence&&cadence.value===0)continue; // A confirmed stop is not terrain drag.
      const severity=sample.metric==='asymmetry'?(sample.value-baseline)/baseline:sample.metric==='speed'?(baseline-sample.value)/baseline:0;
      const threshold=sample.metric==='asymmetry'?.15:.5;
      if(severity<=threshold||sample.end-this.lastEvent<30)continue;
      const location=locations.filter(point=>point.accuracyMeters<=20&&Math.abs(point.timestamp-sample.end)<=5).sort((a,b)=>Math.abs(a.timestamp-sample.end)-Math.abs(b.timestamp-sample.end))[0];
      if(!location)continue;
      this.lastEvent=sample.end;
      events.push({lat:location.lat,lng:location.lon,accuracy_meters:location.accuracyMeters,source:sample.source,metric_type:'TERRAIN_DRAG',severity:Math.min(1,Math.max(.25,severity)),timestamp:sample.end});
    }
    return events;
  }
}
