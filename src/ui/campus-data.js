/** Load the shipped campus snapshot; no public Overpass request is needed at runtime. */
export async function fetchCampus({ fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  let lastError;
  for (const url of ['/api/cornell-map', '/public/cornell-osm.json']) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-cache' });
      if (!response.ok) throw new Error(`Campus data returned ${response.status}.`);
      const data = await response.json();
      if (!Array.isArray(data.elements) || !data.elements.length || data.remark ||
          !Number.isFinite(Date.parse(data.waymark?.fetchedAt))) throw new Error('Campus data is invalid.');
      return data;
    } catch (error) { lastError = error; }
  }
  throw new Error(`Cornell paths could not load. Try Reload Cornell map. ${lastError.message}`);
}
