import { routeBetweenPins } from './pinned-route.js';

const samePath = (a, b) => a.status === 'ok' && b.status === 'ok' && a.edgeIds.join('|') === b.edgeIds.join('|');

/** Two physical walking routes with real travel times, never penalty-derived ETAs. */
export function walkingRouteOptions(graph, index, from, to, { costs, events = [], timestamp = Date.now() / 1000 } = {}) {
  const hazardEdges = new Set(events.flatMap(event => event.edge_ids));
  const decorate = route => {
    const hazards = route.status === 'ok' ? events.filter(event => event.edge_ids.some(id => route.edgeIds.includes(id))) : [];
    return { ...route, hazard_ids: hazards.map(event => event.id), blocked: hazards.some(event => event.blocked) };
  };
  const direct = decorate(routeBetweenPins(graph, index, from, to, { timestamp }));
  const registry = excluded => ({
    graph,
    evaluator: () => {
      const evaluate = costs ? costs.evaluator(timestamp) : id => graph.edges.get(id).distanceMeters;
      return id => hazardEdges.has(id) || excluded.has(graph.edges.get(id).segmentId) ? Infinity : evaluate(id);
    },
    baselineCostSeconds: id => costs ? costs.baselineCostSeconds(id, timestamp) : graph.edges.get(id).distanceMeters / graph.walkingSpeedMps,
  });
  // Direct route ignores reports for comparison; apply observed walking speeds to its ETA.
  if (direct.status === 'ok' && costs) {
    const baseline = { graph, evaluator: () => id => graph.edges.get(id).distanceMeters,
      baselineCostSeconds: id => costs.baselineCostSeconds(id, timestamp) };
    direct.durationSeconds = routeBetweenPins(graph, index, from, to, { costs: baseline, timestamp }).durationSeconds;
  }
  let alternative = decorate(routeBetweenPins(graph, index, from, to, { costs: registry(new Set()), timestamp }));
  let reason = hazardEdges.size ? 'avoids-active-hazards' : 'alternate-path';
  // With no intersecting hazards, find a distinct option by excluding a direct-route
  // segment. Bound the search to eight segments so campus requests stay cheap.
  if (samePath(direct, alternative) && direct.edgeIds.length) {
    const ids = [...new Set(direct.edgeIds.map(id => graph.edges.get(id).segmentId))];
    const candidates = [];
    const selected = new Set(Array.from({ length: Math.min(8, ids.length) }, (_, i) => ids[Math.floor(i * ids.length / Math.min(8, ids.length))]));
    for (const id of selected) {
      const route = routeBetweenPins(graph, index, from, to, { costs: registry(new Set([id])), timestamp });
      if (route.status === 'ok' && !samePath(route, direct)) candidates.push(route);
    }
    candidates.sort((a, b) => a.durationSeconds - b.durationSeconds);
    alternative = candidates.length ? decorate(candidates[0]) : null;
    reason = alternative ? 'alternate-path' : 'no-distinct-alternative';
  }
  if (direct.status !== 'ok') alternative = null;
  if (alternative && alternative.status !== 'ok') { alternative = null; reason = 'no-hazard-free-route'; }
  return { direct, alternative, alternative_reason: reason, time: timestamp };
}
