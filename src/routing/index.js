import { fetchWalkingMap } from './overpass.js';
import { buildWalkingGraph } from './graph.js';
import { EdgeIndex } from './edge-index.js';

export { fetchWalkingMap, buildOverpassQuery, WALKABLE_HIGHWAYS } from './overpass.js';
export { buildWalkingGraph } from './graph.js';
export { EdgeIndex } from './edge-index.js';
export { haversine } from './geo.js';
export { DynamicEdgeCosts, EVENT_DEFAULTS } from './dynamic-cost.js';
export { shortestPath } from './shortest-path.js';
export { routeBetweenPins } from './pinned-route.js';
export { analyzePassage, extractDeflections, spatialEntropy } from './spatial-evidence.js';
export { DisambiguationEngine, DISAMBIGUATION_DEFAULTS } from './disambiguation.js';

export async function loadRoutingZone(bounds, { walkingSpeedMps = 1.3, ...fetchOptions } = {}) {
  const data = await fetchWalkingMap(bounds, fetchOptions);
  const graph = buildWalkingGraph(data, { walkingSpeedMps });
  return { graph, index: new EdgeIndex(graph) };
}
