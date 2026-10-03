import { writeFile, rename } from 'node:fs/promises';
import { fetchWalkingMap } from '../src/routing/overpass.js';
import { buildWalkingGraph } from '../src/routing/graph.js';
import { CORNELL_BOUNDS } from '../src/ui/cornell.js';

let data;
for (const endpoint of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
  try {
    data = await fetchWalkingMap(CORNELL_BOUNDS, { endpoint, timeoutMs: 25000,
      fetchImpl: (url, options) => fetch(`${url}?${options.body}`, { signal: options.signal,
        headers: { 'User-Agent': 'Waymark/0.1 (Cornell walking map prototype)' } }),
    }); break;
  }
  catch (error) { console.error(`${endpoint}: ${error.message}`); }
}
if (!data) throw new Error('No Overpass server responded; existing snapshot was preserved.');
const graph = buildWalkingGraph(data);
if (!graph.edges.size) throw new Error('Empty graph; existing snapshot was preserved.');
const snapshot = { ...data, waymark: { bounds: CORNELL_BOUNDS, fetchedAt: new Date().toISOString(), source: 'OpenStreetMap via Overpass', license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors' } };
const temporary = new URL('../public/cornell-osm.json.tmp', import.meta.url);
await writeFile(temporary, JSON.stringify(snapshot));
await rename(temporary, new URL('../public/cornell-osm.json', import.meta.url));
console.log(`Saved actual OSM data: ${graph.nodes.size} graph nodes, ${graph.edges.size} directed edges.`);
