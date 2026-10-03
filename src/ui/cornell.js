export const CORNELL_BOUNDS = Object.freeze({ south: 42.4395, west: -76.4905, north: 42.4595, east: -76.469 });
export const CORNELL_VIEW = [[42.4425, -76.4885], [42.4538, -76.476]];
export const CORNELL_PLACES = Object.freeze([
  { name: 'Ho Plaza', lat: 42.4468, lon: -76.4850 },
  { name: 'Arts Quad', lat: 42.4495, lon: -76.4844 },
  { name: 'Uris Hall', lat: 42.4473, lon: -76.4827 },
  { name: 'Gates Hall', lat: 42.4448, lon: -76.4808 },
  { name: 'Bailey Hall', lat: 42.4498, lon: -76.4801 },
]);
export function withinCornell({ lat, lon }) {
  const b = CORNELL_BOUNDS;
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}
