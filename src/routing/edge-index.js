import { EARTH_RADIUS_M, radians, validateCoordinate } from './geo.js';

const boxDistanceSquared = (box, x, y) => {
  const dx = Math.max(box.minX - x, 0, x - box.maxX);
  const dy = Math.max(box.minY - y, 0, y - box.maxY);
  return dx * dx + dy * dy;
};

// Packed binary bounding-box tree, with segment geometry only in leaves.
function pack(items) {
  if (!items.length) return null;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const item of items) {
    box.minX = Math.min(box.minX, item.minX);
    box.minY = Math.min(box.minY, item.minY);
    box.maxX = Math.max(box.maxX, item.maxX);
    box.maxY = Math.max(box.maxY, item.maxY);
  }
  if (items.length <= 8) return { ...box, items };
  const axis = box.maxX - box.minX >= box.maxY - box.minY ? 'X' : 'Y';
  items.sort((a, b) => (a[`min${axis}`] + a[`max${axis}`]) - (b[`min${axis}`] + b[`max${axis}`]));
  const middle = Math.floor(items.length / 2);
  return { ...box, children: [pack(items.slice(0, middle)), pack(items.slice(middle))] };
}

/** Static local-zone index. Rebuild after graph geometry changes. */
export class EdgeIndex {
  constructor(graph) {
    this.graph = graph;
    const points = graph.segments.flatMap((segment) => segment.geometry);
    if (!points.length) { this.root = null; return; }
    let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
    for (const point of points) {
      validateCoordinate(point);
      south = Math.min(south, point.lat); north = Math.max(north, point.lat);
      west = Math.min(west, point.lon); east = Math.max(east, point.lon);
    }
    // A local equirectangular projection makes box pruning and segment distances consistent.
    if (north - south > 1 || east - west > 1 || Math.max(Math.abs(south), Math.abs(north)) > 85) {
      throw new RangeError('EdgeIndex supports local zones spanning <= 1 degree away from the poles; partition larger zones.');
    }
    this.origin = { lat: (south + north) / 2, lon: (west + east) / 2 };
    this.xScale = EARTH_RADIUS_M * Math.cos(radians(this.origin.lat)) * Math.PI / 180;
    this.yScale = EARTH_RADIUS_M * Math.PI / 180;
    const items = [];
    for (const segment of graph.segments) {
      for (let i = 1; i < segment.geometry.length; i++) {
        const a = this.project(segment.geometry[i - 1]);
        const b = this.project(segment.geometry[i]);
        items.push({
          segment, partIndex: i - 1, a, b,
          minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
          minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
        });
      }
    }
    this.root = pack(items);
  }

  project({ lat, lon }) {
    return { x: (lon - this.origin.lon) * this.xScale, y: (lat - this.origin.lat) * this.yScale };
  }

  nearest(coordinate, { maxDistanceMeters = 50 } = {}) {
    validateCoordinate(coordinate);
    if (!Number.isFinite(maxDistanceMeters) || maxDistanceMeters < 0) throw new RangeError('maxDistanceMeters must be finite and nonnegative.');
    if (!this.root) return null;
    const { x, y } = this.project(coordinate);
    let bestDistance = maxDistanceMeters ** 2;
    let best = null;
    const visit = (node) => {
      if (boxDistanceSquared(node, x, y) > bestDistance) return;
      if (node.children) {
        const [a, b] = node.children;
        const ordered = boxDistanceSquared(a, x, y) <= boxDistanceSquared(b, x, y) ? [a, b] : [b, a];
        visit(ordered[0]); visit(ordered[1]);
        return;
      }
      for (const item of node.items) {
        if (boxDistanceSquared(item, x, y) > bestDistance) continue;
        const dx = item.b.x - item.a.x, dy = item.b.y - item.a.y;
        const lengthSquared = dx * dx + dy * dy;
        const fraction = lengthSquared ? Math.max(0, Math.min(1, ((x - item.a.x) * dx + (y - item.a.y) * dy) / lengthSquared)) : 0;
        const px = item.a.x + fraction * dx, py = item.a.y + fraction * dy;
        const distance = (x - px) ** 2 + (y - py) ** 2;
        if (distance > bestDistance) continue;
        bestDistance = distance;
        best = {
          segmentId: item.segment.id,
          edgeIds: [...item.segment.edgeIds],
          distanceMeters: Math.sqrt(distance),
          coordinate: { lat: this.origin.lat + py / this.yScale, lon: this.origin.lon + px / this.xScale },
          partIndex: item.partIndex, fraction,
        };
      }
    };
    visit(this.root);
    return best;
  }
}
