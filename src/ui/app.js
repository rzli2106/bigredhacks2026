import { EdgeIndex, DynamicEdgeCosts, loadRoutingZone, shortestPath, haversine } from '../routing/index.js';
import { createSampleArea, sampleCoordinate, SAMPLE_BOUNDS } from './sample-area.js';
import { captureDeviceLocation, INCIDENT_CATEGORIES, incidentAppearance, submitIncident } from './reporting.js';
import { icon, fillIcons } from './icons.js';

const $ = (selector) => document.querySelector(selector);
fillIcons();
const L = window.L;
if (!L) {
  $('#map-error').hidden = false;
  $('#map-error').textContent = 'The map library could not load. Run npm install, then reload.';
  throw new Error('Leaflet is unavailable.');
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 12, maxZoom: 20,
  zoomAnimation: !reducedMotion.matches, fadeAnimation: !reducedMotion.matches });
const pathLayer = L.layerGroup().addTo(map);
const nodeLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const hazardLayer = L.layerGroup().addTo(map);
let graph, index, costs, placeNames, baseLayer, routeEndpoints;
let mode = 'sample', reportLocation = null, reportGeneration = 0, picking = false, areaGeneration = 0, loadingArea = false;
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
  const points = [...graph.nodes.values()].map(latitudeLongitude);
  if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.2), { animate: !reducedMotion.matches, padding: [55, 75] });
}

function nodeName(id) { return placeNames.get(id) ?? `Path junction ${id}`; }
function populateSelects() {
  for (const select of [$('#origin'), $('#destination')]) {
    select.replaceChildren(...[...graph.nodes.keys()].slice(0, 500).map((id) => new Option(nodeName(id), String(id))));
  }
}
function nodeId(value) { return [...graph.nodes.keys()].find((id) => String(id) === value); }
function setSelectedNode(select, id) {
  if (![...select.options].some((option) => option.value === String(id))) select.add(new Option(nodeName(id), String(id)));
  select.value = String(id);
}
function chooseNode(id, isOrigin = false) {
  const select = isOrigin ? $('#origin') : $('#destination');
  setSelectedNode(select, id);
  updateRouteFromForm(true);
}

function liveEndpoints() {
  // Prefer the largest connected walking network rather than unrelated OSM node order.
  const neighbors = new Map([...graph.nodes.keys()].map((id) => [id, []]));
  for (const edge of graph.edges.values()) { neighbors.get(edge.from).push(edge.to); neighbors.get(edge.to).push(edge.from); }
  const seen = new Set();
  let largest = [];
  for (const id of graph.nodes.keys()) {
    if (seen.has(id)) continue;
    const component = [id]; seen.add(id);
    for (let i = 0; i < component.length; i++) {
      for (const next of neighbors.get(component[i])) if (!seen.has(next)) { seen.add(next); component.push(next); }
    }
    if (component.length > largest.length) largest = component;
  }
  const center = map.getCenter();
  let from = largest[0], best = Infinity;
  for (const id of largest) {
    if (!graph.adjacency.get(id).length) continue;
    const distance = haversine(graph.nodes.get(id), { lat: center.lat, lon: center.lng });
    if (distance < best) { from = id; best = distance; }
  }
  const reachable = [from], visited = new Set([from]);
  let to = from, farthest = 0;
  for (let i = 0; i < reachable.length; i++) {
    const current = reachable[i];
    const distance = haversine(graph.nodes.get(from), graph.nodes.get(current));
    if (distance > farthest) { to = current; farthest = distance; }
    for (const id of graph.adjacency.get(current)) {
      const next = graph.edges.get(id).to;
      if (!visited.has(next)) { visited.add(next); reachable.push(next); }
    }
  }
  return { from, to };
}

function setGraph(nextGraph, names, nextMode) {
  costs?.dispose();
  graph = nextGraph;
  costs = new DynamicEdgeCosts(graph);
  index = new EdgeIndex(graph);
  placeNames = names;
  mode = nextMode;
  reports.clear(); pins.clear();
  pathLayer.clearLayers(); nodeLayer.clearLayers(); routeLayer.clearLayers(); hazardLayer.clearLayers();
  locationMarker?.remove(); locationCircle?.remove(); locationMarker = null; locationCircle = null;
  baseLayer?.remove();
  if (mode === 'sample') {
    baseLayer = L.imageOverlay('/public/sample-map.svg', SAMPLE_BOUNDS, { pane: 'tilePane', interactive: false }).addTo(map);
    map.attributionControl.addAttribution('Illustrative campus map');
    $('#area-name').textContent = 'Cornell, Ithaca';
  } else {
    map.attributionControl.removeAttribution('Illustrative campus map');
    baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      updateWhenIdle: true,
    }).addTo(map);
    baseLayer.on('tileerror', () => {
      $('#map-error').hidden = false;
      $('#map-error').textContent = 'Background tiles are unavailable. Walking paths and reports are still shown.';
    });
    $('#area-name').textContent = 'Your local area';
  }
  $('#map-error').hidden = true;
  $('#data-badge').innerHTML = `<span class="status-dot"></span>${mode === 'sample' ? 'Sample area' : 'OpenStreetMap'}<span class="badge-divider"></span><span>${mode === 'sample' ? 'Explore the controls' : 'Live walking paths'}</span>`;
  $('#report-caption').textContent = mode === 'sample' ? 'Sample reports · for exploration' : 'Your reports · this session';
  $('#status-text').textContent = mode === 'sample' ? 'Sample routes and reports · saved in this session' : 'OpenStreetMap paths · reports saved in this session';
  for (const segment of graph.segments) {
    L.polyline(segment.geometry.map(latitudeLongitude), {
      color: mode === 'sample' ? '#c8cdc4' : '#919fb5', weight: mode === 'sample' ? 1.5 : 3, opacity: 0.6,
    }).addTo(pathLayer);
  }
  for (const node of graph.nodes.values()) {
    const marker = L.circleMarker(latitudeLongitude(node), { radius: 3, color: '#87958a', weight: 1.5, fillColor: '#fff', fillOpacity: 1 }).addTo(nodeLayer);
    marker.bindTooltip(nodeName(node.id));
    marker.on('click', (event) => {
      L.DomEvent.stopPropagation(event);
      if (picking) { map.fire('click', { latlng: marker.getLatLng() }); return; }
      chooseNode(node.id, Boolean(event.originalEvent?.shiftKey));
    });
  }
  populateSelects();
  const defaults = mode === 'sample' ? { from: 1, to: 5 } : liveEndpoints();
  setSelectedNode($('#origin'), defaults.from);
  setSelectedNode($('#destination'), defaults.to);
  if (mode === 'sample') seedReports();
  renderIncidents();
  updateRouteFromForm(false);
  fitArea();
}

function seedReports() {
  const now = Date.now() / 1000;
  const examples = [
    ['closure', 540, 484, 4 * 60, 'Library Walk · sample'],
    ['hazard', 340, 480, 19 * 60, 'West Library Walk · sample'],
    ['uneven', 710, 339, 42 * 60, 'Goldwin Smith Walk · sample'],
  ];
  for (const [category, x, y, age, locationName] of examples) {
    const location = sampleCoordinate(x, y);
    const match = index.nearest(location);
    const definition = INCIDENT_CATEGORIES[category];
    const event = costs.recordEvent(match.edgeIds, { ...definition, timestamp: now - age,
      coordinate: { lat: location.lat, lng: location.lon } });
    reports.set(event.id, { event, edgeIds: match.edgeIds, category, source: 'sample', locationName });
  }
}

function updateRouteFromForm(fit) {
  const from = nodeId($('#origin').value), to = nodeId($('#destination').value);
  routeEndpoints = { from, to };
  renderRoute(fit);
}
function renderRoute(fit = false) {
  if (!routeEndpoints) return;
  const { from, to } = routeEndpoints;
  const now = Date.now() / 1000;
  const route = shortestPath(graph, from, to, { costs, timestamp: now });
  routeLayer.clearLayers();
  $('#route-error').hidden = Boolean(route);
  $('#route-summary').hidden = !route;
  if (!route) { $('#route-error').textContent = 'No walking route is available between these points. Try another destination or check active closures.'; return; }
  const geometry = [];
  const segments = new Map(graph.segments.map((segment) => [segment.id, segment]));
  for (const edgeId of route.edgeIds) {
    const edge = graph.edges.get(edgeId);
    const points = segments.get(edge.segmentId).geometry;
    geometry.push(...(edge.direction === 'backward' ? [...points].reverse() : points).map(latitudeLongitude));
  }
  if (geometry.length) {
    L.polyline(geometry, { color: '#fff', weight: 9, opacity: 0.95, lineJoin: 'round' }).addTo(routeLayer);
    L.polyline(geometry, { color: '#2459e0', weight: 4, opacity: 1, lineJoin: 'round' }).addTo(routeLayer);
  }
  const origin = graph.nodes.get(from), destination = graph.nodes.get(to);
  for (const [coordinate, label, end] of [[origin, 'A', false], [destination, 'B', true]]) {
    L.marker(latitudeLongitude(coordinate), { icon: L.divIcon({ className: '', html: `<span class="endpoint-icon ${end ? 'end' : ''}">${label}</span>`, iconSize: [30,30], iconAnchor: [15,15] }), zIndexOffset: 1000, title: `${end ? 'Destination' : 'Start'}: ${nodeName(coordinate.id)}` }).addTo(routeLayer);
  }
  const durationSeconds = route.edgeIds.reduce((sum, id) => sum + costs.baselineCostSeconds(id, now), 0);
  $('#route-minutes').textContent = String(Math.max(from === to ? 0 : 1, Math.ceil(durationSeconds / 60)));
  $('#route-distance').textContent = route.distanceMeters >= 1000 ? `${(route.distanceMeters / 1000).toFixed(1)} km` : `${Math.round(route.distanceMeters)} m`;
  $('#route-context').textContent = from === to ? 'You’re already at your destination.' : 'Current reports are considered along this route.';
  if (fit && geometry.length) map.fitBounds(L.latLngBounds(geometry).pad(0.2), { animate: !reducedMotion.matches, padding: [70,80] });
}
$('#route-form').addEventListener('submit', (event) => { event.preventDefault(); updateRouteFromForm(true); });
$('#swap-route').addEventListener('click', () => {
  const origin = $('#origin').value; $('#origin').value = $('#destination').value; $('#destination').value = origin;
  updateRouteFromForm(false);
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
  const detail = document.createElement('p'); detail.textContent = metadata?.source === 'sample' ? 'Illustrative report in the sample area.' : 'Reported in this session.';
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
  const valid = Boolean(match) && precise;
  for (const button of document.querySelectorAll('[data-category]')) button.disabled = !valid;
  $('#report-location').textContent = valid ? (location.source === 'device' ? 'Location captured. Tap a category to report.' : 'Map point captured. Tap a category to report.') : 'This location needs a little help.';
  $('#coordinate-label').textContent = `${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}${location.source === 'device' ? ` · ±${Math.round(location.accuracyMeters)} m` : ' · chosen on map'}`;
  $('#report-location-error').hidden = valid;
  $('#report-location-error').textContent = !precise ? 'Location is too imprecise. Choose a point on the map instead.' : 'You’re outside the loaded walking paths. Load your local area or choose a map point.';
}
$('#report-trigger').addEventListener('click', async () => {
  picking = false; $('#pick-banner').hidden = true;
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
  closeDialog('report-dialog'); picking = true; $('#pick-banner').hidden = false;
  $('#map').focus();
});
$('#cancel-pick').addEventListener('click', () => { picking = false; $('#pick-banner').hidden = true; $('#report-trigger').focus(); });
map.on('click', ({ latlng }) => {
  if (!picking) return;
  picking = false; $('#pick-banner').hidden = true;
  setReportLocation({ lat: latlng.lat, lon: latlng.lng, timestamp: Date.now() / 1000, source: 'map', accuracyMeters: 0 });
  $('#report-dialog').showModal(); $('#report-trigger').setAttribute('aria-expanded', 'true');
});
// Leaflet exposes keyboard panning; Enter places a fallback report at the map center.
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
  locationMarker?.remove(); locationCircle?.remove();
  locationCircle = L.circle(latitudeLongitude(location), { radius: location.accuracyMeters, color: '#2459e0', weight: 1, opacity: 0.2, fillOpacity: 0.06 }).addTo(map);
  locationMarker = L.marker(latitudeLongitude(location), { icon: L.divIcon({ className: '', html: '<span class="user-location"></span>', iconSize: [18,18], iconAnchor: [9,9] }), title: 'Your device location' }).addTo(map);
  map.setView(latitudeLongitude(location), 17, { animate: !reducedMotion.matches });
}
$('#locate').addEventListener('click', async () => {
  const button = $('#locate'); button.disabled = true;
  try { showLocation(await captureDeviceLocation()); } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
});

async function loadArea(bounds) {
  if (loadingArea) return;
  if (bounds.north - bounds.south > 0.04 || bounds.east - bounds.west > 0.04) throw new Error('Zoom in to a neighborhood before loading walking paths.');
  const generation = ++areaGeneration;
  loadingArea = true;
  for (const id of ['load-visible','load-nearby']) $(`#${id}`).disabled = true;
  $('#load-visible').textContent = 'Loading walking paths…';
  $('#area-error').hidden = true;
  try {
    const { graph: nextGraph } = await loadRoutingZone(bounds);
    if (generation !== areaGeneration) return;
    if (!nextGraph.edges.size) throw new Error('No pedestrian paths were found in this view. Try another area.');
    const streetNames = new Map();
    for (const edge of nextGraph.edges.values()) {
      if (edge.tags.name) { streetNames.set(edge.from, edge.tags.name); streetNames.set(edge.to, edge.tags.name); }
    }
    const names = new Map([...nextGraph.nodes].map(([id,node], i) => [id, node.tags.name ?? streetNames.get(id) ?? `Map point ${i + 1}`]));
    setGraph(nextGraph, names, 'live');
    closeDialog('area-dialog'); notify('Local walking paths loaded. Choose your start and destination.');
  } finally {
    loadingArea = false;
    for (const id of ['load-visible','load-nearby']) $(`#${id}`).disabled = false;
    $('#load-visible').innerHTML = `${icon('layers')}Load area in view`;
  }
}
function areaError(error) { $('#area-error').textContent = error.message; $('#area-error').hidden = false; }
$('#load-visible').addEventListener('click', async () => {
  const bounds = map.getBounds();
  try { await loadArea({ south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() }); }
  catch (error) { areaError(error); }
});
$('#load-nearby').addEventListener('click', async () => {
  $('#load-nearby').disabled = true;
  try {
    const location = await captureDeviceLocation();
    await loadArea({ south: location.lat - 0.006, north: location.lat + 0.006, west: location.lon - 0.008, east: location.lon + 0.008 });
    showLocation(location);
  } catch (error) { areaError(error); }
  finally { $('#load-nearby').disabled = false; }
});
function restoreSample() {
  areaGeneration++;
  const { graph: sampleGraph, places } = createSampleArea(); setGraph(sampleGraph, places, 'sample');
}
$('#restore-demo').addEventListener('click', () => { restoreSample(); closeDialog('area-dialog'); notify('Sample area restored.'); });

restoreSample();
const refresh = setInterval(() => { renderIncidents(); renderRoute(); }, 10000);
window.addEventListener('pagehide', () => { clearInterval(refresh); clearTimeout(toastTimer); costs.dispose(); });
new ResizeObserver(() => map.invalidateSize()).observe($('#map'));
