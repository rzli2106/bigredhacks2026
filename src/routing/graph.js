import { haversine, validateCoordinate } from './geo.js';
import { WALKABLE_HIGHWAYS } from './overpass.js';

const allowedFoot = new Set(['yes', 'designated', 'permissive', 'destination']);
const deniedAccess = new Set(['no', 'private', 'customers', 'delivery', 'agricultural', 'forestry']);

function walkable(tags = {}) {
  if (!WALKABLE_HIGHWAYS.includes(tags.highway) || tags.area === 'yes') return false;
  if (tags.foot !== undefined) return allowedFoot.has(tags.foot);
  return !deniedAccess.has(tags.access);
}

/** Compress OSM shape nodes into polylines, splitting at shared nodes and termini. */
export function buildWalkingGraph(data, { walkingSpeedMps = 1.3 } = {}) {
  if (!Number.isFinite(walkingSpeedMps) || walkingSpeedMps <= 0) throw new RangeError('walkingSpeedMps must be positive.');
  if (!Array.isArray(data?.elements) || data.remark) throw new Error('Expected complete Overpass elements.');
  const coordinates = new Map();
  const wayMap = new Map();
  for (const element of data.elements) {
    if (element.type === 'node') {
      validateCoordinate(element);
      coordinates.set(element.id, { id: element.id, lat: element.lat, lon: element.lon, tags: { ...element.tags } });
    } else if (element.type === 'way' && walkable(element.tags)) wayMap.set(element.id, element);
  }
  const ways = [...wayMap.values()];
  const counts = new Map();
  const cuts = new Set();
  for (const way of ways) {
    if (!Array.isArray(way.nodes) || way.nodes.length < 2) throw new Error(`Way ${way.id} has no usable node sequence.`);
    cuts.add(way.nodes[0]);
    cuts.add(way.nodes.at(-1));
    for (const id of way.nodes) {
      if (!coordinates.has(id)) throw new Error(`Missing node ${id} referenced by way ${way.id}.`);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      // Retain tagged points for later accessibility/barrier policy.
      if (Object.keys(coordinates.get(id).tags).length) cuts.add(id);
    }
  }
  for (const [id, count] of counts) if (count > 1) cuts.add(id);
  const nodes = new Map();
  const edges = new Map();
  const adjacency = new Map();
  const segments = [];
  function addNode(id) {
    if (!nodes.has(id)) {
      nodes.set(id, coordinates.get(id));
      adjacency.set(id, []);
    }
  }
  for (const way of ways) {
    let start = 0;
    for (let end = 1; end < way.nodes.length; end++) {
      if (!cuts.has(way.nodes[end])) continue;
      const geometry = way.nodes.slice(start, end + 1).map((id) => coordinates.get(id));
      const segmentId = `${way.id}:${start}-${end}`;
      start = end;
      const distanceMeters = geometry.slice(1).reduce((distance, point, i) => distance + haversine(geometry[i], point), 0);
      if (distanceMeters === 0) continue;
      const from = geometry[0].id;
      const to = geometry.at(-1).id;
      const tags = { ...way.tags };
      const reverseOnly = tags['oneway:foot'] === '-1';
      const forwardOnly = ['yes', '1', 'true'].includes(tags['oneway:foot']);
      const directions = [];
      if (!reverseOnly && tags['foot:forward'] !== 'no') directions.push([from, to, 'forward']);
      if (!forwardOnly && tags['foot:backward'] !== 'no') directions.push([to, from, 'backward']);
      if (!directions.length) continue;
      addNode(from);
      addNode(to);
      const segment = { id: segmentId, wayId: way.id, geometry, distanceMeters, edgeIds: [], tags };
      for (const [source, target, direction] of directions) {
        const id = `${segmentId}:${direction}`;
        const edge = {
          id, segmentId, wayId: way.id, from: source, to: target, direction,
          distanceMeters, baselineCostSeconds: distanceMeters / walkingSpeedMps,
          tags,
        };
        edges.set(id, edge);
        adjacency.get(source).push(id);
        segment.edgeIds.push(id);
      }
      segments.push(segment);
    }
  }
  return { nodes, edges, adjacency, segments, walkingSpeedMps, attribution: '© OpenStreetMap contributors', license: 'ODbL-1.0' };
}
