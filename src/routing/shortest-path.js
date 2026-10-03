// Binary min-heap; duplicate entries are skipped after a shorter path is found.
class MinHeap {
  items = [];
  push(entry) {
    const items = this.items;
    let i = items.length;
    items.push(entry);
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (items[parent].cost <= entry.cost) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = entry;
  }
  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1].cost < this.items[child].cost) child++;
        if (last.cost <= this.items[child].cost) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

/** Dijkstra using nonnegative meter costs frozen at the route request time. */
export function shortestPath(graph, from, to, { costs, timestamp } = {}) {
  if (!graph.nodes.has(from) || !graph.nodes.has(to)) throw new Error('Route endpoints must be graph node IDs.');
  if (costs && costs.graph !== graph) throw new Error('Cost registry belongs to a different graph.');
  const weight = costs ? costs.evaluator(timestamp) : (id) => graph.edges.get(id).distanceMeters;
  const distances = new Map([[from, 0]]);
  const previous = new Map();
  const heap = new MinHeap();
  heap.push({ node: from, cost: 0 });
  while (heap.items.length) {
    const current = heap.pop();
    if (current.cost !== distances.get(current.node)) continue;
    if (current.node === to) {
      const edgeIds = [];
      const nodeIds = [to];
      let node = to;
      while (node !== from) {
        const edgeId = previous.get(node);
        edgeIds.push(edgeId);
        node = graph.edges.get(edgeId).from;
        nodeIds.push(node);
      }
      return {
        nodeIds: nodeIds.reverse(), edgeIds: edgeIds.reverse(), costMeters: current.cost,
        distanceMeters: edgeIds.reduce((sum, id) => sum + graph.edges.get(id).distanceMeters, 0),
      };
    }
    for (const id of graph.adjacency.get(current.node) ?? []) {
      const edge = graph.edges.get(id);
      const edgeCost = weight(id);
      if (edgeCost === Infinity) continue;
      if (!Number.isFinite(edgeCost) || edgeCost < 0) throw new RangeError('Routing weights must be nonnegative finite values or Infinity.');
      const candidate = current.cost + edgeCost;
      if (candidate < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, candidate);
        previous.set(edge.to, id);
        heap.push({ node: edge.to, cost: candidate });
      }
    }
  }
  return null;
}
