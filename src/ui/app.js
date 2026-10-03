import { EdgeIndex, DynamicEdgeCosts, buildWalkingGraph, routeBetweenPins, haversine } from '../routing/index.js';
import { CORNELL_BOUNDS, CORNELL_VIEW, CORNELL_PLACES, withinCornell } from './cornell.js';
import { captureDeviceLocation, INCIDENT_CATEGORIES, incidentAppearance } from './reporting.js';
import { icon, fillIcons } from './icons.js';
import { fetchCampus } from './campus-data.js';
import {ScenarioRunner} from '../../backend/simulator.js';
import {configuration,request,subscribe} from '../../frontend/connection.js';
import QRCode from 'qrcode';

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
let mode='live',runner,lastLiveSnapshot,liveSignature='',pairingLink='',serverOffset=0;
const clock=()=>mode==='simulation'&&runner?runner.baseTime+runner.offset:Date.now()/1000+serverOffset;
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
$('#undo').addEventListener('click', async () => {
  const action = undoAction; undoAction = null;
  const result=await action?.();if(result!==false)notify('Change undone.');
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
  $('#pick-banner span').textContent = kind === 'simulation' ? 'Tap a walking path to inject the selected signal.' : kind === 'report' ? 'Tap the map to place your report.' : `Tap the map to set your ${kind === 'origin' ? 'starting point' : 'destination'}.`;
  $('#pick-banner').hidden = false;
  if (['origin','destination'].includes(kind)) $(`#${kind}`).setAttribute('aria-pressed','true');
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
  runner?.dispose(); runner=new ScenarioRunner(graph); if(lastLiveSnapshot) applySnapshot(lastLiveSnapshot,true);
  renderIncidents(); renderEndpoints(); renderRoute();
  $('#area-name').textContent = 'Cornell, Ithaca';
  $('#data-badge').innerHTML = '<span class="status-dot"></span>Cornell campus<span class="badge-divider"></span><span>OpenStreetMap</span>';
  $('#report-caption').textContent = mode==='simulation'?'Fictional simulation incidents':'Shared phone and manual reports';
  $('#status-text').textContent = `Real Cornell paths · OSM snapshot ${version.slice(0,10)} · shared live telemetry`;
}

function seedReports(){
  switchMode('simulation');let added=0;
  for(const [place,metric] of [[CORNELL_PLACES[3],'MANUAL_CLOSURE'],[CORNELL_PLACES[0],'MANUAL_HAZARD'],[CORNELL_PLACES[4],'TERRAIN_DRAG']]){const point=index.nearest(place).coordinate;if(runner.engine.events().some(event=>event.event_type===metric&&haversine({lat:event.coordinate.lat,lon:event.coordinate.lng},point)<1))continue;runner.inject(point,metric);added++;}
  applySnapshot(runner.snapshot(),true);return added;
}
$('#add-samples').addEventListener('click',()=>{if(!graph)return notify('Load Cornell paths first.');const added=seedReports();notify(added?`${added} fictional incidents added in Simulation.`:'All three sample incidents are already active.');});
function renderRoute(fit = false) {
  if (!graph) return;
  const { origin, destination } = routeEndpoints;
  routeLayer.clearLayers();
  if (!origin || !destination) {
    $('#route-summary').hidden = true; $('#route-error').hidden = true; return;
  }
  const route = routeBetweenPins(graph,index,origin,destination,{ costs, timestamp:clock() });
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
  return [...events.values()].filter((event) => event.timestamp <= clock());
}
function ageLabel(timestamp, now) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60));
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} hr ago`;
}
function definitionFor(event) {
  const metadata = reports.get(event.id);
  if(event.event_type==='SENSOR_SHOCK')return {...INCIDENT_CATEGORIES.hazard,label:'Sensor shock'};
  if(event.event_type==='TERRAIN_DRAG')return {...INCIDENT_CATEGORIES.uneven,label:'Terrain drag'};
  return INCIDENT_CATEGORIES[metadata?.category ?? (event.event_type === 'MANUAL_CLOSURE' ? 'closure' : event.event_type === 'MUD' ? 'uneven' : 'hazard')];
}
function reportPopup(event) {
  const metadata = reports.get(event.id);
  const definition = definitionFor(event);
  const container = document.createElement('div');
  const heading = document.createElement('h3'); heading.textContent = definition.label;
  const detail = document.createElement('p'); detail.textContent = mode==='simulation'?'Fictional simulation signal on a real Cornell path.':`Shared ${metadata?.source??'phone'} report.`;
  const age = document.createElement('p'); age.textContent = `${ageLabel(event.timestamp, clock())} · ${event.initial_penalty === Infinity ? 'Path is impassable' : 'Influences walking routes'}`;
  const actions = document.createElement('div'); actions.className = 'popup-actions';
  const confirm = document.createElement('button'); confirm.textContent = 'Still here';
  confirm.addEventListener('click',()=>verifyReport(metadata,'confirm'));
  const resolve = document.createElement('button'); resolve.textContent = 'Mark resolved';
  resolve.addEventListener('click',()=>verifyReport(metadata,'resolve'));
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
  const now = clock();
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
  const previous = picking; stopPicking(); $(`#${previous === 'simulation' ? 'inject-simulation' : previous === 'report' ? 'report-trigger' : previous ?? 'origin'}`).focus({ preventScroll: true });
});
map.on('click', ({ latlng }) => {
  if (!picking) return;
  const kind = picking, coordinate = { lat: latlng.lat, lon: latlng.lng };
  if(kind==='simulation'){try{runner.inject(coordinate,$('#injection-type').value);stopPicking();applySnapshot(runner.snapshot(),true);notify('Simulation signal added.');}catch(error){notify(error.message);}return;}
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
for(const button of document.querySelectorAll('[data-category]')) button.addEventListener('click',async()=>{
  button.disabled=true;
  try{
    if(!reportLocation)throw new Error('Choose a location first.');if(Date.now()/1000-reportLocation.timestamp>120)throw new Error('Location expired. Close this report and capture it again.');
    const metric={closure:'MANUAL_CLOSURE',hazard:'MANUAL_HAZARD',uneven:'TERRAIN_DRAG'}[button.dataset.category];
    if(mode==='simulation'){const result=runner.inject(reportLocation,metric);applySnapshot(runner.snapshot(),true);closeDialog('report-dialog');notify('Simulation report added.',()=>{runner.verify(result.id,'resolve');applySnapshot(runner.snapshot(),true);});}
    else{const result=await sendManual(reportLocation,metric);closeDialog('report-dialog');notify('Report shared. Every observer receives the update.',()=>verifyReport({remoteId:result.id},'resolve'));}
  }catch(error){$('#report-location-error').textContent=error.message;$('#report-location-error').hidden=false;}
  finally{if(reportLocation)setReportLocation(reportLocation);}
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
      switchMode('live');
      setGraph(nextGraph,data.waymark.fetchedAt);
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
function applySnapshot(snapshot,force=false){
  if(!graph)return;
  if(mode==='live')serverOffset=snapshot.time-Date.now()/1000;
  const signature=JSON.stringify(snapshot.events.map(event=>[event.id,event.timestamp,event.initial_penalty,event.edge_ids]).concat((snapshot.edges??[]).filter(edge=>edge.congestion).map(edge=>[edge.id,edge.congestion])));
  if(mode==='live'&&!force&&signature===liveSignature){renderIncidents();renderRoute();return;}
  if(mode==='live')liveSignature=signature;
  costs?.dispose();costs=new DynamicEdgeCosts(graph,{now:clock,cleanupIntervalMs:0});
  reports.clear();pins.clear();hazardLayer.clearLayers();
  for(const remote of snapshot.events){
    const valid=remote.edge_ids.filter(id=>graph.edges.has(id));if(!valid.length)continue;
    const event=costs.recordEvent(valid,{event_type:remote.metric_type,initial_penalty:remote.blocked?Infinity:remote.initial_penalty,half_life:remote.half_life,timestamp:remote.timestamp,coordinate:remote.coordinate,closure_max:14400});
    reports.set(event.id,{event,edgeIds:valid,remoteId:remote.id,category:remote.metric_type==='MANUAL_CLOSURE'?'closure':remote.metric_type==='TERRAIN_DRAG'?'uneven':'hazard',source:mode==='simulation'?'sample':remote.source,locationName:mode==='simulation'?'Simulation':remote.source.replaceAll('_',' ')});
  }
  for(const edge of snapshot.edges??[])if(edge.congestion)costs.setCongestion([edge.id],{walkingSpeedMps:edge.congestion.walkingSpeedMps,timestamp:edge.congestion.timestamp,durationSeconds:edge.congestion.expiresAt-edge.congestion.timestamp});
  renderIncidents();renderRoute();
  if(mode==='simulation'){$('#simulation-time').value=String(runner.offset/60);$('#simulation-minute').textContent=`${(runner.offset/60).toFixed(runner.offset%60?1:0)} min`;}
}
function switchMode(next){
  if(!graph)return;stopPicking();mode=next;$('#mode-live').setAttribute('aria-pressed',String(next==='live'));$('#mode-simulation').setAttribute('aria-pressed',String(next==='simulation'));$('#simulation-panel').hidden=next!=='simulation';$('#report-caption').textContent=next==='simulation'?'Fictional simulation incidents':'Shared phone and manual reports';
  applySnapshot(next==='simulation'?runner.snapshot():lastLiveSnapshot??{time:Date.now()/1000,events:[]},true);
}
$('#mode-live').onclick=()=>switchMode('live');$('#mode-simulation').onclick=()=>switchMode('simulation');
function showResults(){const rows=runner.results.map(result=>{const row=document.createElement('div');row.className=`scenario-result ${result.passed?'passed':'failed'}`;const title=document.createElement('strong');title.textContent=`${result.passed?'PASS':'FAIL'} · Scenario ${result.scenario}`;row.append(title);for(const check of result.checks){const text=document.createElement('p');text.textContent=`${check.passed?'✓':'×'} ${check.name}${check.detail?` (${check.detail})`:''}`;row.append(text);}return row;});$('#scenario-results').replaceChildren(...rows);}
function showScenario(){const snapshot=runner.snapshot();for(const kind of ['origin','destination']){const node=kind==='origin'?snapshot.corridor.from:snapshot.corridor.to;routeEndpoints[kind]={lat:node.lat,lon:node.lon};endpointLabels[kind]=kind==='origin'?'Campus path X · start':'Campus path X · end';}renderEndpoints();applySnapshot(snapshot,true);renderRoute(true);showResults();}
function runScenario(name){if(!graph)return;switchMode('simulation');runner.run(name);showScenario();}
document.querySelectorAll('[data-scenario]').forEach(button=>button.onclick=()=>runScenario(button.dataset.scenario));
$('#run-all').onclick=()=>{if(!graph)return;switchMode('simulation');runner.results=[];for(const name of ['A','B','C','D'])runner.run(name);showScenario();};
$('#reset-simulation').onclick=()=>{runner.reset();runner.results=[];applySnapshot(runner.snapshot(),true);showResults();notify('Simulation reset.');};
$('#simulation-time').oninput=()=>{runner.seek(Number($('#simulation-time').value));applySnapshot(runner.snapshot(),true);};
$('#inject-simulation').onclick=()=>startPicking('simulation');
async function createPair(){const data=await request('/api/pairing',{method:'POST',token:$('#observer-key').value.trim(),body:{mobile_url:configuration().mobile}});pairingLink=data.url;return data;}
async function sendManual(point,metric){const result=await request('/api/telemetry/manual',{method:'POST',token:$('#observer-key').value.trim(),body:{device_id:'observer-manual',event_id:crypto.randomUUID(),lat:point.lat,lng:point.lon,accuracy_meters:point.accuracyMeters,source:'manual',metric_type:metric,severity:1,timestamp:Date.now()/1000}});lastLiveSnapshot=await request('/api/telemetry/snapshot');if(mode==='live')applySnapshot(lastLiveSnapshot);return result;}
async function verifyReport(metadata,action){try{if(mode==='simulation'){runner.verify(metadata.remoteId,action);applySnapshot(runner.snapshot(),true);}else{await request('/api/telemetry/verify',{method:'POST',token:$('#observer-key').value.trim(),body:{id:metadata.remoteId,action}});lastLiveSnapshot=await request('/api/telemetry/snapshot');applySnapshot(lastLiveSnapshot);}map.closePopup();notify(action==='confirm'?'Report refreshed.':'Report marked resolved.');return true;}catch(error){notify(error.message);return false;}}
$('#connect-device').onclick=()=>{$('#pair-error').hidden=true;$('#connect-dialog').showModal();createPairingQr();};
async function createPairingQr(){const button=$('#create-pairing');if(button.disabled)return;button.disabled=true;$('#pair-error').hidden=true;$('#pairing-qr').hidden=true;$('#copy-pairing').hidden=true;$('#pairing-link').hidden=true;$('#pair-link-label').hidden=true;$('#pair-expiry').textContent='';$('#copy-status').textContent='';pairingLink='';try{const data=await createPair();await QRCode.toCanvas($('#pairing-qr'),data.url,{width:240,margin:2,errorCorrectionLevel:'M'});$('#pairing-qr').hidden=false;$('#copy-pairing').hidden=false;$('#pairing-link').hidden=false;$('#pair-link-label').hidden=false;$('#pairing-link').value=data.url;$('#pair-expiry').textContent=`Expires ${new Date(data.expires_at*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}. Scan only on a device you trust.`;}catch(error){$('#pair-error').textContent=error.message;$('#pair-error').hidden=false;}finally{button.disabled=false;}}
$('#create-pairing').onclick=createPairingQr;
$('#copy-pairing').onclick=async()=>{try{await navigator.clipboard.writeText(pairingLink);$('#copy-status').textContent='Pairing link copied.';}catch{$('#copy-status').textContent='Clipboard is unavailable. Select and copy the link above, or scan the QR.';}};
const unsubscribe=subscribe(snapshot=>{lastLiveSnapshot=snapshot;$('#device-count').textContent=String(snapshot.connected_devices??0);if(mode==='live')applySnapshot(snapshot);},status=>$('#stream-status').textContent=status);
loadArea().catch((error) => { $('#map-error').hidden = false; $('#map-error').textContent = error.message; });
const refresh = setInterval(() => { if (costs) { renderIncidents(); renderRoute(); } },10000);
window.addEventListener('pagehide', () => { unsubscribe();runner?.dispose(); clearInterval(refresh); clearTimeout(toastTimer); costs?.dispose(); });
new ResizeObserver(() => {
  map.invalidateSize();
  if (picking) return;
  if (viewIntent === 'route' && graph) renderRoute(true);
  else if (viewIntent === 'campus') fitArea();
}).observe($('#map'));
