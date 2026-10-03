import { buildWalkingGraph } from '../routing/index.js';

export const SAMPLE_BOUNDS = [[42.4432, -76.4885], [42.4522, -76.4775]];
export function sampleCoordinate(x, y) {
  return { lat: SAMPLE_BOUNDS[1][0] - y / 1000 * 0.009, lon: SAMPLE_BOUNDS[0][1] + x / 1200 * 0.011 };
}
export function createSampleArea() {
  const places = [
    [1, 'Ho Plaza', 440, 720], [2, 'Library Walk', 440, 560], [3, 'Uris Library', 540, 560],
    [4, 'Olin Library', 540, 410], [5, 'Arts Quad', 540, 270],
    [6, 'West Library Walk', 340, 560], [7, 'McGraw Hall Walk', 340, 410],
    [8, 'Sage Chapel Walk', 710, 560], [9, 'Goldwin Smith Walk', 710, 410],
    [10, 'McGraw Hall', 340, 270], [11, 'Goldwin Smith Hall', 710, 270],
  ];
  const paths = [[1,2],[2,3],[3,4],[4,5],[2,6],[6,7],[7,4],[3,8],[8,9],[9,4],[7,10],[10,5],[5,11],[11,9]];
  const graph = buildWalkingGraph({ elements: [
    ...places.map(([id, name, x, y]) => ({ type: 'node', id, ...sampleCoordinate(x, y), tags: { name } })),
    ...paths.map((nodes, i) => ({ type: 'way', id: 100 + i, nodes, tags: { highway: 'footway' } })),
  ] });
  return { graph, places: new Map(places.map(([id, name]) => [id, name])) };
}
