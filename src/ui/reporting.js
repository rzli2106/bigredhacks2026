import { validateCoordinate } from '../routing/geo.js';

export const INCIDENT_CATEGORIES = Object.freeze({
  closure: Object.freeze({ label: 'Road Closed / Impassable', icon: 'closed', event_type: 'MANUAL_CLOSURE', initial_penalty: Infinity, half_life: 14400 }),
  hazard: Object.freeze({ label: 'Hazard / Obstacle', icon: 'hazard', event_type: 'MANUAL_HAZARD', initial_penalty: 300, half_life: 3600 }),
  uneven: Object.freeze({ label: 'Slow / Uneven Ground', icon: 'uneven', event_type: 'MUD', initial_penalty: 100, half_life: 1800 }),
});

export function captureDeviceLocation(geolocation = globalThis.navigator?.geolocation) {
  return new Promise((resolve, reject) => {
    if (!geolocation) { reject(new Error('Location is unavailable. Choose a point on the map instead.')); return; }
    geolocation.getCurrentPosition((position) => {
      try {
        const coordinate = { lat: position.coords.latitude, lon: position.coords.longitude };
        validateCoordinate(coordinate);
        if (!Number.isFinite(position.coords.accuracy) || position.coords.accuracy < 0 || !Number.isFinite(position.timestamp)) {
          throw new Error('Your device returned an invalid location. Choose a map point instead.');
        }
        resolve(Object.freeze({ ...coordinate, accuracyMeters: position.coords.accuracy, timestamp: position.timestamp / 1000, source: 'device' }));
      } catch (error) { reject(error); }
    }, (error) => {
      const messages = { 1: 'Location permission was denied.', 2: 'Your location could not be found.', 3: 'Location took too long to respond.' };
      reject(new Error(`${messages[error.code] ?? 'Location is unavailable.'} Choose a point on the map instead.`));
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  });
}

export function incidentAppearance(event, time) {
  const age = Math.max(0, time - event.timestamp);
  if (event.blocked || event.initial_penalty === Infinity) {
    return { fraction: 1, opacity: 1, color: '#c54136', penalty: Infinity };
  }
  const fraction = 2 ** (-age / event.half_life);
  const mix = (fresh, faded) => Math.round(faded + (fresh - faded) * fraction);
  return {
    fraction, opacity: fraction,
    color: `rgb(${mix(224, 232)}, ${mix(89, 194)}, ${mix(43, 73)})`,
    penalty: event.initial_penalty * fraction,
  };
}

/** Maps the frozen FIRST-tap location; the category tap never recaptures GPS. */
export function submitIncident({ category, location, index, costs, now = Date.now() / 1000 }) {
  if (!Object.hasOwn(INCIDENT_CATEGORIES, category)) throw new Error('Choose an incident category.');
  if (!location) throw new Error('Capture a location before reporting.');
  validateCoordinate(location);
  if (!Number.isFinite(location.timestamp) || location.timestamp < 0 || !Number.isFinite(now) ||
      now < location.timestamp - 5 || now - location.timestamp > 120) {
    throw new Error('That location is more than two minutes old. Close and reopen the reporter to capture it again.');
  }
  if (location.source === 'device' && (!Number.isFinite(location.accuracyMeters) || location.accuracyMeters > 50)) {
    throw new Error('Your location is too imprecise for a sidewalk report. Choose a point on the map instead.');
  }
  const match = index.nearest(location, { maxDistanceMeters: 40 });
  if (!match) throw new Error('No walking path is close to this location. Load your local area or choose a point on the map.');
  const definition = INCIDENT_CATEGORIES[category];
  const event = costs.recordEvent(match.edgeIds, {
    event_type: definition.event_type, initial_penalty: definition.initial_penalty, half_life: definition.half_life,
    timestamp: location.timestamp, coordinate: { lat: location.lat, lng: location.lon },
  });
  return { event, edgeIds: match.edgeIds, category, source: location.source };
}
