import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverpassQuery, fetchWalkingMap, buildWalkingGraph, EdgeIndex, haversine, loadRoutingZone } from '../src/routing/index.js';

const node = (id, lat, lon) => ({ type: 'node', id, lat, lon });
const way = (id, nodes, tags = {}) => ({ type: 'way', id, nodes, tags: { highway: 'footway', ...tags } });
const bounds = { south: 42.44, west: -76.49, north: 42.45, east: -76.48 };
const fixture = () => ({ elements: [
  node(1, 42.44, -76.49), node(2, 42.4402, -76.4898), node(3, 42.44, -76.4896),
  node(4, 42.44, -76.489), node(5, 42.441, -76.4896),
  way(10, [1, 2, 3, 4]), way(20, [3, 5], { highway: 'steps', 'oneway:foot': 'yes' }),
] });

test('query selects requested highways and recursively includes geometry nodes', () => {
  const query = buildOverpassQuery(bounds);
  assert.match(query, /footway\|pedestrian\|path\|sidewalk\|residential\|steps/);
  assert.ok(query.includes('(42.44,-76.49,42.45,-76.48)'));
  assert.ok(query.includes('(._;>;);'));
  assert.throws(() => buildOverpassQuery({ ...bounds, south: '42' }), RangeError);
  assert.throws(() => buildOverpassQuery({ ...bounds, east: -77 }), RangeError);
});

test('fetch posts query and integrates graph and index', async () => {
  const { graph, index } = await loadRoutingZone(bounds, { fetchImpl: async (_url, options) => {
    assert.equal(options.method, 'POST');
    assert.match(new URLSearchParams(options.body).get('data'), /out body/);
    return { ok: true, json: async () => fixture() };
  } });
  assert.equal(graph.segments.length, 3);
  assert.ok(index.nearest({ lat: 42.4402, lon: -76.4898 }));
});

test('fetch rejects HTTP errors, partial responses, bad schema and timeout', async () => {
  await assert.rejects(fetchWalkingMap(bounds, { fetchImpl: async () => ({ ok: false, status: 429 }) }), /429/);
  for (const data of [{ remark: 'runtime error', elements: [] }, {}]) {
    await assert.rejects(fetchWalkingMap(bounds, { fetchImpl: async () => ({ ok: true, json: async () => data }) }));
  }
  await assert.rejects(fetchWalkingMap(bounds, {
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  }), /timed out/);
});

test('graph splits junctions, retains bends, directed adjacency and full path length', () => {
  const graph = buildWalkingGraph(fixture());
  assert.equal(graph.nodes.size, 4);
  assert.equal(graph.nodes.has(2), false);
  assert.equal(graph.edges.size, 5);
  assert.equal(graph.adjacency.get(5).length, 0);
  const segment = graph.segments[0];
  assert.deepEqual(segment.geometry.map((point) => point.id), [1, 2, 3]);
  const direct = haversine(segment.geometry[0], segment.geometry[2]);
  assert.ok(segment.distanceMeters > direct);
  const edge = graph.edges.get(segment.edgeIds[0]);
  assert.equal(edge.baselineCostSeconds, segment.distanceMeters / 1.3);
  assert.ok(graph.adjacency.get(edge.from).includes(edge.id));
});

test('foot access overrides general access and vehicle one-way does not restrict walking', () => {
  const data = { elements: [node(1, 0, 0), node(2, 0, 0.001),
    way(1, [1, 2], { highway: 'residential', oneway: 'yes' }),
    way(2, [1, 2], { foot: 'no' }), way(3, [1, 2], { access: 'private' }),
    way(4, [1, 2], { access: 'private', foot: 'yes' }),
    way(5, [1, 2], { area: 'yes' }), way(6, [1, 2], { highway: 'motorway' }),
    way(7, [1, 2], { 'oneway:foot': '-1' }),
  ] };
  const graph = buildWalkingGraph(data);
  assert.equal(graph.edges.size, 5);
  assert.equal(graph.edges.get('7:0-1:backward').from, 2);
  assert.equal(graph.edges.has('7:0-1:forward'), false);
});

test('closed loops, parallel ways and grade-separated crossings preserve topology', () => {
  const graph = buildWalkingGraph({ elements: [
    node(1, 0, 0), node(2, 0, 0.001), node(3, 0.001, 0),
    node(4, -0.001, 0.0005), node(5, 0.001, 0.0005),
    way(1, [1, 2, 3, 1]), way(2, [4, 5]), way(3, [4, 5]),
  ] });
  assert.equal(graph.segments.length, 3);
  assert.equal(graph.segments[0].geometry.length, 4);
  assert.equal(graph.edges.size, 6);
  assert.equal(graph.nodes.size, 3);
});

test('missing nodes fail instead of silently connecting across incomplete geometry', () => {
  assert.throws(() => buildWalkingGraph({ elements: [node(1, 0, 0), way(1, [1, 2])] }), /Missing node/);
});

test('index snaps to curved geometry and returns both directed edges', () => {
  const graph = buildWalkingGraph(fixture());
  const index = new EdgeIndex(graph);
  const hit = index.nearest({ lat: 42.4402, lon: -76.4898 });
  assert.equal(hit.segmentId, '10:0-2');
  assert.equal(hit.edgeIds.length, 2);
  assert.ok(hit.distanceMeters < 1e-8);
  assert.equal(index.nearest({ lat: 43, lon: -76 }), null);
  assert.throws(() => index.nearest({ lat: NaN, lon: 0 }), RangeError);
  assert.equal(new EdgeIndex(buildWalkingGraph({ elements: [] })).nearest({ lat: 0, lon: 0 }), null);
});

test('index matches independent exhaustive segment distances across a multi-leaf tree', () => {
  const elements = [];
  for (let i = 0; i < 100; i++) {
    elements.push(node(i * 2, 42 + i * 0.0001, -76), node(i * 2 + 1, 42 + i * 0.0001, -75.999));
    elements.push(way(i, [i * 2, i * 2 + 1]));
  }
  const graph = buildWalkingGraph({ elements });
  const index = new EdgeIndex(graph);
  for (let i = 0; i < 150; i++) {
    const coordinate = { lat: 42 + ((i * 37) % 100) * 0.0001 + 0.000023, lon: -75.9995 };
    const expected = graph.segments.reduce((best, segment) => {
      const distance = haversine(coordinate, { lat: segment.geometry[0].lat, lon: coordinate.lon });
      return distance < best.distance ? { id: segment.id, distance } : best;
    }, { distance: Infinity });
    const hit = index.nearest(coordinate);
    assert.equal(hit.segmentId, expected.id);
    assert.ok(Math.abs(hit.distanceMeters - expected.distance) < 1e-6);
  }
});

test('index rejects unsupported geographic extents', () => {
  const graph = buildWalkingGraph({ elements: [node(1, 0, 0), node(2, 0, 2), way(1, [1, 2])] });
  assert.throws(() => new EdgeIndex(graph), /local zones/);
});
