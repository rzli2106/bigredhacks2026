import { EdgeIndex, DynamicEdgeCosts, buildWalkingGraph, routeBetweenPins, haversine } from '../routing/index.js';
import { CORNELL_BOUNDS, CORNELL_VIEW, CORNELL_PLACES, withinCornell } from './cornell.js';
import { captureDeviceLocation, INCIDENT_CATEGORIES, incidentAppearance, submitIncident } from './reporting.js';
import { icon, fillIcons } from './icons.js';
import { fetchCampus } from './campus-data.js';

const $ = (selector) => document.querySelector(selector);
fillIcons();
const L = window.L;
if (!L) {
  $('#map-error').hidden = false;
  $('#map-error').textContent = 'The map library could not load. Run npm install, then reload.';
  throw new Error('Leaflet is unavailable.');
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 14, maxZoom: 19, maxBoundsViscosity: 0.9,
  zoomAnimation: false, fadeAnimation: !reducedMotion.matches });
const pathLayer = L.layerGroup().addTo(map);
const nodeLayer = L.layerGroup();
const endpointLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const hazardLayer = L.layerGroup().addTo(map);
let graph, index, costs, baseLayer;
let routeEndpoints = { origin: null, destination: null };
const endpointLabels = { origin: '', destination: '' };
let snapshotVersion, viewIntent = 'campus', nearbyGeneration = 0, locateGeneration = 0;
let reportLocation = null, reportGeneration = 0, picking = null, loadingArea = false, areaPromise;
let toastTimer, undoAction, locationMarker, locationCircle;
const reports = new Map();
const pins = new Map();
const latitudeLongitude = (coordinate) => [coordinate.lat, coordinate.lon ?? coordinate.lng];

function notify(message, undo = null) {
  clearTimeout(toastTimer);
  $('#toast-text').textContent = message;
  undoAction = undo;
  $('#undo').hidden = !undo;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; undoAction = null; }, undo ? 15000 : 8000);
}
$('#dismiss-toast').addEventListener('click', () => { $('#toast').hidden = true; undoAction = null; clearTimeout(toastTimer); });
$('#undo').addEventListener('click', () => {
  const action = undoAction; undoAction = null;
  action?.();
  notify('Change undone.');
});

function closeDialog(id) { $(`#${id}`).close(); }
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => closeDialog(button.dataset.close));
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
}
$('#open-info').addEventListener('click', () => $('#info-dialog').showModal());
$('#open-area').addEventListener('click', () => { $('#area-error').hidden = true; $('#area-dialog').showModal(); });
$('#zoom-in').addEventListener('click', () => map.zoomIn());
$('#zoom-out').addEventListener('click', () => map.zoomOut());
$('#reset-view').addEventListener('click', () => fitArea());
$('#toggle-nodes').addEventListener('click', () => {
  const show = $('#toggle-nodes').getAttribute('aria-pressed') !== 'true';
  $('#toggle-nodes').setAttribute('aria-pressed', String(show));
  if (show) nodeLayer.addTo(map); else map.removeLayer(nodeLayer);
});

function fitArea() {
  viewIntent = 'campus'; map.invalidateSize();
  map.fitBounds(CORNELL_VIEW, { animate: !reducedMotion.matches, padding: [55, 75] });
}
map.setMaxBounds([[CORNELL_BOUNDS.south - 0.003, CORNELL_BOUNDS.west - 0.003],
  [CORNELL_BOUNDS.north + 0.003, CORNELL_BOUNDS.east + 0.003]]);
fitArea();
baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>', updateWhenIdle: true,
}).addTo(map);
let failedTiles = 0;
baseLayer.on('tileerror', () => {
  failedTiles++;
  $('#map-error').hidden = false;
  $('#map-error').textContent = 'Background tiles are unavailable. Cornell walking paths and pins are still usable.';
});
baseLayer.on('loading', () => { failedTiles = 0; });
baseLayer.on('load', () => { if (!failedTiles && graph) $('#map-error').hidden = true; });

function nearestPlace(coordinate) {
  return [...CORNELL_PLACES].sort((a,b) => haversine(a,coordinate) - haversine(b,coordinate))[0];
}
function pointLabel(coordinate) {
  const place = nearestPlace(coordinate);
  return haversine(place, coordinate) < 110 ? `Near ${place.name}` : `${coordinate.lat.toFixed(4)}, ${coordinate.lon.toFixed(4)}`;
}
function stopPicking() {
  picking = null; $('#pick-banner').hidden = true;
  for (const id of ['origin','destination']) $(`#${id}`).setAttribute('aria-pressed','false');
  $('#map').classList.remove('placing-pin');
}
function startPicking(kind) {
  if (!graph) { notify('Walking paths are still loading. Use Campus map to retry if loading fails.'); return; }
  stopPicking(); locateGeneration++; picking = kind;
  $('#pick-banner span').textContent = kind === 'report' ? 'Tap the map to place your report.' : `Tap the map to set your ${kind === 'origin' ? 'starting point' : 'destination'}.`;
  $('#pick-banner').hidden = false;
  if (kind !== 'report') $(`#${kind}`).setAttribute('aria-pressed','true');
  $('#map').classList.add('placing-pin');
  $('#map').scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  $('#map').focus({ preventScroll: true });
}
function setEndpoint(kind, coordinate) {
  if (!withinCornell(coordinate)) { notify('Choose a point within Cornell campus.'); return false; }
  if (!index.nearest(coordinate, { maxDistanceMeters: 40 })) { notify('Choose a point closer to a walking path (within 40 m).'); return false; }
  map.closePopup();
  routeEndpoints[kind] = { ...coordinate };
  endpointLabels[kind] = pointLabel(coordinate);
  renderEndpoints(); renderRoute();
  return true;
}
function renderEndpoints() {
  endpointLayer.clearLayers();
  for (const kind of ['origin','destination']) {
    const coordinate = routeEndpoints[kind], end = kind === 'destination';
    $(`#${kind}-label`).textContent = coordinate ? endpointLabels[kind] : 'Drop a pin on the map';
    if (!coordinate) continue;
    const marker = L.marker(latitudeLongitude(coordinate), { draggable: true,
      icon: L.divIcon({ className: '', html: `<span class="endpoint-icon ${end ? 'end' : ''}">${end ? 'B' : 'A'}</span>`, iconSize: [30,30], iconAnchor: [15,15] }),
      zIndexOffset: 1000, title: `${end ? 'Destination' : 'Starting point'}: ${endpointLabels[kind]}` }).addTo(endpointLayer);
    marker.on('dragend', () => {
      const point = marker.getLatLng();
      if (!setEndpoint(kind, { lat: point.lat, lon: point.lng })) renderEndpoints();
    });
    marker.on('click', () => { if (picking) map.fire('click', { latlng: marker.getLatLng() }); });
  }
}
for (const kind of ['origin','destination']) $(`#${kind}`).addEventListener('click', () => startPicking(kind));

function setGraph(nextGraph, version) {
  // Prepare a usable graph before replacing any visible state.
  const firstLoad = !graph;
  const nextIndex = new EdgeIndex(nextGraph);
  const defaults = CORNELL_PLACES.slice(0,2).map((place) => nextIndex.nearest(place, { maxDistanceMeters: 40 }));
  if (defaults.some((match) => !match)) throw new Error('The snapshot does not contain the central Cornell walking network.');
  const nextCosts = new DynamicEdgeCosts(nextGraph);
  costs?.dispose(); graph = nextGraph; index = nextIndex; costs = nextCosts; snapshotVersion = version;
  reports.clear(); pins.clear(); pathLayer.clearLayers(); nodeLayer.clearLayers(); routeLayer.clearLayers(); hazardLayer.clearLayers();
  for (const segment of graph.segments) {
    L.polyline(segment.geometry.map(latitudeLongitude), { color: '#748a92', weight: 1.5, opacity: 0.3, interactive: false }).addTo(pathLayer);
  }
  for (const node of graph.nodes.values()) {
    const marker = L.circleMarker(latitudeLongitude(node), { radius: 3, color: '#87958a', weight: 1.5, fillColor: '#fff', fillOpacity: 1 }).addTo(nodeLayer);
    marker.bindTooltip(node.tags.name ?? 'Walking path junction');
    marker.on('click', () => { if (picking) map.fire('click', { latlng: marker.getLatLng() }); });
  }
  // Start with an example real campus route; both endpoints can be replaced with map pins.
  if (!routeEndpoints.origin) {
    for (const [i,kind] of ['origin','destination'].entries()) {
      routeEndpoints[kind] = defaults[i].coordinate; endpointLabels[kind] = CORNELL_PLACES[i].name;
    }
  }
  if (firstLoad) seedReports();
  renderIncidents(); renderEndpoints(); renderRoute();
  $('#area-name').textContent = 'Cornell, Ithaca';
  $('#data-badge').innerHTML = '<span class="status-dot"></span>Cornell campus<span class="badge-divider"></span><span>OpenStreetMap</span>';
  $('#report-caption').textContent = 'Sample incidents + your reports · this session';
  $('#status-text').textContent = `Real Cornell paths · OSM snapshot ${version.slice(0,10)} · reports saved in this session`;
}

function seedReports() {
  const now = Date.now() / 1000;
  const examples = [['closure', CORNELL_PLACES[3], 4 * 60], ['hazard', CORNELL_PLACES[0], 19 * 60], ['uneven', CORNELL_PLACES[4], 42 * 60]];
  let added = 0;
  for (const [category, place, age] of examples) {
    if ([...reports.values()].some((item) => item.source === 'sample' && item.category === category)) continue;
    const match = index.nearest(place, { maxDistanceMeters: 40 });
    if (!match) continue;
    const definition = INCIDENT_CATEGORIES[category];
    const event = costs.recordEvent(match.edgeIds, { ...definition, timestamp: now - age,
      coordinate: { lat: match.coordinate.lat, lng: match.coordinate.lon } });
    reports.set(event.id, { event, edgeIds: match.edgeIds, category, source: 'sample', locationName: `Near ${place.name} · sample` });
    added++;
  }
  return added;
}
$('#add-samples').addEventListener('click', () => {
  if (!graph) { notify('Load Cornell walking paths first.'); return; }
  const added = seedReports(); renderIncidents(); renderRoute();
  notify(added ? `${added} sample incidents added on actual campus paths.` : 'All three sample incidents are already on the map.');
});
function renderRoute(fit = false) {
  if (!graph) return;
  const { origin, destination } = routeEndpoints;
  routeLayer.clearLayers();
  if (!origin || !destination) {
    $('#route-summary').hidden = true; $('#route-error').hidden = true; return;
  }
  const route = routeBetweenPins(graph,index,origin,destination,{ costs });
  $('#route-error').hidden = route.status === 'ok'; $('#route-summary').hidden = route.status !== 'ok';
  if (route.status !== 'ok') {
    $('#route-error').textContent = route.status === 'off-path' ? 'Move your pin closer to a Cornell walking path.' : 'No connected walking route is available. Try a nearby path or check active closures.';
    return;
  }
  const geometry = route.geometry.map(latitudeLongitude);
  if (geometry.length) {
    L.polyline(geometry, { color: '#fff', weight: 9, opacity: 0.95, lineJoin: 'round', interactive: false }).addTo(routeLayer);
    L.polyline(geometry, { color: '#2459e0', weight: 4, opacity: 1, lineJoin: 'round', interactive: false }).addTo(routeLayer);
    for (const [point,snap] of [[origin,route.from],[destination,route.to]]) {
      if (haversine(point,snap) > 1) L.polyline([latitudeLongitude(point),latitudeLongitude(snap)], { color: '#2459e0', weight: 2, dashArray: '4 5', interactive: false }).addTo(routeLayer);
    }
  }
  $('#route-minutes').textContent = String(route.distanceMeters < 1 ? 0 : Math.max(1, Math.ceil(route.durationSeconds / 60)));
  $('#route-distance').textContent = route.distanceMeters >= 1000 ? `${(route.distanceMeters / 1000).toFixed(1)} km` : `${Math.round(route.distanceMeters)} m`;
  $('#route-context').textContent = route.distanceMeters < 1 ? 'Your start and destination are at the same point.' : 'Follows campus paths and considers current reports.';
  if (fit && geometry.length) {
    viewIntent = 'route'; map.invalidateSize();
    map.fitBounds(L.latLngBounds([...geometry,latitudeLongitude(origin),latitudeLongitude(destination)]).pad(0.2), { animate: !reducedMotion.matches, padding: [70,80], maxZoom: 18 });
  }
}
$('#route-form').addEventListener('submit', (event) => {
  event.preventDefault(); stopPicking();
  if (!routeEndpoints.origin || !routeEndpoints.destination) { notify('Choose your starting point and destination on the map.'); return; }
  renderRoute(true);
  if (!$('#route-summary').hidden && window.matchMedia('(max-width: 767px)').matches) $('#map').scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
});
$('#swap-route').addEventListener('click', () => {
  stopPicking();
  [routeEndpoints.origin,routeEndpoints.destination] = [routeEndpoints.destination,routeEndpoints.origin];
  [endpointLabels.origin,endpointLabels.destination] = [endpointLabels.destination,endpointLabels.origin];
  renderEndpoints(); renderRoute();
});

function allEvents() {
  const events = new Map();
  for (const items of costs.EdgeEventList.values()) for (const event of items) events.set(event.id, event);
  return [...events.values()].filter((event) => event.timestamp <= Date.now() / 1000);
}
function ageLabel(timestamp, now) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60));
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} hr ago`;
}
function definitionFor(event) {
  const metadata = reports.get(event.id);
  return INCIDENT_CATEGORIES[metadata?.category ?? (event.event_type === 'MANUAL_CLOSURE' ? 'closure' : event.event_type === 'MUD' ? 'uneven' : 'hazard')];
}
function reportPopup(event) {
  const metadata = reports.get(event.id);
  const definition = definitionFor(event);
  const container = document.createElement('div');
  const heading = document.createElement('h3'); heading.textContent = definition.label;
  const detail = document.createElement('p'); detail.textContent = metadata?.source === 'sample' ? 'Fictional sample incident on a real Cornell path.' : 'Reported in this session.';
  const age = document.createElement('p'); age.textContent = `${ageLabel(event.timestamp, Date.now() / 1000)} · ${event.initial_penalty === Infinity ? 'Path is impassable' : 'Influences walking routes'}`;
  const actions = document.createElement('div'); actions.className = 'popup-actions';
  const confirm = document.createElement('button'); confirm.textContent = 'Still here';
  confirm.addEventListener('click', () => {
    const now = Date.now() / 1000;
    if (event.event_type === 'MANUAL_CLOSURE') {
      const renewed = costs.recordEvent(metadata.edgeIds, { ...event, timestamp: now });
      costs.removeEvent(event.id); reports.delete(event.id); reports.set(renewed.id, { ...metadata, event: renewed });
    } else costs.adjustEvent(event.id, 'avoidance', now);
    map.closePopup(); renderIncidents(); renderRoute(); notify('Report refreshed. Thanks for the heads-up.');
  });
  const resolve = document.createElement('button'); resolve.textContent = 'Mark resolved';
  resolve.addEventListener('click', () => {
    const owner = costs;
    const current = allEvents().find((item) => item.id === event.id);
    if (!current) return;
    costs.removeEvent(event.id); reports.delete(event.id);
    map.closePopup(); renderIncidents(); renderRoute();
    notify('Report marked resolved. Route updated.', () => {
      if (costs !== owner) return;
      const restored = costs.recordEvent(metadata.edgeIds, current);
      reports.set(restored.id, { ...metadata, event: restored }); renderIncidents(); renderRoute();
    });
  });
  actions.append(confirm, resolve); container.append(heading, detail, age, actions);
  return container;
}
function openReport(id) {
  const marker = pins.get(id);
  if (!marker) return;
  map.panTo(marker.getLatLng(), { animate: !reducedMotion.matches });
  marker.openPopup();
}
function renderIncidents() {
  const now = Date.now() / 1000;
  costs.prune(now);
  const events = allEvents().sort((a,b) => (b.initial_penalty === Infinity) - (a.initial_penalty === Infinity) || b.timestamp - a.timestamp);
  const activeIds = new Set(events.map((event) => event.id));
  for (const [id, pin] of pins) if (!activeIds.has(id)) { pin.remove(); pins.delete(id); reports.delete(id); }
  const rows = [];
  for (const event of events) {
    const definition = definitionFor(event), style = incidentAppearance(event, now), metadata = reports.get(event.id);
    const pinIcon = L.divIcon({ className: 'hazard-wrapper', html: `<span class="hazard-pin" style="background:${style.color};opacity:${style.opacity}">${icon(definition.icon)}</span>`, iconSize: [32,32], iconAnchor: [16,16] });
    let marker = pins.get(event.id);
    if (!marker) {
      marker = L.marker(latitudeLongitude(event.coordinate), { icon: pinIcon, title: definition.label, keyboard: true, zIndexOffset: 500 }).addTo(hazardLayer);
      marker.bindPopup(() => reportPopup(allEvents().find((item) => item.id === event.id) ?? event));
      marker.on('click', () => { if (picking) map.fire('click', { latlng: marker.getLatLng() }); });
      pins.set(event.id, marker);
    } else {
      const visual = marker.getElement()?.querySelector('.hazard-pin');
      if (visual) { visual.style.background = style.color; visual.style.opacity = style.opacity; }
    }
    const row = document.createElement('button'); row.type = 'button'; row.className = 'incident-row'; row.dataset.eventId = String(event.id);
    const glyph = document.createElement('span'); glyph.className = `incident-row-icon ${event.event_type === 'MANUAL_CLOSURE' ? 'closure' : ''}`; glyph.innerHTML = icon(definition.icon);
    const content = document.createElement('span'); content.className = 'incident-row-content';
    const title = document.createElement('strong'); title.textContent = definition.label;
    const detail = document.createElement('small'); detail.textContent = `${metadata?.locationName ?? (metadata?.source === 'map' ? 'Map point' : 'Your report')} · ${ageLabel(event.timestamp, now)}`;
    content.append(title, detail);
    const chevron = document.createElement('i'); chevron.className = 'chevron'; chevron.innerHTML = icon('chevron');
    row.append(glyph, content, chevron); row.addEventListener('click', () => openReport(event.id)); rows.push(row);
  }
  // Preserve focused list controls during periodic fading updates.
  const focusedId = document.activeElement?.closest('.incident-row')?.dataset.eventId;
  $('#incident-list').replaceChildren(...rows);
  if (focusedId) $('#incident-list').querySelector(`[data-event-id="${focusedId}"]`)?.focus({ preventScroll: true });
  $('#report-count').textContent = String(events.length);
  $('#empty-reports').hidden = Boolean(events.length);
}

function setReportLocation(location) {
  reportLocation = Object.freeze({ ...location });
  const match = index.nearest(location, { maxDistanceMeters: 40 });
  const precise = location.source !== 'device' || location.accuracyMeters <= 50;
  const valid = Boolean(match) && precise && withinCornell(location);
  for (const button of document.querySelectorAll('[data-category]')) button.disabled = !valid;
  $('#report-location').textContent = valid ? (location.source === 'device' ? 'Location captured. Tap a category to report.' : 'Map point captured. Tap a category to report.') : 'This location needs a little help.';
  $('#coordinate-label').textContent = `${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}${location.source === 'device' ? ` · ±${Math.round(location.accuracyMeters)} m` : ' · chosen on map'}`;
  $('#report-location-error').hidden = valid;
  $('#report-location-error').textContent = !precise ? 'Location is too imprecise. Choose a point on the map instead.' : 'Choose a point on a Cornell walking path. Coverage is limited to campus.';
}
$('#report-trigger').addEventListener('click', async () => {
  stopPicking(); locateGeneration++;
  const generation = ++reportGeneration;
  reportLocation = null;
  for (const button of document.querySelectorAll('[data-category]')) button.disabled = true;
  $('#report-location').textContent = 'Getting your current location…';
  $('#coordinate-label').textContent = 'Location is captured on your first tap.';
  $('#report-location-error').hidden = true;
  $('#report-dialog').showModal(); $('#report-trigger').setAttribute('aria-expanded', 'true');
  try {
    const location = await captureDeviceLocation();
    if (generation === reportGeneration && $('#report-dialog').open) setReportLocation(location);
  } catch (error) {
    if (generation !== reportGeneration || !$('#report-dialog').open) return;
    $('#report-location').textContent = 'Location wasn’t captured.';
    $('#report-location-error').textContent = error.message; $('#report-location-error').hidden = false;
  }
});
$('#report-dialog').addEventListener('close', () => { reportGeneration++; $('#report-trigger').setAttribute('aria-expanded', 'false'); });
$('#choose-map-point').addEventListener('click', () => {
  closeDialog('report-dialog'); startPicking('report');
});
$('#cancel-pick').addEventListener('click', () => {
  const previous = picking; stopPicking(); $(`#${previous === 'report' ? 'report-trigger' : previous ?? 'origin'}`).focus({ preventScroll: true });
});
map.on('click', ({ latlng }) => {
  if (!picking) return;
  const kind = picking, coordinate = { lat: latlng.lat, lon: latlng.lng };
  if (kind !== 'report') {
    if (setEndpoint(kind,coordinate)) { stopPicking(); notify(`${kind === 'origin' ? 'Starting point' : 'Destination'} pin placed. You can drag it to adjust.`); }
    return;
  }
  if (!withinCornell(coordinate)) { notify('Place your report within Cornell campus.'); return; }
  stopPicking();
  setReportLocation({ ...coordinate, timestamp: Date.now() / 1000, source: 'map', accuracyMeters: 0 });
  $('#report-dialog').showModal(); $('#report-trigger').setAttribute('aria-expanded', 'true');
});
// Leaflet supports keyboard panning; Enter drops the armed pin at the map center.
$('#map').addEventListener('keydown', (event) => {
  if (!picking) return;
  if (event.key === 'Escape') $('#cancel-pick').click();
  if (event.key === 'Enter') { event.preventDefault(); map.fire('click', { latlng: map.getCenter() }); }
});
for (const button of document.querySelectorAll('[data-category]')) button.addEventListener('click', () => {
  try {
    const saved = submitIncident({ category: button.dataset.category, location: reportLocation, index, costs });
    reports.set(saved.event.id, saved);
    const owner = costs;
    closeDialog('report-dialog'); renderIncidents(); renderRoute();
    notify('Report added. Your walking route is updated.', () => {
      if (costs !== owner) return;
      costs.removeEvent(saved.event.id); reports.delete(saved.event.id); renderIncidents(); renderRoute();
    });
  } catch (error) {
    $('#report-location-error').textContent = error.message; $('#report-location-error').hidden = false;
  }
});

function showLocation(location) {
  if (!withinCornell(location)) throw new Error('Your location is outside Cornell coverage. Choose a campus landmark or show the entire campus.');
  locationMarker?.remove(); locationCircle?.remove();
  locationCircle = L.circle(latitudeLongitude(location), { radius: location.accuracyMeters, color: '#2459e0', weight: 1, opacity: 0.2, fillOpacity: 0.06 }).addTo(map);
  locationMarker = L.marker(latitudeLongitude(location), { icon: L.divIcon({ className: '', html: '<span class="user-location"></span>', iconSize: [18,18], iconAnchor: [9,9] }), title: 'Your device location' }).addTo(map);
  viewIntent = 'point';
  map.setView(latitudeLongitude(location), 17, { animate: !reducedMotion.matches });
}
$('#locate').addEventListener('click', async () => {
  const button = $('#locate'), generation = ++locateGeneration; button.disabled = true;
  try { const location = await captureDeviceLocation(); if (generation === locateGeneration) showLocation(location); }
  catch (error) { if (generation === locateGeneration) notify(error.message); }
  finally { button.disabled = false; }
});

async function loadArea({ recenter = true } = {}) {
  if (!areaPromise) areaPromise = reloadCampus().finally(() => { areaPromise = null; });
  await areaPromise;
  if (recenter) fitArea();
}
async function reloadCampus() {
  loadingArea = true;
  for (const id of ['load-visible','load-nearby','restore-demo']) $(`#${id}`).disabled = true;
  $('#load-visible').textContent = 'Loading Cornell paths…'; $('#area-error').hidden = true;
  try {
    const data = await fetchCampus();
    if (!graph || snapshotVersion !== data.waymark.fetchedAt) {
      const nextGraph = buildWalkingGraph(data);
      if (!nextGraph.edges.size) throw new Error('The Cornell snapshot has no walking paths.');
      // Keep reports attached to their real coordinates when a refreshed snapshot changes edge IDs.
      const savedReports = graph ? allEvents().map((event) => ({ ...reports.get(event.id), event })) : [];
      setGraph(nextGraph,data.waymark.fetchedAt);
      for (const item of savedReports) {
        const match = index.nearest({ lat: item.event.coordinate.lat, lon: item.event.coordinate.lng }, { maxDistanceMeters: 40 });
        if (!match) continue;
        const event = costs.recordEvent(match.edgeIds,item.event);
        reports.set(event.id,{ ...item,event,edgeIds: match.edgeIds });
      }
      renderIncidents(); renderRoute();
    }
    $('#map-error').hidden = Boolean(failedTiles === 0);
  } finally {
    loadingArea = false;
    for (const id of ['load-visible','load-nearby','restore-demo']) $(`#${id}`).disabled = false;
    $('#load-visible').innerHTML = `${icon('layers')}Reload Cornell map`;
  }
}
function areaError(error) { $('#area-error').textContent = error.message; $('#area-error').hidden = false; }
$('#load-visible').addEventListener('click', async () => {
  try { await loadArea(); closeDialog('area-dialog'); notify('Cornell map loaded. Your pins and reports are preserved.'); }
  catch (error) { areaError(error); }
});
$('#load-nearby').addEventListener('click', async () => {
  const generation = ++nearbyGeneration; $('#load-nearby').disabled = true;
  try {
    const location = await captureDeviceLocation();
    if (generation !== nearbyGeneration) return;
    if (!withinCornell(location)) throw new Error('Your location is outside Cornell coverage. Choose a landmark below or show the entire campus.');
    await loadArea({ recenter: false });
    if (generation !== nearbyGeneration) return;
    showLocation(location); closeDialog('area-dialog'); notify('Cornell paths loaded around your location.');
  } catch (error) { if (generation === nearbyGeneration) areaError(new Error(error.message.replace('Choose a point on the map instead.','Choose a campus landmark below or show the entire campus.'))); }
  finally { if (generation === nearbyGeneration) $('#load-nearby').disabled = false; }
});
$('#area-dialog').addEventListener('close', () => { nearbyGeneration++; if (!loadingArea) $('#load-nearby').disabled = false; });
$('#restore-demo').addEventListener('click', async () => {
  try { if (!graph) await loadArea(); fitArea(); closeDialog('area-dialog'); notify('Showing Cornell campus.'); }
  catch (error) { areaError(error); }
});
for (const place of CORNELL_PLACES) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-light'; button.textContent = place.name;
  button.addEventListener('click', async () => {
    try {
      if (!graph) await loadArea({ recenter: false });
      viewIntent = 'point'; map.setView(latitudeLongitude(place),18,{ animate: !reducedMotion.matches }); closeDialog('area-dialog');
      notify(`Showing ${place.name}. Choose a route field to drop a pin.`);
    } catch (error) { areaError(error); }
  });
  $('#campus-places').append(button);
}
loadArea().catch((error) => { $('#map-error').hidden = false; $('#map-error').textContent = error.message; });
const refresh = setInterval(() => { if (costs) { renderIncidents(); renderRoute(); } },10000);
window.addEventListener('pagehide', () => { clearInterval(refresh); clearTimeout(toastTimer); costs?.dispose(); });
new ResizeObserver(() => {
  map.invalidateSize();
  if (picking) return;
  if (viewIntent === 'route' && graph) renderRoute(true);
  else if (viewIntent === 'campus') fitArea();
}).observe($('#map'));
