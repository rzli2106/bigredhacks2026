import { DynamicEdgeCosts, EdgeIndex, DisambiguationEngine, routeBetweenPins } from '../src/routing/index.js';
import { validateCoordinate } from '../src/routing/geo.js';
import { TELEMETRY_POLICY, shockRejection, unixSeconds } from '../src/telemetry/policy.js';
import { withinCornell } from '../src/ui/cornell.js';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class TelemetryEngine {
  constructor(graph, { now = () => Date.now()/1000, enforceCoverage = true, maxEvents = 5000 } = {}) {
    this.graph = graph; this.index = new EdgeIndex(graph); this.now = now; this.enforceCoverage = enforceCoverage; this.maxEvents = maxEvents;
    this.costs = new DynamicEdgeCosts(graph, { now, cleanupIntervalMs: 0 }); this.evidence = new DisambiguationEngine(this.costs);
    this.metadata = new Map(); this.dedup = new Map(); this.instanceId = globalThis.crypto.randomUUID(); this.revision = 0;
  }
  dispose() { this.costs.dispose(); }
  ingest(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ApiError(400,'Expected a telemetry object.');
    const { device_id, lat, lng, source, metric_type, severity, event_id } = payload;
    if (typeof device_id !== 'string' || !/^[\w:-]{1,80}$/.test(device_id)) throw new ApiError(400,'Invalid device_id.');
    if (!['web_motion','healthkit','health_connect','manual'].includes(source)) throw new ApiError(400,'Unknown source.');
    if (!Object.hasOwn(TELEMETRY_POLICY,metric_type)) throw new ApiError(400,'Unknown metric_type.');
    if (!Number.isFinite(severity) || severity <= 0 || severity > 1) throw new ApiError(400,'severity must be greater than 0 and at most 1.');
    try { validateCoordinate({lat,lon:lng}); } catch { throw new ApiError(400,'Invalid coordinate.'); }
    if (this.enforceCoverage && !withinCornell({lat,lon:lng})) throw new ApiError(422,'Outside Cornell coverage.');
    let timestamp;
    try { timestamp = unixSeconds(payload.timestamp); } catch (error) { throw new ApiError(400,error.message); }
    const now = this.now();
    if (timestamp > now + 5 || now - timestamp > 120) throw new ApiError(422,'Telemetry must describe a location observed within the last two minutes.');
    if (source === 'manual' && !['MANUAL_HAZARD','MANUAL_CLOSURE','TERRAIN_DRAG'].includes(metric_type)) throw new ApiError(400,'Manual reports cannot claim sensor shocks.');
    if (source !== 'manual' && metric_type.startsWith('MANUAL_')) throw new ApiError(400,'Closures and manual hazards require a manual report.');
    if (source !== 'web_motion' && metric_type === 'SENSOR_SHOCK') throw new ApiError(400,'SENSOR_SHOCK requires raw web motion evidence.');
    if (metric_type === 'SENSOR_SHOCK') {
      const reason = shockRejection(payload.evidence);
      if (reason) return { accepted:false, reason };
    }
    if (payload.accuracy_meters !== undefined && (!Number.isFinite(payload.accuracy_meters) || payload.accuracy_meters < 0 || payload.accuracy_meters > 50)) throw new ApiError(422,'Location accuracy must be at most 50 m.');
    if (event_id !== undefined && (typeof event_id !== 'string' || !/^[\w:-]{1,100}$/.test(event_id))) throw new ApiError(400,'Invalid event_id.');
    this.prune();
    const key = event_id ? `${device_id}:${event_id}` : null;
    if (key && this.dedup.has(key)) return { accepted:true, duplicate:true, id:this.dedup.get(key).id };
    if (this.metadata.size >= this.maxEvents) throw new ApiError(429,'Active event capacity reached. Retry after evidence expires.');
    const match = this.index.nearest({lat,lon:lng},{maxDistanceMeters:40});
    if (!match) throw new ApiError(422,'No walking path is within 40 m.');
    const policy = TELEMETRY_POLICY[metric_type];
    const event = this.costs.recordEvent(match.edgeIds, { event_type:policy.event_type, initial_penalty:policy.penalty === Infinity ? Infinity : policy.penalty * severity,
      half_life:policy.halfLife, timestamp, coordinate:{lat,lng}, closure_max:14400 });
    const id = `${this.instanceId}:${event.id}`;
    this.metadata.set(event.id,{id,metric_type,source,edgeIds:match.edgeIds});
    if (key) this.dedup.set(key,{id,time:now});
    this.revision++;
    return {accepted:true,id,coordinate:{lat,lng},snapped_coordinate:{lat:match.coordinate.lat,lng:match.coordinate.lon},edge_ids:match.edgeIds};
  }
  passage(payload) {
    if (!payload || typeof payload.device_id !== 'string' || !/^[\w:-]{1,80}$/.test(payload.device_id) || typeof payload.passage_id !== 'string' || !/^[\w:-]{1,100}$/.test(payload.passage_id)) throw new ApiError(400,'Invalid passage identifiers.');
    if (!Array.isArray(payload.trace) || payload.trace.length < 3 || payload.trace.length > 300) throw new ApiError(400,'A passage requires 3–300 trace points.');
    const trace = payload.trace.map(point => {
      try { validateCoordinate({lat:point.lat,lon:point.lng}); } catch { throw new ApiError(400,'Invalid trace coordinate.'); }
      if (!Number.isFinite(point.accuracy_meters) || point.accuracy_meters < 0) throw new ApiError(400,'Every trace point needs accuracy_meters.');
      if (this.enforceCoverage && !withinCornell({lat:point.lat,lon:point.lng})) throw new ApiError(422,'Trace is outside Cornell coverage.');
      let timestamp;try{timestamp=unixSeconds(point.timestamp);}catch(error){throw new ApiError(400,error.message);}
      return {lat:point.lat,lon:point.lng,timestamp,accuracyMeters:point.accuracy_meters};
    });
    if (typeof payload.shock_detected !== 'boolean') throw new ApiError(400,'Explicit shock_detected evidence is required.');
    const match = this.index.nearest(trace[Math.floor(trace.length/2)],{maxDistanceMeters:40});
    if (!match) throw new ApiError(422,'Passage is outside the walking network.');
    const observation = this.evidence.observeTrajectory(match.edgeIds[0],{observerId:payload.device_id,passageId:`${payload.device_id}:${payload.passage_id}`,trace,shockDetected:payload.shock_detected,mobilityMode:'pedestrian'},this.now());
    const result={...observation.passage,spatial:observation.spatial};
    if (result.updates.some(update => update.updated)||observation.spatial.updatedEventIds.length||observation.spatial.classification==='congestion') this.revision++;
    return result;
  }
  events() {
    const events = new Map();
    for (const list of this.costs.EdgeEventList.values()) for (const event of list) events.set(event.id,event);
    return [...events.values()];
  }
  prune() {
    this.costs.prune(this.now()); this.evidence.prune(this.now());
    const ids = new Set(this.events().map(event => event.id));
    for (const id of this.metadata.keys()) if (!ids.has(id)) this.metadata.delete(id);
    for (const [id,item] of this.dedup) if (this.now()-item.time > 14400) this.dedup.delete(id);
  }
  snapshot() {
    this.prune(); const now=this.now(); const edges=new Map();
    const events=this.events().map(event => {
      const item=this.metadata.get(event.id);
      if (!item) return null;
      const blocked=event.initial_penalty === Infinity;
      const fraction=blocked?1:2**(-Math.max(0,now-event.timestamp)/event.half_life);
      for (const id of item.edgeIds) {
        const cost=this.costs.weight(id,now),edge=this.graph.edges.get(id);
        edges.set(id,{id,base_distance:edge.distanceMeters,cost:Number.isFinite(cost)?cost:null,blocked:cost===Infinity});
      }
      // Public stream contains derived hazards only, never device IDs or health measurements.
      return {id:item.id,coordinate:event.coordinate,metric_type:item.metric_type,source:item.source,
        timestamp:event.timestamp,half_life:event.half_life,initial_penalty:blocked?null:event.initial_penalty,
        remaining_penalty:blocked?null:event.initial_penalty*fraction,fraction,blocked,edge_ids:item.edgeIds};
    }).filter(Boolean);
    for(const edge of this.graph.edges.values()){const congestion=this.costs.getCongestion(edge.id,now);if(congestion)edges.set(edge.id,{id:edge.id,base_distance:edge.distanceMeters,cost:this.costs.weight(edge.id,now),blocked:false,congestion:{walkingSpeedMps:congestion.walkingSpeedMps,timestamp:congestion.timestamp,expiresAt:congestion.expiresAt}});}
    return {type:'snapshot',instance_id:this.instanceId,revision:this.revision,time:now,events,edges:[...edges.values()]};
  }
  route(from,to) { return routeBetweenPins(this.graph,this.index,from,to,{costs:this.costs,timestamp:this.now()}); }
  verify(id,action) {
    const item=[...this.metadata.entries()].find(([,meta])=>meta.id===id);
    if (!item) throw new ApiError(404,'Report no longer exists.');
    const [internalId,meta]=item;let verifiedId=id;
    if (action==='resolve') { this.costs.removeEvent(internalId); this.metadata.delete(internalId); }
    else if (action==='confirm') {
      const event=this.events().find(event=>event.id===internalId);
      if (event.initial_penalty===Infinity) {
        const renewed=this.costs.recordEvent(meta.edgeIds,{...event,timestamp:this.now()});
        this.costs.removeEvent(internalId);this.metadata.delete(internalId);verifiedId=`${this.instanceId}:${renewed.id}`;this.metadata.set(renewed.id,{...meta,id:verifiedId});
      } else this.costs.adjustEvent(internalId,'avoidance',this.now());
    } else throw new ApiError(400,'Unknown verification action.');
    this.revision++; return {accepted:true,id:verifiedId};
  }
}
