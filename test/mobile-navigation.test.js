import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWalkingGraph, EdgeIndex, DynamicEdgeCosts, haversine } from '../src/routing/index.js';
import { walkingRouteOptions } from '../src/routing/route-options.js';
import { SHOCK_GATE, shockRejection } from '../src/telemetry/policy.js';
import { SensorPipeline, DEFAULT_CONFIG } from '../src/sensor-pipeline.js';
import { TelemetryEngine } from '../backend/engine.js';
import { createTelemetryServer } from '../backend/server.js';
import { ScenarioRunner } from '../backend/simulator.js';
import { readFile } from 'node:fs/promises';
import { RouteAlerts, hazardAhead, resolvePlace, etaDelta, remainingSeconds, routeHasClosure } from '../frontend/navigation-state.js';

function fixture(alternative = true) {
  const nodes = [{ id: 1, lat: 42.445, lon: -76.485 }, { id: 2, lat: 42.445, lon: -76.484 },
    { id: 3, lat: 42.4455, lon: -76.485 }, { id: 4, lat: 42.4455, lon: -76.484 }];
  const graph = buildWalkingGraph({ elements: [...nodes.map(node => ({ type: 'node', ...node })),
    { type: 'way', id: 10, nodes: [1,2], tags: { highway: 'footway' } },
    ...(alternative ? [{ type: 'way', id: 20, nodes: [1,3,4,2], tags: { highway: 'footway' } }] : [])] });
  return { graph, index: new EdgeIndex(graph), from: nodes[0], to: nodes[1] };
}
test('impact thresholds are reduced exactly 15% and retain strict boundary rejection', () => {
  assert.equal(SHOCK_GATE.jerkThreshold, 85 * .85); assert.equal(SHOCK_GATE.accelerationThreshold, 16 * .85);
  assert.equal(DEFAULT_CONFIG.jerkThreshold, 72.25); assert.equal(SHOCK_GATE.gyroLimitDegS, 300); assert.equal(SHOCK_GATE.maxFwhmMs, 45);
  const evidence = { gyro_deg_s: 0, peak_jerk: 80, peak_acceleration: 14, fwhm_ms: 20 };
  assert.equal(shockRejection(evidence), null);
  assert.equal(shockRejection({ ...evidence, peak_jerk: 72.25 }), 'low-jerk');
  assert.equal(shockRejection({ ...evidence, peak_acceleration: 13.6 }), 'low-impact');
  const pipeline = new SensorPipeline(); let candidates = [];
  // Rise of 1.5 m/s² in 20 ms is jerk 75, below the old 85 cutoff.
  [...Array(12).fill(13), 13, 14.5, 13].forEach((z, i) => { candidates.push(...pipeline.push({ timestamp: i * 20,
    accelerationIncludingGravity: { x: 0, y: 0, z }, rotationRate: { alpha: 0, beta: 0, gamma: 0 } }).candidates); });
  assert.equal(candidates.length, 1); assert.ok(candidates[0].peakJerk > 72.25 && candidates[0].peakJerk < 85);
});
test('two distinct routes have physical walking ETAs; active hazards are strictly excluded from the alternative', () => {
  const { graph, index, from, to } = fixture(), costs = new DynamicEdgeCosts(graph, { cleanupIntervalMs: 0 });
  try {
    let options = walkingRouteOptions(graph, index, from, to, { costs, timestamp: 100 });
    assert.equal(options.direct.status, 'ok'); assert.equal(options.alternative.status, 'ok');
    assert.ok(options.alternative.distanceMeters > options.direct.distanceMeters);
    assert.ok(Math.abs(options.direct.durationSeconds - options.direct.distanceMeters / graph.walkingSpeedMps) < .01);
    const blocked = graph.segments[0].edgeIds;
    costs.recordEvent(blocked, { event_type: 'MANUAL_CLOSURE', timestamp: 100, coordinate: { lat: from.lat, lng: from.lon } });
    options = walkingRouteOptions(graph, index, from, to, { costs, timestamp: 100, events: [{ id: 'closure', edge_ids: blocked }] });
    assert.deepEqual(options.direct.hazard_ids, ['closure']);
    assert.equal(options.alternative.edgeIds.some(id => blocked.includes(id)), false);
    assert.deepEqual(options.alternative.hazard_ids, []);
    assert.ok(Number.isFinite(options.alternative.durationSeconds));
  } finally { costs.dispose(); }
});
test('route options handle unreachable alternatives, off-path origins, identical endpoints, and expired hazards', () => {
  const { graph, index, from, to } = fixture(false);
  assert.equal(walkingRouteOptions(graph, index, from, to).alternative, null);
  assert.equal(walkingRouteOptions(graph, index, { lat: 0, lon: 0 }, to).direct.status, 'off-path');
  assert.equal(walkingRouteOptions(graph, index, from, from).direct.durationSeconds, 0);
  const engine = new TelemetryEngine(graph, { now: () => 100 });
  try {
    engine.ingest({ device_id: 'phone', source: 'manual', metric_type: 'MANUAL_CLOSURE', hazard_category: 'closure', severity: 1, timestamp: 100,
      lat: from.lat, lng: from.lon, event_id: 'closure' });
    const blocked = engine.routeOptions(from, to); assert.equal(blocked.alternative, null); assert.equal(blocked.direct.hazard_ids.length, 1);
    assert.equal(blocked.direct.blocked, true);
    assert.equal(routeHasClosure(blocked.direct, engine.snapshot().events), true);
    assert.equal(engine.snapshot().events[0].hazard_category, 'closure');
    assert.throws(() => engine.ingest({ device_id: 'phone', source: 'manual', metric_type: 'MANUAL_CLOSURE', hazard_category: 'pothole', severity: 1, timestamp: 100, lat: from.lat, lng: from.lon }));
    engine.now = () => 14500; assert.equal(engine.routeOptions(from, to).direct.hazard_ids.length, 0);
    assert.equal(engine.routeOptions(from, to).direct.blocked, false);
  } finally { engine.dispose(); }
});
test('alerts only fire once for new intersecting hazards ahead; dismissing does not retrigger on decay', () => {
  const route = { status: 'ok', edgeIds: ['street'], geometry: [{ lat: 42.445, lon: -76.485 }, { lat: 42.445, lon: -76.483 }], durationSeconds: 120,
    distanceMeters: haversine({ lat: 42.445, lon: -76.485 }, { lat: 42.445, lon: -76.483 }) };
  const now = Date.now() / 1000, location = { lat: 42.445, lon: -76.484, timestamp: now, accuracyMeters: 3 };
  const behind = { id: 'behind', timestamp: now, edge_ids: ['street'], coordinate: { lat: 42.445, lng: -76.4848 } };
  const ahead = { ...behind, id: 'ahead', coordinate: { lat: 42.445, lng: -76.4832 } };
  assert.equal(hazardAhead(route, behind, location), false); assert.equal(hazardAhead(route, ahead, location), true);
  assert.ok(Math.abs(remainingSeconds(route, location) - 60) < 1);
  const alerts = new RouteAlerts();
  assert.deepEqual(alerts.observe({ instance_id: 'server', events: [] }, route, location), []);
  const snapshot = { instance_id: 'server', events: [behind, ahead, { ...ahead, id: 'elsewhere', edge_ids: ['other'] }] };
  assert.deepEqual(alerts.observe(snapshot, route, location).map(event => event.id), ['ahead']);
  assert.deepEqual(alerts.observe(snapshot, route, location), []);
  // Input route never mutates while a decision is pending.
  assert.deepEqual(route.edgeIds, ['street']);
  assert.equal(etaDelta({ durationSeconds: 181 }, { durationSeconds: 120 }), 2);
  assert.equal(etaDelta({ durationSeconds: 80 }, { durationSeconds: 120 }), 0);
});
test('place resolution supports live GPS, campus landmarks and pinned coordinates with coverage validation', () => {
  const fix = { lat: 42.4468, lon: -76.485, timestamp: Date.now() / 1000 };
  assert.deepEqual(resolvePlace('My live location', fix), { lat: fix.lat, lon: fix.lon });
  assert.deepEqual(resolvePlace('Ho Plaza'), { lat: fix.lat, lon: fix.lon });
  assert.deepEqual(resolvePlace('42.4468, -76.485'), { lat: fix.lat, lon: fix.lon });
  assert.throws(() => resolvePlace('0, 0')); assert.throws(() => resolvePlace('My live location', { ...fix, timestamp: 1 }));
  assert.throws(() => resolvePlace('unknown place'));
});
test('HTTP options endpoint returns both routes and report categories without exposing device identifiers', async t => {
  const { graph, from, to } = fixture(), service = await createTelemetryServer({ graph, now: () => 100 });
  t.after(() => service.close()); const address = await service.listen(0), base = `http://127.0.0.1:${address.port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${service.adminToken}` }, body: JSON.stringify(body) });
  const options = await (await post('/api/route/options', { from, to })).json();
  assert.equal(options.direct.status, 'ok'); assert.equal(options.alternative.status, 'ok');
  assert.equal((await post('/api/route/options', { from: { lat: 'bad' }, to })).status, 400);
  const response = await post('/api/telemetry/event', { device_id: 'private-phone', event_id: 'report-1', source: 'manual', metric_type: 'MANUAL_HAZARD', hazard_category: 'pothole', severity: 1, timestamp: 100,
    lat: 42.445, lng: -76.4845, accuracy_meters: 4 });
  assert.equal(response.status, 201); const snapshot = service.engine.snapshot();
  assert.equal(snapshot.events[0].hazard_category, 'pothole'); assert.equal(JSON.stringify(snapshot).includes('private-phone'), false);
  const update = await (await post('/api/route/options', { from, to })).json(); assert.equal(update.alternative.hazard_ids.length, 0);
  assert.equal(update.direct.blocked, false);
  assert.equal(routeHasClosure(update.direct, snapshot.events), false);
});

test('real campus detours do not claim hazards on zero-length junction connectors', async () => {
  const graph=buildWalkingGraph(JSON.parse(await readFile(new URL('../public/cornell-osm.json',import.meta.url),'utf8'))),runner=new ScenarioRunner(graph);
  try {
    runner.seedShock();
    const from=graph.nodes.get(runner.corridor.edge.from),to=graph.nodes.get(runner.corridor.edge.to);
    const result=runner.engine.routeOptions(from,to);
    assert.equal(result.direct.hazard_ids.length,1); assert.equal(result.alternative.status,'ok');
    assert.equal(result.alternative.hazard_ids.length,0);
    assert.equal(result.alternative.edgeIds.some(id=>runner.corridor.segment.edgeIds.includes(id)),false);
  } finally { runner.dispose(); }
});
