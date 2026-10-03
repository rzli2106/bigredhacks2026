/** Physical road blocks end at intersections, not tagged OSM shape points. */
export class RoadBlocks {
  constructor(graph) {
    this.segments = new Map(graph.segments.map(segment => [segment.id, segment]));
    this.incident = new Map();
    for (const segment of graph.segments) for (const node of new Set([segment.geometry[0].id, segment.geometry.at(-1).id])) {
      if (!this.incident.has(node)) this.incident.set(node, []);
      this.incident.get(node).push(segment);
    }
  }
  edges(segmentId) {
    const origin = this.segments.get(segmentId);
    if (!origin) throw new Error('Unknown road segment.');
    const compatible = segment => (segment.wayId === origin.wayId ||
      (origin.tags.name && segment.tags.name?.trim().toLowerCase() === origin.tags.name.trim().toLowerCase())) &&
      ['layer','bridge','tunnel'].every(key => (segment.tags[key] ?? '') === (origin.tags[key] ?? ''));
    const visited = new Set(), pending = [origin], edges = [];
    while (pending.length) {
      const segment = pending.pop(); if (visited.has(segment.id)) continue;
      visited.add(segment.id); edges.push(...segment.edgeIds);
      for (const node of [segment.geometry[0].id, segment.geometry.at(-1).id]) {
        const adjoining = this.incident.get(node);
        // A third physical segment marks an intersection. Never spread across it.
        if (adjoining.length === 2 && adjoining.every(compatible)) pending.push(...adjoining);
      }
    }
    return edges;
  }
}
