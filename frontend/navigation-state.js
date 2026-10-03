import { haversine, validateCoordinate } from '../src/routing/geo.js';
import { CORNELL_PLACES, withinCornell } from '../src/ui/cornell.js';

export function resolvePlace(value, location) {
  const text = value.trim();
  if (!text || /^(my live location|current location|gps)$/i.test(text)) {
    if (!location || Date.now() / 1000 - location.timestamp > 10) throw new Error('Tap Locate me to get a fresh GPS start, or enter a campus place.');
    if (!withinCornell(location)) throw new Error('Your GPS location is outside Cornell walking coverage.');
    return { lat: location.lat, lon: location.lon };
  }
  const place = CORNELL_PLACES.find(place => place.name.toLowerCase() === text.toLowerCase());
  if (place) return { lat: place.lat, lon: place.lon };
  const parts = text.split(',').map(part => part.trim());
  if (parts.length === 2 && parts.every(part => /^-?\d+(\.\d+)?$/.test(part))) {
    const point = { lat: Number(parts[0]), lon: Number(parts[1]) }; validateCoordinate(point);
    if (!withinCornell(point)) throw new Error('Choose a start and destination inside Cornell coverage.');
    return point;
  }
  throw new Error('Choose a Cornell place, enter latitude, longitude, or tap the map for a destination.');
}
export function hazardName(event) {
  return ({ closure: 'Closure', pothole: 'Pothole', rough_terrain: 'Rough Terrain' })[event.hazard_category] ||
    ({ MANUAL_CLOSURE: 'Closure', MANUAL_HAZARD: 'Obstacle', TERRAIN_DRAG: 'Rough Terrain', SENSOR_SHOCK: 'Surface impact' })[event.metric_type] || 'Obstacle';
}

/** Project fixes onto the route to avoid alerts about already-passed hazards. */
export function routeProgress(geometry, point) {
  let along = 0, best = { distance: Infinity, along: 0 };
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1], b = geometry[i], scale = Math.cos(point.lat * Math.PI / 180);
    const dx = (b.lon - a.lon) * scale, dy = b.lat - a.lat;
    const fraction = Math.max(0, Math.min(1, ((point.lon - a.lon) * scale * dx + (point.lat - a.lat) * dy) / (dx * dx + dy * dy || 1)));
    const projected = { lat: a.lat + fraction * dy, lon: a.lon + fraction * (b.lon - a.lon) };
    const length = haversine(a, b), distance = haversine(point, projected);
    if (distance < best.distance) best = { distance, along: along + length * fraction };
    along += length;
  }
  return best;
}
export function hazardAhead(route, event, location, now = Date.now() / 1000) {
  if (!route || route.status !== 'ok' || !event.edge_ids.some(id => route.edgeIds.includes(id))) return false;
  if (!location || now - location.timestamp > 10 || !event.coordinate) return true;
  const position = routeProgress(route.geometry, location);
  const hazard = routeProgress(route.geometry, { lat: event.coordinate.lat, lon: event.coordinate.lng });
  if (position.distance > 40) return true;
  return hazard.along + Math.max(10, location.accuracyMeters || 0) >= position.along;
}

export class RouteAlerts {
  constructor() { this.seen = new Set(); this.instance = null; this.initialized = false; }
  observe(snapshot, activeRoute, location) {
    if (this.instance !== snapshot.instance_id) { this.seen.clear(); this.instance = snapshot.instance_id; }
    const fresh = [];
    const keys = new Set();
    for (const event of snapshot.events) {
      const key = `${event.id}:${event.timestamp}`; keys.add(key);
      if (this.initialized && !this.seen.has(key) && hazardAhead(activeRoute, event, location)) fresh.push(event);
    }
    this.seen = keys; this.initialized = true;
    return fresh;
  }
}
export const routeMinutes = seconds => seconds === 0 ? '0' : seconds < 60 ? '<1' : String(Math.ceil(seconds / 60));
export const sameRoute = (a, b) => a?.status === 'ok' && b?.status === 'ok' && a.edgeIds.join('|') === b.edgeIds.join('|');
export function remainingSeconds(route, location, now = Date.now() / 1000) {
  if (!location || now - location.timestamp > 10 || !route.distanceMeters) return route.durationSeconds;
  const progress = routeProgress(route.geometry, location);
  if (progress.distance > 40) return route.durationSeconds;
  return route.durationSeconds * Math.max(0, 1 - progress.along / route.distanceMeters);
}
export function etaDelta(alternative, active) {
  return Math.max(0, Math.ceil((alternative.durationSeconds - active.durationSeconds) / 60));
}
