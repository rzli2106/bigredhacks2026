import { writeFile } from 'node:fs/promises';
import { loadRoutingZone } from '../src/routing/index.js';

const [south, west, north, east, output] = process.argv.slice(2);
if (![south, west, north, east].every((value) => value !== undefined && value.trim() !== '') || !output) {
  console.error('Usage: npm run routing:ingest -- SOUTH WEST NORTH EAST output.json');
  process.exitCode = 1;
} else {
  try {
    const { graph } = await loadRoutingZone({ south: Number(south), west: Number(west), north: Number(north), east: Number(east) });
    const serialized = { ...graph, nodes: [...graph.nodes.values()], edges: [...graph.edges.values()], adjacency: [...graph.adjacency.entries()] };
    await writeFile(output, `${JSON.stringify(serialized, null, 2)}\n`, { flag: 'wx' });
    console.log(`Saved ${graph.nodes.size} nodes and ${graph.edges.size} directed edges to ${output}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
