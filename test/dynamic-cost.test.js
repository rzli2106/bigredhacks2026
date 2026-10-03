import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamicEdgeCosts, shortestPath, buildWalkingGraph } from '../src/routing/index.js';

const T = 1700000000;
const report = (overrides = {}) => ({
  event_type: 'POTHOLE', timestamp: T, coordinate: { lat: 42.44, lng: -76.48 }, ...overrides,
});
function graphFixture() {
  const graph = { nodes: new Map(), edges: new Map(), adjacency: new Map() };
  for (const id of ['a', 'b', 'c', 'd']) { graph.nodes.set(id, { id }); graph.adjacency.set(id, []); }
  for (const [id, from, to, distanceMeters] of [
    ['ab', 'a', 'b', 10], ['ba', 'b', 'a', 10], ['bd', 'b', 'd', 10],
    ['ac', 'a', 'c', 30], ['cd', 'c', 'd', 30],
  ]) {
    graph.edges.set(id, { id, from, to, distanceMeters, baselineCostSeconds: distanceMeters / 1.3 });
    graph.adjacency.get(from).push(id);
  }
  return graph;
}
const store = (graph = graphFixture(), options = {}) => new DynamicEdgeCosts(graph, { now: () => T, cleanupIntervalMs: 0, ...options });

test('base costs use meters, and multiple event penalties add and halve independently', () => {
  const costs = store();
  assert.equal(costs.weight('ab'), 10);
  costs.recordEvent('ab', report());
  costs.recordEvent('ab', report({ event_type: 'MANUAL_HAZARD', initial_penalty: 300, half_life: 3600 }));
  assert.equal(costs.weight('ab', T), 360);
  assert.ok(Math.abs(costs.weight('ab', T + 1800) - (10 + 25 + 300 / Math.sqrt(2))) < 1e-10);
  assert.equal(costs.weight('ab', T + 3600), 172.5);
  assert.equal(costs.weight('ba', T + 3600), 10);
});

test('all event types have defaults and support valid overrides', () => {
  const costs = store();
  for (const event_type of ['POTHOLE', 'MUD', 'MANUAL_HAZARD', 'MANUAL_CLOSURE']) {
    const event = costs.recordEvent('ab', report({ event_type }));
    assert.ok(event.initial_penalty > 0);
    assert.ok(event.half_life > 0);
  }
  assert.equal(costs.weight('ab', T), Infinity);
});

test('hard closure is impassable until its exact maximum duration and never yields NaN', () => {
  const costs = store(undefined, { closureMaxSeconds: 100 });
  costs.recordEvent('ab', report({ event_type: 'MANUAL_CLOSURE' }));
  costs.recordEvent('ab', report());
  assert.equal(costs.weight('ab', T + 99.999), Infinity);
  assert.ok(Number.isFinite(costs.weight('ab', T + 100)));
  assert.equal(costs.getEvents('ab').length, 1);
  assert.equal(costs.weight('ab', T + 1e9), 10);
});

test('overlapping closures expire independently and accept per-event closure_max', () => {
  const costs = store();
  costs.recordEvent('ab', report({ event_type: 'MANUAL_CLOSURE', closure_max: 100 }));
  costs.recordEvent('ab', report({ event_type: 'MANUAL_CLOSURE', timestamp: T + 50, closure_max: 100 }));
  assert.equal(costs.weight('ab', T + 100), Infinity);
  assert.equal(costs.weight('ab', T + 150), 10);
});

test('finite penalties are retained at exactly 1% and pruned below it', () => {
  const costs = store();
  // Zero epoch avoids cancellation from adding fractional ages to a large epoch.
  costs.recordEvent('ab', report({ timestamp: 0, half_life: 1 }));
  const expiry = Math.log2(100);
  assert.equal(costs.weight('ab', expiry), 10.5);
  assert.equal(costs.getEvents('ab').length, 1);
  assert.equal(costs.weight('ab', expiry + 0.000001), 10);
  assert.equal(costs.getEvents('ab').length, 0);
});

test('future observations are inactive and retained until their occurrence time', () => {
  const costs = store();
  costs.recordEvent('ab', report({ timestamp: T + 100 }));
  costs.recordEvent('ba', report({ timestamp: T + 100, event_type: 'MANUAL_CLOSURE' }));
  assert.equal(costs.weight('ab', T), 10);
  assert.equal(costs.weight('ba', T), 10);
  assert.equal(costs.prune(T), 0);
  assert.equal(costs.weight('ab', T + 100), 60);
  assert.equal(costs.weight('ba', T + 100), Infinity);
});

test('multi-edge attachment is atomic, deduplicates edge IDs, and preserves exact coordinate', () => {
  const costs = store();
  const input = report();
  const event = costs.recordEvent(['ab', 'ba', 'ab'], input);
  input.coordinate.lat = 0;
  assert.equal(event.coordinate.lat, 42.44);
  assert.equal(costs.getEvents('ab').length, 1);
  assert.equal(costs.getEvents('ba')[0], event);
  assert.throws(() => costs.recordEvent(['ab', 'unknown'], report()), /Unknown graph edge/);
  assert.equal(costs.getEvents('ab').length, 1);
  costs.EdgeEventList.get('ab').pop();
  assert.equal(costs.getEvents('ab').length, 1);
  assert.throws(() => { event.half_life = 0; }, TypeError);
});

test('validation rejects malformed evidence, invalid clocks and unknown edges', () => {
  const costs = store();
  for (const overrides of [
    { event_type: 'UNKNOWN' }, { event_type: '__proto__' }, { initial_penalty: -1 },
    { initial_penalty: NaN }, { initial_penalty: Infinity }, { half_life: 0 },
    { timestamp: NaN }, { coordinate: { lat: 100, lng: 0 } },
    { coordinate: { lat: 42, lon: -76 } }, { closure_max: -1 },
  ]) assert.throws(() => costs.recordEvent('ab', report(overrides)));
  assert.equal(costs.getEvents('ab').length, 0);
  assert.throws(() => costs.weight('unknown'));
  assert.throws(() => costs.weight('ab', -1));
  assert.throws(() => store(undefined, { now: () => NaN }));
});

test('full sweep removes stale events from unvisited edges, counting attachments', () => {
  const costs = store();
  costs.recordEvent(['ab', 'ba'], report({ half_life: 1 }));
  assert.equal(costs.prune(T + 7), 2);
  assert.equal(costs.getEvents('ba').length, 0);
});

test('periodic cleanup sweeps idle edges and dispose stops maintenance', async (t) => {
  let now = T;
  const costs = store(undefined, { now: () => now, cleanupIntervalMs: 5 });
  t.after(() => costs.dispose());
  costs.recordEvent('ab', report({ half_life: 1 }));
  now += 10;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(costs.getEvents('ab').length, 0);
  costs.dispose();
  costs.recordEvent('ab', report({ half_life: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(costs.getEvents('ab').length, 1);
});

test('route switches to detour after a report and returns as evidence decays', () => {
  const graph = graphFixture();
  const costs = store(graph);
  assert.deepEqual(shortestPath(graph, 'a', 'd').edgeIds, ['ab', 'bd']);
  costs.recordEvent('ab', report());
  const detour = shortestPath(graph, 'a', 'd', { costs, timestamp: T });
  assert.deepEqual(detour.edgeIds, ['ac', 'cd']);
  assert.equal(detour.costMeters, 60);
  const recovered = shortestPath(graph, 'a', 'd', { costs, timestamp: T + 1800 });
  assert.deepEqual(recovered.edgeIds, ['ab', 'bd']);
  assert.equal(recovered.costMeters, 45);
  assert.equal(recovered.distanceMeters, 20);
});

test('closures make routes unreachable; expiry restores them', () => {
  const graph = graphFixture();
  const costs = store(graph, { closureMaxSeconds: 100 });
  costs.recordEvent(['ab', 'ac'], report({ event_type: 'MANUAL_CLOSURE' }));
  assert.equal(shortestPath(graph, 'a', 'd', { costs, timestamp: T }), null);
  assert.deepEqual(shortestPath(graph, 'a', 'd', { costs, timestamp: T + 100 }).nodeIds, ['a', 'b', 'd']);
  assert.equal(shortestPath(graph, 'd', 'a'), null);
  assert.deepEqual(shortestPath(graph, 'a', 'a').edgeIds, []);
});

test('a routing request reads its clock once for consistent decay across edges', () => {
  let calls = 0;
  const graph = graphFixture();
  const costs = store(graph, { now: () => { calls++; return T + calls; } });
  costs.recordEvent('ab', report());
  calls = 0;
  shortestPath(graph, 'a', 'd', { costs });
  assert.equal(calls, 1);
  assert.throws(() => shortestPath(graph, 'a', 'd', { costs: store() }), /different graph/);
});

test('OSM graph, bidirectional registry attachment and routing integrate', () => {
  const graph = buildWalkingGraph({ elements: [
    { type: 'node', id: 1, lat: 42.44, lon: -76.48 },
    { type: 'node', id: 2, lat: 42.441, lon: -76.48 },
    { type: 'way', id: 3, nodes: [1, 2], tags: { highway: 'footway' } },
  ] });
  const costs = store(graph);
  costs.recordEvent(graph.segments[0].edgeIds, report({ event_type: 'MANUAL_CLOSURE' }));
  assert.equal(shortestPath(graph, 1, 2, { costs, timestamp: T }), null);
  assert.equal(shortestPath(graph, 2, 1, { costs, timestamp: T }), null);
});
