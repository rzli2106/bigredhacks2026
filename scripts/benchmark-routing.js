import { performance } from 'node:perf_hooks';
import { buildWalkingGraph, EdgeIndex } from '../src/routing/index.js';

const elements = [];
const size = 100;
for (let row = 0; row < size; row++) {
  for (let col = 0; col < size; col++) {
    const id = row * size + col;
    elements.push({ type: 'node', id, lat: 42.44 + row * 0.0001, lon: -76.49 + col * 0.0001 });
    if (col) elements.push({ type: 'way', id: id * 2, nodes: [id - 1, id], tags: { highway: 'footway' } });
    if (row) elements.push({ type: 'way', id: id * 2 + 1, nodes: [id - size, id], tags: { highway: 'footway' } });
  }
}
const started = performance.now();
const graph = buildWalkingGraph({ elements });
const index = new EdgeIndex(graph);
const buildMs = performance.now() - started;
const durations = [];
let misses = 0;
for (let i = 0; i < 12000; i++) {
  const coordinate = { lat: 42.44 + ((i * 7919) % 9900) / 1e6, lon: -76.49 + ((i * 3571) % 9900) / 1e6 };
  const start = performance.now();
  const result = index.nearest(coordinate);
  const elapsed = performance.now() - start;
  if (!result) misses++;
  if (i >= 2000) durations.push(elapsed);
}
durations.sort((a, b) => a - b);
console.log(JSON.stringify({
  nodes: graph.nodes.size, directedEdges: graph.edges.size, indexedSegments: graph.segments.length,
  buildMs, queries: durations.length, misses,
  meanMs: durations.reduce((a, b) => a + b, 0) / durations.length,
  p50Ms: durations[Math.floor(durations.length * 0.5)],
  p95Ms: durations[Math.floor(durations.length * 0.95)],
  p99Ms: durations[Math.floor(durations.length * 0.99)],
  maxMs: durations.at(-1),
}, null, 2));
