import { validateCoordinate } from './geo.js';

export const WALKABLE_HIGHWAYS = Object.freeze(['footway', 'pedestrian', 'path', 'sidewalk', 'residential', 'steps']);

export function buildOverpassQuery({ south, west, north, east } = {}) {
  validateCoordinate({ lat: south, lon: west });
  validateCoordinate({ lat: north, lon: east });
  if (south >= north || west >= east) throw new RangeError('Bounding box must have south < north and west < east; split antimeridian zones.');
  return `[out:json][timeout:25];\nway["highway"~"^(${WALKABLE_HIGHWAYS.join('|')})$"](${south},${west},${north},${east});\n(._;>;);\nout body;`;
}

export async function fetchWalkingMap(bounds, {
  endpoint = 'https://overpass-api.de/api/interpreter',
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = 30000,
} = {}) {
  const query = buildOverpassQuery(bounds);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive.');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Overpass request timed out.')), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }).toString(),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}; retry later or select another endpoint.`);
    const data = await response.json();
    if (data.remark) throw new Error(`Overpass returned incomplete data: ${data.remark}`);
    if (!Array.isArray(data.elements)) throw new Error('Overpass response is missing elements.');
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
