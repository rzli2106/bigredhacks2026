import { haversine, validateCoordinate } from './geo.js';
import { shortestPath } from './shortest-path.js';

function segmentPosition(segment, match) {
  const cumulative = [0];
  for (let i = 1; i < segment.geometry.length; i++) cumulative.push(cumulative.at(-1) + haversine(segment.geometry[i - 1], segment.geometry[i]));
  const progress = cumulative[match.partIndex] + match.fraction * (cumulative[match.partIndex + 1] - cumulative[match.partIndex]);
  return { ...match, segment, cumulative, progress };
}
function subline(position, from, to) {
  const { segment, cumulative } = position;
  const at = (distance) => {
    if (distance <= 0) return segment.geometry[0];
    if (distance >= segment.distanceMeters) return segment.geometry.at(-1);
    const i = cumulative.findIndex((value) => value >= distance);
    const fraction = (distance - cumulative[i - 1]) / (cumulative[i] - cumulative[i - 1]);
    const a = segment.geometry[i - 1], b = segment.geometry[i];
    return { lat: a.lat + (b.lat - a.lat) * fraction, lon: a.lon + (b.lon - a.lon) * fraction };
  };
  const low = Math.min(from,to), high = Math.max(from,to);
  const points = [at(low), ...segment.geometry.filter((_,i) => cumulative[i] > low && cumulative[i] < high), at(high)];
  return from <= to ? points : points.reverse();
}

/** Connect arbitrary pins to actual polyline positions, respecting pedestrian direction. */
export function routeBetweenPins(graph, index, from, to, { costs, timestamp = Date.now() / 1000, maxDistanceMeters = 40 } = {}) {
  validateCoordinate(from); validateCoordinate(to);
  if (costs && costs.graph !== graph) throw new Error('Cost registry belongs to a different graph.');
  const fromMatch = index.nearest(from, { maxDistanceMeters }), toMatch = index.nearest(to, { maxDistanceMeters });
  if (!fromMatch || !toMatch) return { status: 'off-path', endpoint: !fromMatch ? 'origin' : 'destination' };
  if (haversine(from,to) < 0.01) return { status: 'ok', geometry: [from], edgeIds: [], costMeters: 0, distanceMeters: 0, durationSeconds: 0, from, to, fromOffsetMeters: 0, toOffsetMeters: 0 };
  const segments = new Map(graph.segments.map((segment) => [segment.id, segment]));
  const source = segmentPosition(segments.get(fromMatch.segmentId), fromMatch);
  const target = segmentPosition(segments.get(toMatch.segmentId), toMatch);
  const sourceId = Symbol('origin'), targetId = Symbol('destination');
  const augmented = { ...graph, nodes: new Map(graph.nodes), edges: new Map(graph.edges), adjacency: new Map(graph.adjacency) };
  augmented.nodes.set(sourceId, source.coordinate); augmented.nodes.set(targetId, target.coordinate);
  augmented.adjacency.set(sourceId, []); augmented.adjacency.set(targetId, []);
  const virtual = new Map();
  function add(fromId, toId, edge, position, start, end) {
    const id = Symbol('pin-connection');
    const distanceMeters = Math.abs(end - start);
    const geometry = subline(position, start, end);
    const item = { id, from: fromId, to: toId, distanceMeters, originalEdgeId: edge.id, geometry };
    augmented.edges.set(id, item); virtual.set(id,item);
    augmented.adjacency.set(fromId, [...augmented.adjacency.get(fromId), id]);
  }
  for (const id of source.edgeIds) {
    const edge = graph.edges.get(id);
    add(sourceId, edge.to, edge, source, source.progress, edge.direction === 'forward' ? source.segment.distanceMeters : 0);
  }
  for (const id of target.edgeIds) {
    const edge = graph.edges.get(id);
    add(edge.from, targetId, edge, target, edge.direction === 'forward' ? 0 : target.segment.distanceMeters, target.progress);
  }
  if (source.segmentId === target.segmentId) {
    for (const id of source.edgeIds) {
      const edge = graph.edges.get(id);
      if ((edge.direction === 'forward' && source.progress <= target.progress) ||
          (edge.direction === 'backward' && source.progress >= target.progress)) {
        add(sourceId, targetId, edge, source, source.progress, target.progress);
      }
    }
  }
  const evaluate = costs ? costs.evaluator(timestamp) : (id) => graph.edges.get(id).distanceMeters;
  const result = shortestPath(augmented, sourceId, targetId, { weight: (id) => {
    const part = virtual.get(id);
    if (!part) return evaluate(id);
    if (part.distanceMeters < 1e-8) return 0;
    const base = graph.edges.get(part.originalEdgeId);
    const penalty = evaluate(base.id);
    return penalty === Infinity ? Infinity : penalty * part.distanceMeters / base.distanceMeters;
  } });
  if (!result) return { status: 'unreachable', from: source, to: target };
  const geometry = [], originalEdgeIds = [];
  let durationSeconds = 0;
  for (const id of result.edgeIds) {
    const part = virtual.get(id), edge = part ?? graph.edges.get(id);
    // A pin exactly at a junction can connect through a zero-length portion of
    // a blocked edge. It is not traversed and must not appear in hazard checks.
    if (edge.distanceMeters < 1e-8) continue;
    const original = graph.edges.get(part?.originalEdgeId ?? id);
    const segment = segments.get(original.segmentId);
    const points = part?.geometry ?? (edge.direction === 'forward' ? segment.geometry : [...segment.geometry].reverse());
    geometry.push(...points);
    originalEdgeIds.push(original.id);
    durationSeconds += (costs ? costs.baselineCostSeconds(original.id, timestamp) : original.distanceMeters / graph.walkingSpeedMps) * edge.distanceMeters / original.distanceMeters;
  }
  const connectorMeters = haversine(from, source.coordinate) + haversine(to, target.coordinate);
  return { status: 'ok', geometry, edgeIds: originalEdgeIds, costMeters: result.costMeters + connectorMeters,
    distanceMeters: result.distanceMeters + connectorMeters, durationSeconds: durationSeconds + connectorMeters / graph.walkingSpeedMps,
    from: source.coordinate, to: target.coordinate, fromOffsetMeters: fromMatch.distanceMeters, toOffsetMeters: toMatch.distanceMeters };
}
