import { MotionService } from '../src/motion-service.js';
import { NativeMotionService } from './native-motion.js';
import { captureLocation, watchLocation } from './location.js';
import { withinCornell } from '../src/ui/cornell.js';
import { SHOCK_GATE } from '../src/telemetry/policy.js';
import { DeviceTransport, WebSocketMotionTransport, registerDevice, request } from './connection.js';
import { Health, nativePlatform } from './health.js';
import { HealthAnalyzer } from './health-analysis.js';
import { MobileNavigation } from './mobile-navigation.js';

const $ = selector => document.querySelector(selector);
let deviceSession, transport, rawTransport, navigation, healthTimer, location, locationStart;
let sharing = false, sharingGeneration = 0, locationGeneration = 0, sent = 0;
let stopLocation = () => {}, lastMotion = 0, lastUnsafeMotion = 0, lastShock = 0, lastPassage = 0;
let reportLocation, reportCategory, reportPayload, reportMap, reportMarker, reportGeneration = 0, reportSending = false;
const locations = [], analyzer = new HealthAnalyzer();

function message(text) { $('#phone-message').hidden = false; $('#message-text').textContent = text; }
$('#close-message').onclick = () => { $('#phone-message').hidden = true; };
function countReport() { $('#sent-count').textContent = String(++sent); }
let sessionRequest;
async function ensureSession() {
  if (deviceSession && (!deviceSession.expiresAt || deviceSession.expiresAt > Date.now() / 1000 + 30)) return deviceSession;
  sessionRequest ??= registerDevice(undefined, deviceSession).then(session => {
    deviceSession = session; $('#connection').textContent = 'Connected'; return session;
  }).finally(() => { sessionRequest = null; });
  return sessionRequest;
}
function freshLocation() {
  if (!location || Date.now() / 1000 - location.timestamp > 10 || location.accuracyMeters > 20 || !withinCornell(location)) throw new Error('A fresh, precise Cornell location is needed.');
  return location;
}
function receiveLocation(point) {
  location = point; navigation?.updateLocation(point);
  if (!sharing) return;
  locations.push(point);
  while (locations.length > 300 || locations[0]?.timestamp < Date.now() / 1000 - 180) locations.shift();
  submitPassage();
  $('#phone-status').textContent = withinCornell(point) ? `Location ±${Math.round(point.accuracyMeters)} m · sharing is active` : 'Outside Cornell coverage. Automatic reports are paused.';
}
async function ensureLocation() {
  if (!window.isSecureContext) throw new Error('Open this phone page over HTTPS to enable location.');
  if (!locationStart) {
    const generation = locationGeneration;
    locationStart = watchLocation(point => { if (generation === locationGeneration) receiveLocation(point); }, error => {
      if (generation === locationGeneration) $('#phone-status').textContent = `Location: ${error.message}`;
    }).then(stopWatch => { if (generation === locationGeneration) stopLocation = stopWatch; else stopWatch(); }).catch(error => { if (generation === locationGeneration) locationStart = null; throw error; });
  }
  await locationStart;
  if (!location || Date.now() / 1000 - location.timestamp > 10) {
    const generation = locationGeneration, point = await captureLocation();
    if (generation !== locationGeneration) throw new Error('Location request canceled.');
    receiveLocation(point);
  }
  return location;
}
navigation = new MobileNavigation({ api: deviceSession?.api, getLocation: () => location, ensureLocation, notify: message });
const Motion = nativePlatform() ? NativeMotionService : MotionService;
const motion = new Motion({
  bridge: Health, config: { rotationLimitRadS: SHOCK_GATE.gyroLimitDegS * Math.PI / 180 },
  onRawSample: sample => rawTransport?.enqueue(sample),
  onSamples: () => { lastMotion = Date.now() / 1000; },
  onStatus: status => {
    if (status.state === 'sample-dropped') lastUnsafeMotion = Date.now() / 1000;
    if (status.state === 'listening') $('#sensor-status').textContent = 'Motion permission granted · waiting for sensor samples';
  },
  onCandidate: candidate => {
    if (!sharing || candidate.peakAcceleration <= SHOCK_GATE.accelerationThreshold) return;
    lastShock = Date.now() / 1000;
    if (!nativePlatform()) return; // Browser hazards are derived from raw samples on the backend.
    try {
      const point = freshLocation();
      transport.enqueue({ lat: point.lat, lng: point.lon, accuracy_meters: point.accuracyMeters, source: 'native_motion', metric_type: 'SENSOR_SHOCK', severity: 1, timestamp: Date.now() / 1000,
        evidence: { gyro_deg_s: candidate.peakAngularSpeed * 180 / Math.PI, peak_jerk: candidate.peakJerk, peak_acceleration: candidate.peakAcceleration, fwhm_ms: candidate.fwhmMs } });
    } catch (error) { $('#phone-status').textContent = error.message; }
  },
});
async function submitPassage() {
  if (!sharing || Date.now() / 1000 - lastPassage < 10 || Date.now() / 1000 - lastMotion > 1) return;
  const trace = locations.slice(-30), start = trace[0]?.timestamp;
  if (trace.length < 8 || start <= Math.max(lastUnsafeMotion, lastShock) || trace.some((point, i) => point.accuracyMeters > .25 || (i > 0 && point.timestamp - trace[i - 1].timestamp > .5))) return;
  lastPassage = Date.now() / 1000;
  try { await request('/api/telemetry/passage', { api: deviceSession.api, token: deviceSession.token, method: 'POST', body: { device_id: deviceSession.deviceId, passage_id: crypto.randomUUID(), shock_detected: false,
    trace: trace.map(point => ({ lat: point.lat, lng: point.lon, timestamp: point.timestamp, accuracy_meters: point.accuracyMeters })) } }); } catch (error) { message(error.message); }
}
async function readHealth() {
  const activeTransport = transport;
  try { const { samples } = await Health.readSamples(); if (!sharing || activeTransport !== transport) return; for (const event of analyzer.ingest(samples, locations)) activeTransport.enqueue(event); }
  catch (error) { if (sharing && activeTransport === transport) $('#health-status').textContent = `Health: ${error.message}`; }
}
$('#start').onclick = async () => {
  navigation.unlockAudio();
  if (!window.isSecureContext) { message('Open this phone page over HTTPS to enable motion and location.'); return; }
  $('#start').disabled = true; sharing = true; const generation = ++sharingGeneration;
  // iOS permission request runs directly in this tap, before any await/network call.
  const motionRequest = motion.start().then(() => true).catch(error => {
    if (generation !== sharingGeneration) return;
    rawTransport?.stop(); $('#sensor-status').textContent = `Motion: ${error.message}`; message(`Motion: ${error.message} Manual reporting remains available.`); return false;
  });
  const locationRequest = ensureLocation().catch(error => { if (generation === sharingGeneration) $('#phone-status').textContent = error.message; });
  $('#start').hidden = true; $('#stop').hidden = false;
  try {
    await ensureSession(); if (!sharing || generation !== sharingGeneration) return;
    const motionAllowed = await motionRequest; if (!sharing || generation !== sharingGeneration) return;
    transport = new DeviceTransport({ ...deviceSession, onStatus: status => { $('#connection').textContent = status; }, onRejected: message, onSent: countReport }); transport.start();
    if (!nativePlatform() && motionAllowed) {
      rawTransport = new WebSocketMotionTransport({ ...deviceSession, getLocation: () => { try { const point = freshLocation(); return { lat: point.lat, lng: point.lon, accuracy_meters: point.accuracyMeters, timestamp: point.timestamp }; } catch { return null; } },
        onStatus: status => { $('#sensor-status').textContent = status; }, onSent: countReport }); rawTransport.start();
    }
    await locationRequest; if (!sharing || generation !== sharingGeneration) return;
    if (nativePlatform()) {
      const availability = await Health.availability(); if (!sharing || generation !== sharingGeneration) return;
      if (availability.available) {
        await Health.requestPermissions(); if (!sharing || generation !== sharingGeneration) return;
        await Health.startMonitoring(); if (!sharing || generation !== sharingGeneration) { await Health.stopMonitoring(); return; }
        healthTimer = setInterval(readHealth, 30000); readHealth(); $('#health-status').textContent = 'Native health access requested · fresh samples matched to location';
      } else $('#health-status').textContent = availability.reason || 'Native health is unavailable.';
    }
  } catch (error) { if (generation === sharingGeneration) { stopSensors(); message(error.message); } }
  finally { if (generation === sharingGeneration) $('#start').disabled = false; }
};
function stopSensors() {
  sharing = false; ++sharingGeneration; motion.stop(); rawTransport?.stop(); rawTransport = null; transport?.stop(); clearInterval(healthTimer);
  if (nativePlatform()) Health.stopMonitoring().catch(() => {});
  locations.length = 0; $('#start').hidden = false; $('#start').disabled = false; $('#stop').hidden = true;
  $('#connection').textContent = 'Ready'; $('#sensor-status').textContent = 'Sensors stopped';
  $('#phone-status').textContent = 'Sensor sharing stopped. GPS navigation remains active.';
}
$('#stop').onclick = stopSensors;
window.addEventListener('pagehide', () => { stopSensors(); ++locationGeneration; stopLocation(); locationStart = null; navigation.stop(); });
window.addEventListener('pageshow', event => {
  if (event.persisted) { navigation.connect(); navigation.resize.observe($('#navigation-map')); navigation.map.invalidateSize(); if (location) ensureLocation().catch(message); }
});

function setReport(point) {
  if (!withinCornell(point) || point.accuracyMeters > 50) throw new Error('A GPS fix inside Cornell with accuracy within 50 m is required. Reopen the report to try again.');
  reportLocation = Object.freeze({ ...point }); $('#phone-map').hidden = false;
  const coordinate = [point.lat, point.lon], L = window.L;
  if (!reportMap) {
    reportMap = L.map('phone-map', { dragging: true, touchZoom: true, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, zoomControl: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(reportMap);
  }
  reportMarker?.remove(); reportMarker = L.marker(coordinate, { draggable: true, keyboard: true, autoPan: true, title: 'Drag pin to exact hazard location' }).addTo(reportMap);
  reportMarker.on('dragend', () => {
    if (reportPayload || reportSending) return;
    const pin = reportMarker.getLatLng(), point = { lat: pin.lat, lon: pin.lng };
    if (!withinCornell(point)) {
      reportMarker.setLatLng([reportLocation.lat, reportLocation.lon]);
      $('#location-status').textContent = 'Keep the hazard pin inside Cornell coverage.'; return;
    }
    reportLocation = Object.freeze({ ...reportLocation, ...point, accuracyMeters: 0, timestamp: Date.now() / 1000 });
    $('#chosen-coordinate').textContent = `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`;
    $('#location-status').textContent = 'Hazard pin moved. Choose a category, then confirm.';
  });
  requestAnimationFrame(() => { reportMap.invalidateSize(); reportMap.setView(coordinate, 18, { animate: false }); });
  $('#location-status').textContent = `GPS captured · accuracy ±${Math.round(point.accuracyMeters)} m. Choose a category.`;
  $('#chosen-coordinate').textContent = `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`;
  $('#expand-report-map').disabled = false; document.querySelectorAll('[data-metric]').forEach(button => { button.disabled = false; });
}
$('#phone-report').onclick = async () => {
  navigation.unlockAudio(); const generation = ++reportGeneration;
  reportLocation = null; reportCategory = null; reportPayload = null; reportSending = false;
  $('#phone-report-dialog').classList.remove('expanded'); $('#expand-report-map').textContent = 'Expand map'; $('#expand-report-map').setAttribute('aria-expanded', 'false'); $('#expand-report-map').disabled = true;
  document.querySelectorAll('[data-metric]').forEach(button => { button.disabled = true; button.setAttribute('aria-pressed', 'false'); });
  $('#confirm-report').disabled = true; $('#confirm-report').textContent = 'Confirm Report'; $('#location-status').textContent = 'Capturing your current GPS location…'; $('#chosen-coordinate').textContent = ''; $('#phone-map').hidden = true;
  $('#phone-report-dialog').showModal();
  try { const point = await captureLocation(); if (generation === reportGeneration && $('#phone-report-dialog').open) { receiveLocation(point); setReport(point); } }
  catch (error) { if (generation === reportGeneration) $('#location-status').textContent = `GPS unavailable. ${error.message.replace(/Choose a map point instead\.|Choose a point on the map instead\./g, '')} Reopen the report to retry.`; }
};
$('#phone-report-dialog').addEventListener('close', () => { reportGeneration++; });
$('#close-report').onclick = () => $('#phone-report-dialog').close();
$('#expand-report-map').onclick = () => {
  const expanded = $('#phone-report-dialog').classList.toggle('expanded');
  $('#expand-report-map').textContent = expanded ? 'Minimize map' : 'Expand map'; $('#expand-report-map').setAttribute('aria-expanded', String(expanded));
  // Wait for the CSS height transition, then keep the exact captured pin centered.
  setTimeout(() => { if (reportLocation) { reportMap.invalidateSize(); reportMap.setView([reportLocation.lat, reportLocation.lon], 18, { animate: false }); } }, 220);
};
document.querySelectorAll('[data-metric]').forEach(button => { button.onclick = () => {
  if (!reportLocation || reportSending || reportPayload) return;
  reportCategory = { metric: button.dataset.metric, category: button.dataset.category };
  document.querySelectorAll('[data-metric]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
  $('#confirm-report').disabled = false;
}; });
$('#confirm-report').onclick = async () => {
  if (!reportLocation || !reportCategory || reportSending) return;
  if (Date.now() / 1000 - reportLocation.timestamp > 120) { $('#location-status').textContent = 'This GPS fix expired. Close and reopen the report to capture it again.'; return; }
  const generation = reportGeneration; reportSending = true; $('#confirm-report').disabled = true; $('#confirm-report').textContent = 'Sending…';
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
  document.querySelectorAll('[data-metric]').forEach(button => { button.disabled = true; });
  reportMarker.dragging.disable();
  try {
    await ensureSession();
    if (generation !== reportGeneration || !$('#phone-report-dialog').open) return;
    reportPayload ??= { device_id: deviceSession.deviceId, event_id: crypto.randomUUID(), lat: reportLocation.lat, lng: reportLocation.lon,
    accuracy_meters: reportLocation.accuracyMeters, source: 'manual', metric_type: reportCategory.metric, hazard_category: reportCategory.category, severity: 1, timestamp: reportLocation.timestamp };
    const result = await request('/api/telemetry/event', { api: deviceSession.api, token: deviceSession.token, method: 'POST', body: reportPayload, signal: controller.signal });
    if (!result.accepted) throw new Error(result.reason || 'The report was not accepted.');
    if (!result.duplicate) countReport();
    if (generation === reportGeneration) { $('#phone-report-dialog').close(); message('Report confirmed. The live map has been updated.'); }
  } catch (error) {
    if (generation === reportGeneration) {
      $('#location-status').textContent = `Report could not be confirmed: ${error.message}`;
      $('#confirm-report').disabled = false; $('#confirm-report').textContent = 'Retry Confirm Report';
      // Keep the same payload/ID after network failure to avoid duplicate hazards.
    }
  } finally { clearTimeout(timeout); if (generation === reportGeneration) reportSending = false; }
};
