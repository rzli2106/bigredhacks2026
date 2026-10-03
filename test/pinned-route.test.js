import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildWalkingGraph, EdgeIndex, DynamicEdgeCosts, routeBetweenPins, haversine } from '../src/routing/index.js';
import { CORNELL_PLACES, withinCornell } from '../src/ui/cornell.js';
import { fetchCampus } from '../src/ui/campus-data.js';

function fixture(tags = {}, bend = false) {
  const points = [{ id: 1, lat:42.44, lon:-76.48 }, { id:2, lat:42.44, lon:-76.479 }, { id:3,lat:42.441,lon:-76.479 }];
  const graph = buildWalkingGraph({ elements:[...points.map(p => ({ type:'node',...p })),
    { type:'way',id:10,nodes:bend?[1,2,3]:[1,2],tags:{ highway:'footway',...tags }}] });
  return { graph,index:new EdgeIndex(graph), from:{lat:42.44,lon:-76.4798},to:bend?{lat:42.4408,lon:-76.479}:{lat:42.44,lon:-76.4792} };
}
test('pins on the same segment use only the portion between them in either direction', () => {
  const {graph,index,from,to}=fixture();
  for (const [a,b] of [[from,to],[to,from]]) {
    const result=routeBetweenPins(graph,index,a,b);
    assert.equal(result.status,'ok'); assert.ok(Math.abs(result.distanceMeters-haversine(a,b))<0.01);
    assert.ok(haversine(result.geometry[0],a)<0.01); assert.ok(haversine(result.geometry.at(-1),b)<0.01);
  }
  assert.equal(graph.nodes.size,2); assert.equal(graph.edges.size,2);
});
test('pin routing preserves bends and pedestrian one-way restrictions', () => {
  const {graph,index,from,to}=fixture({'oneway:foot':'yes'},true);
  const result=routeBetweenPins(graph,index,from,to);
  assert.equal(result.status,'ok'); assert.equal(result.geometry.length,3);
  assert.ok(result.distanceMeters > haversine(from,to));
  assert.equal(routeBetweenPins(graph,index,to,from).status,'unreachable');
});
test('closures block partial segments; expiry restores them without NaN costs', () => {
  const {graph,index,from,to}=fixture(); const costs=new DynamicEdgeCosts(graph,{cleanupIntervalMs:0});
  costs.recordEvent(graph.segments[0].edgeIds,{event_type:'MANUAL_CLOSURE',timestamp:100,coordinate:{lat:from.lat,lng:from.lon},closure_max:10});
  assert.equal(routeBetweenPins(graph,index,from,to,{costs,timestamp:105}).status,'unreachable');
  const result=routeBetweenPins(graph,index,from,to,{costs,timestamp:110}); assert.equal(result.status,'ok');assert.ok(Number.isFinite(result.costMeters));costs.dispose();
});
test('off-path endpoints are identified and identical off-center pins have zero traversal', () => {
  const {graph,index,from,to}=fixture();
  assert.equal(routeBetweenPins(graph,index,{lat:41,lon:-75},to).endpoint,'origin');
  assert.equal(routeBetweenPins(graph,index,from,{lat:41,lon:-75}).endpoint,'destination');
  const near={...from,lat:from.lat+0.0001};const same=routeBetweenPins(graph,index,near,near);assert.equal(same.distanceMeters,0);assert.equal(same.durationSeconds,0);
  const result=routeBetweenPins(graph,index,near,to); assert.ok(result.fromOffsetMeters>10); assert.ok(result.distanceMeters>haversine(from,to));
});
test('the actual Cornell snapshot routes all 25 campus landmark pairs with finite metrics', async () => {
  const data=JSON.parse(await readFile(new URL('../public/cornell-osm.json',import.meta.url),'utf8'));
  const graph=buildWalkingGraph(data),index=new EdgeIndex(graph);
  assert.ok(graph.edges.size>1000);
  for (const a of CORNELL_PLACES) for (const b of CORNELL_PLACES) {
    assert.equal(withinCornell(a),true); const result=routeBetweenPins(graph,index,a,b);
    assert.equal(result.status,'ok',`${a.name} → ${b.name}`);assert.ok(Number.isFinite(result.distanceMeters));assert.ok(Number.isFinite(result.durationSeconds));
    if (a === b) assert.equal(result.distanceMeters,0);
  }
  assert.equal(withinCornell({lat:40.7128,lon:-74.006}),false);
});
test('campus loading uses the local snapshot and falls back after failed or invalid API responses', async () => {
  const data={elements:[{type:'node'}],waymark:{fetchedAt:'2026-10-03T00:00:00Z'}};
  for (const failed of ['http','schema','network']) {
    const urls=[];
    const result=await fetchCampus({fetchImpl:async url => {
      urls.push(url);
      if (urls.length===1) {
        if (failed==='network') throw new Error('Offline');
        return {ok:failed!=='http',status:503,json:async()=>({elements:[]})};
      }
      return {ok:true,json:async()=>data};
    }});
    assert.deepEqual(result,data);assert.deepEqual(urls,['/api/cornell-map','/public/cornell-osm.json']);
  }
});
test('complete map loading failure provides an actionable retry error', async () => {
  await assert.rejects(fetchCampus({fetchImpl:async()=>{throw new Error('Offline');}}),/Reload Cornell map.*Offline/);
});

test('fresh GPS fixes at every campus landmark attach reports using the cached real graph', async () => {
  const { captureDeviceLocation, submitIncident } = await import('../src/ui/reporting.js');
  const data=JSON.parse(await readFile(new URL('../public/cornell-osm.json',import.meta.url),'utf8'));
  const graph=buildWalkingGraph(data),index=new EdgeIndex(graph),costs=new DynamicEdgeCosts(graph,{cleanupIntervalMs:0});
  const now=Date.now()/1000;
  try {
    for (const place of CORNELL_PLACES) {
      let calls=0;
      const location=await captureDeviceLocation({getCurrentPosition(success,fail,options) {
        calls++;assert.equal(options.maximumAge,0);assert.equal(options.enableHighAccuracy,true);
        success({coords:{latitude:place.lat,longitude:place.lon,accuracy:5},timestamp:now*1000});
      }});
      assert.equal(withinCornell(location),true);
      const report=submitIncident({category:'hazard',location,index,costs,now});
      assert.equal(report.event.coordinate.lat,place.lat);assert.equal(report.event.coordinate.lng,place.lon);assert.equal(calls,1);
    }
  } finally {costs.dispose();}
});
test('successful campus fetch needs only one same-origin request', async () => {
  const urls=[];
  await fetchCampus({fetchImpl:async url=>{urls.push(url);return {ok:true,json:async()=>({elements:[{type:'node'}],waymark:{fetchedAt:'2026-10-03T00:00:00Z'}})};}});
  assert.deepEqual(urls,['/api/cornell-map']);
});
