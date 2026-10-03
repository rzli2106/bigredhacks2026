import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWalkingGraph, DynamicEdgeCosts, DisambiguationEngine, analyzePassage, extractDeflections, spatialEntropy, shortestPath } from '../src/routing/index.js';
import { EARTH_RADIUS_M } from '../src/routing/geo.js';

const T = 1700000000;
const metersPerDegree = EARTH_RADIUS_M * Math.PI / 180;
const coordinate = (x, y = 0) => ({ lat: y / metersPerDegree, lon: x / metersPerDegree });
const obstacle = { lat: 0, lng: 0 };
const trace = (offset, accuracyMeters = 0) => Array.from({ length: 17 }, (_, i) => ({
  ...coordinate(-4 + i * 0.5, offset), timestamp: T + 98 + i * 0.1, accuracyMeters,
}));

function fixture(options = {}) {
  const graph = buildWalkingGraph({ elements: [
    { type: 'node', id: 1, ...coordinate(-20) },
    { type: 'node', id: 2, ...coordinate(20) },
    { type: 'node', id: 3, ...coordinate(0, 20) },
    { type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'footway' } },
    { type: 'way', id: 2, nodes: [1, 3, 2], tags: { highway: 'footway' } },
  ] });
  const costs = new DynamicEdgeCosts(graph, { now: () => T + 100, cleanupIntervalMs: 0 });
  const engine = new DisambiguationEngine(costs, options);
  const edgeIds = graph.segments[0].edgeIds;
  const hazard = (overrides = {}) => costs.recordEvent(edgeIds, {
    event_type: 'POTHOLE', timestamp: T, coordinate: obstacle, ...overrides,
  });
  return { graph, costs, engine, edgeIds, edgeId: edgeIds[0], hazard };
}

function deflections(f, positions, timestamp = T + 99) {
  positions.forEach(([x, y = 0], i) => {
    const result = f.engine.observeDeflection(f.edgeId, {
      id: String(i), observerId: `observer-${i % 3}`, ...coordinate(x, y), timestamp, accuracyMeters: 0.1,
    }, T + 100);
    assert.equal(result.accepted, true);
  });
}

test('continuous polyline distance and exact geometric boundaries classify passages', () => {
  for (const [offset, expected] of [[0, 'clearance'], [0.8, 'clearance'], [0.81, 'avoidance'], [2.5, 'avoidance'], [2.51, 'inconclusive']]) {
    const result = analyzePassage(trace(offset), obstacle);
    assert.equal(result.classification, expected);
    assert.ok(Math.abs(result.distanceMeters - offset) < 1e-8);
  }
  // Hazard falls BETWEEN location samples, rather than on a sampled point.
  const result = analyzePassage(trace(0).map((point) => ({ ...point, lon: point.lon + 0.25 / metersPerDegree })), obstacle);
  assert.equal(result.distanceMeters, 0);
});

test('position uncertainty, partial traces, gaps and impossible speeds are inconclusive', () => {
  assert.equal(analyzePassage(trace(0.7, 0.2), obstacle).classification, 'inconclusive');
  assert.equal(analyzePassage(trace(0, 5), obstacle).classification, 'inconclusive');
  const partial = trace(0).slice(0, 9);
  assert.equal(analyzePassage(partial, obstacle).reason, 'incomplete-passage');
  const missing = trace(0).map(({ accuracyMeters, ...point }) => point);
  assert.equal(analyzePassage(missing, obstacle).reason, 'missing-trace-quality');
  const gap = trace(0); gap[5].timestamp += 1;
  assert.equal(analyzePassage(gap, obstacle).reason, 'trace-gap-or-order');
  const teleport = trace(0); teleport[5].lon += 100 / metersPerDegree;
  assert.equal(analyzePassage(teleport, obstacle).reason, 'implausible-speed');
});

test('direct clearance halves remaining penalty across both directed attachments', () => {
  const f = fixture();
  const original = f.hazard();
  const time = trace(0).at(-1).timestamp;
  const before = f.costs.weight(f.edgeId, time) - f.graph.edges.get(f.edgeId).distanceMeters;
  const result = f.engine.observePassage(f.edgeId, { passageId: 'p1', trace: trace(0), shockDetected: false }, T + 100);
  assert.equal(result.updates[0].classification, 'clearance');
  for (const id of f.edgeIds) {
    assert.equal(f.costs.getEvents(id)[0].timestamp, original.timestamp - original.half_life);
    const after = f.costs.weight(id, time) - f.graph.edges.get(id).distanceMeters;
    assert.ok(Math.abs(after - before / 2) < 1e-10);
  }
  assert.equal(f.engine.observePassage(f.edgeIds[1], { passageId: 'p1', trace: trace(0), shockDetected: false }, T + 100).status, 'duplicate');
});

test('avoidance refreshes a hazard instead of clearing it', () => {
  const f = fixture(); f.hazard();
  const result = f.engine.observePassage(f.edgeId, { passageId: 'swerve', trace: trace(1.5, 0.1), shockDetected: false });
  assert.equal(result.updates[0].classification, 'avoidance');
  const timestamp = trace(1.5).at(-1).timestamp;
  assert.equal(f.costs.getEvents(f.edgeId)[0].timestamp, timestamp);
  assert.equal(f.costs.weight(f.edgeId, timestamp), f.graph.edges.get(f.edgeId).distanceMeters + 50);
});

test('shock, missing shock flag, other mobility modes and stale traces cannot clear hazards', () => {
  const f = fixture(); const event = f.hazard();
  for (const overrides of [{ shockDetected: true }, {}, { shockDetected: false, mobilityMode: 'wheelchair' }]) {
    assert.equal(f.engine.observePassage(f.edgeId, { passageId: 'ineligible', trace: trace(0), ...overrides }).status, 'ineligible');
  }
  assert.equal(f.engine.observePassage(f.edgeId, { passageId: 'stale', trace: trace(0), shockDetected: false }, T + 160).status, 'stale-or-future-trace');
  assert.equal(f.costs.getEvents(f.edgeId)[0], event);
});

test('passages preceding a report and geometry ambiguity do not change its evidence', () => {
  const f = fixture();
  const event = f.hazard({ timestamp: T + 99 });
  assert.deepEqual(f.engine.observePassage(f.edgeId, { passageId: 'early', trace: trace(0), shockDetected: false }).updates, []);
  assert.equal(f.costs.getEvents(f.edgeId)[0], event);
  const g = fixture(); const prior = g.hazard();
  const result = g.engine.observePassage(g.edgeId, { passageId: 'uncertain', trace: trace(1, 3), shockDetected: false });
  assert.equal(result.updates[0].updated, false);
  assert.equal(g.costs.getEvents(g.edgeId)[0], prior);
});

test('Shannon entropy is zero for one cell and log2(N) for a uniform distribution', () => {
  assert.equal(spatialEntropy([]), 0);
  assert.equal(spatialEntropy([10]), 0);
  assert.equal(spatialEntropy([2, 2, 2, 2]), 2);
  assert.equal(spatialEntropy([0, 1, 1]), 1);
  assert.throws(() => spatialEntropy([-1]), RangeError);
});

test('clustered deflections reinforce nearby hazards while leaving distant pins untouched', () => {
  const f = fixture(); const near = f.hazard();
  const far = f.hazard({ coordinate: { lat: 0, lng: 15 / metersPerDegree } });
  deflections(f, Array(8).fill([0.11, 0.11]));
  const result = f.engine.evaluateEdge(f.edgeIds[1]);
  assert.equal(result.classification, 'localized-obstacle');
  assert.equal(result.entropyBits, 0);
  assert.deepEqual(result.updatedEventIds, [near.id]);
  assert.equal(f.costs.getEvents(f.edgeId).find((event) => event.id === far.id).timestamp, T);
  assert.equal(f.engine.evaluateEdge(f.edgeId, T + 105).updatedEventIds.length, 0);
  assert.equal(f.costs.getEvents(f.edgeId)[0].timestamp, T + 99);
});

test('distributed deflections clear finite pins and slow both directions, then expire', () => {
  const f = fixture(); f.hazard();
  deflections(f, Array.from({ length: 8 }, (_, i) => [-10 + i * 2, 0.11]));
  const result = f.engine.evaluateEdge(f.edgeId);
  assert.equal(result.classification, 'congestion');
  assert.equal(result.entropyBits, 3);
  for (const id of f.edgeIds) {
    assert.equal(f.costs.getEvents(id).length, 0);
    assert.ok(Math.abs(f.costs.baselineCostSeconds(id, T + 100) - 40 / 0.7) < 1e-8);
    assert.ok(Math.abs(f.costs.weight(id, T + 100) - 40 * 1.3 / 0.7) < 1e-8);
    assert.equal(f.costs.getCongestion(id, T + 159), null);
  }
  assert.equal(f.engine.evaluateEdge(f.edgeId, T + 159).classification, 'insufficient-evidence');
  assert.ok(Math.abs(f.costs.weight(f.edgeId, T + 159) - 40) < 1e-8);
});

test('congestion changes routing without mutating physical distance or baseline graph data', () => {
  const f = fixture();
  assert.deepEqual(shortestPath(f.graph, 1, 2).edgeIds, [f.edgeId]);
  const baselineSeconds = f.graph.edges.get(f.edgeId).baselineCostSeconds;
  deflections(f, Array.from({ length: 8 }, (_, i) => [-10 + i * 2, 0.11]));
  f.engine.evaluateEdge(f.edgeId);
  const route = shortestPath(f.graph, 1, 2, { costs: f.costs, timestamp: T + 100 });
  assert.notEqual(route.edgeIds[0], f.edgeId);
  assert.equal(f.graph.edges.get(f.edgeId).baselineCostSeconds, baselineSeconds);
});

test('hard and finite manual closures survive passage and crowd classification', () => {
  for (const initial_penalty of [Infinity, 100]) {
    const f = fixture(); const event = f.hazard({ event_type: 'MANUAL_CLOSURE', initial_penalty });
    f.engine.observePassage(f.edgeId, { passageId: 'closure-passage', trace: trace(0), shockDetected: false });
    deflections(f, Array.from({ length: 8 }, (_, i) => [-10 + i * 2, 0.11]));
    f.engine.evaluateEdge(f.edgeId);
    assert.equal(f.costs.getEvents(f.edgeId)[0], event);
  }
});

test('insufficient independent evidence does not clear pins; old crowd observations do not erase new reports', () => {
  const f = fixture(); const event = f.hazard();
  deflections(f, [[0.11], [2.11], [4.11]]);
  assert.equal(f.engine.evaluateEdge(f.edgeId).classification, 'insufficient-evidence');
  assert.equal(f.costs.getEvents(f.edgeId)[0], event);
  const g = fixture();
  deflections(g, Array.from({ length: 8 }, (_, i) => [-10 + i * 2, 0.11]));
  const fresh = g.hazard({ timestamp: T + 100 });
  g.engine.evaluateEdge(g.edgeId);
  assert.equal(g.costs.getEvents(g.edgeId)[0], fresh);
});

test('rolling window, spatial corridor, accuracy and duplicate checks reject unusable deflections', () => {
  const f = fixture();
  const point = { id: 'turn', observerId: 'person', ...coordinate(0.11, 0.11), timestamp: T + 99, accuracyMeters: 0.1 };
  assert.equal(f.engine.observeDeflection(f.edgeId, point).accepted, true);
  assert.equal(f.engine.observeDeflection(f.edgeIds[1], point).reason, 'duplicate');
  assert.equal(f.engine.observeDeflection(f.edgeId, { ...point, id: 'old', timestamp: T + 40 }).reason, 'outside-window');
  assert.equal(f.engine.observeDeflection(f.edgeId, { ...point, id: 'noisy', accuracyMeters: 1 }).reason, 'insufficient-position-accuracy');
  assert.equal(f.engine.observeDeflection(f.edgeId, { ...point, id: 'outside', ...coordinate(0, 4) }).reason, 'outside-corridor');
  assert.equal(f.engine.evaluateEdge(f.edgeId, T + 159).deflections, 0);
});

test('entropy boundary is configurable and includes equality in congestion', () => {
  const f = fixture({ entropyThresholdBits: 3 });
  deflections(f, Array.from({ length: 8 }, (_, i) => [-10 + i * 2, 0.11]));
  assert.equal(f.engine.evaluateEdge(f.edgeId).classification, 'congestion');
  assert.throws(() => fixture({ cellSizeMeters: 0 }), RangeError);
});

test('trace extraction identifies turns and slowdowns without flagging a straight steady path', () => {
  assert.deepEqual(extractDeflections(trace(0)), []);
  const turn = Array.from({ length: 21 }, (_, i) => ({
    ...coordinate(i <= 10 ? -5 + i * 0.5 : 0, i <= 10 ? 0 : (i - 10) * 0.5),
    timestamp: T + 97 + i * 0.1, accuracyMeters: 0.1,
  }));
  assert.ok(extractDeflections(turn).some((point) => point.kind === 'turn'));
  const slow = Array.from({ length: 31 }, (_, i) => ({
    ...coordinate(i * 0.04, 0.11), timestamp: T + 95 + i * 0.1, accuracyMeters: 0.1,
  }));
  const deflections = extractDeflections(slow);
  assert.ok(deflections.length >= 2);
  assert.ok(deflections.every((point) => point.kind === 'slowdown'));
  assert.ok(deflections.every((point, i) => !i || point.timestamp - deflections[i - 1].timestamp >= 1));
});

test('raw trajectory entry point extracts and aggregates independent slowdown observations', () => {
  const f = fixture(); f.hazard();
  let result;
  for (let observer = 0; observer < 3; observer++) {
    const points = Array.from({ length: 41 }, (_, i) => ({
      ...coordinate(0.11 + i * 0.001, 0.11), timestamp: T + 94 + i * 0.1, accuracyMeters: 0.1,
    }));
    result = f.engine.observeTrajectory(f.edgeId, { trace: points,
      observerId: `observer-${observer}`, passageId: `passage-${observer}`, shockDetected: false });
  }
  assert.equal(result.spatial.classification, 'localized-obstacle');
  assert.equal(result.spatial.observers, 3);
  assert.ok(result.spatial.deflections >= 8);
});
