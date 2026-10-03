import { request, subscribe, configuration } from './connection.js';
import { CORNELL_VIEW, withinCornell } from '../src/ui/cornell.js';
import { PlaceSearch } from './place-search.js';
import { resolvePlace, hazardName, RouteAlerts, routeMinutes, etaDelta, hazardAhead, remainingSeconds, sameRoute, routeHasClosure } from './navigation-state.js';
import { haversine } from '../src/routing/geo.js';
import { incidentAppearance } from '../src/ui/reporting.js';

const $ = selector => document.querySelector(selector);
export class MobileNavigation {
  constructor({ api, getLocation, ensureLocation, notify }) {
    Object.assign(this, { getLocation, ensureLocation, notify });
    this.api = api || configuration().api; this.alerts = new RouteAlerts(); this.requestId = 0; this.planningId = 0;
    this.snapshot = null; this.options = null; this.active = null; this.pending = [];
    this.audio = new Audio('/public/chime.wav'); this.audio.volume = .25; this.sound = true;
    const L = window.L;
    this.map = L.map('navigation-map', { zoomControl: false }).fitBounds(CORNELL_VIEW);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(this.map);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.routes = L.layerGroup().addTo(this.map); this.hazards = L.layerGroup().addTo(this.map);
    this.searches = [new PlaceSearch($('#start-location'), { live: true, onSelect: () => this.cancelLocate() }), new PlaceSearch($('#destination-location'))];
    this.pinTarget = 'end';
    $('#edit-route').onclick = () => { this.setPlannerOpen(true); $('#start-location').focus(); };
    $('#return-to-map').onclick = () => this.setPlannerOpen(false);
    $('#retry-route').onclick = () => {
      if (!this.active || this.loading) return;
      clearTimeout(this.refreshTimer); this.refreshScheduled = false; this.refresh(false);
    };
    for (const target of ['start', 'end']) $('#pin-' + target).onclick = () => this.beginPin(target);
    this.map.on('click', ({ latlng }) => this.placePin({ lat: latlng.lat, lon: latlng.lng }));
    this.pinKeyboard = event => this.handlePinKey(event);
    this.map.getContainer().addEventListener('keydown', this.pinKeyboard);
    $('#route-form').onsubmit = event => { event.preventDefault(); this.unlockAudio(); this.generate(); };
    $('#locate-me').onclick = () => this.locate();
    $('#start-location').addEventListener('input', () => this.cancelLocate());
    $('#sound-toggle').onclick = () => {
      this.sound = !this.sound; $('#sound-toggle').textContent = this.sound ? 'Sound on' : 'Sound off';
      $('#sound-toggle').setAttribute('aria-pressed', String(this.sound)); if (this.sound) this.unlockAudio();
    };
    $('#accept-reroute').onclick = () => this.acceptAlternative();
    $('#dismiss-reroute').onclick = () => { this.pending = []; this.hideAlert(); };
    this.resize = new ResizeObserver(() => this.map.invalidateSize()); this.resize.observe($('#navigation-map'));
    this.connect();
  }
  setPlannerOpen(open) {
    for (const search of this.searches) search.close();
    $('#route-planner').hidden = !open; $('#edit-route').hidden = open;
    $('#edit-route').setAttribute('aria-expanded', String(open)); $('#edit-route').textContent = 'Edit route';
    $('#return-to-map').hidden = !this.active;
    $('#pin-help').hidden = open || !this.placingPin; $('#pin-reticle').hidden = open || !this.placingPin;
    if (open) {
      this.pinTarget = 'end';
      this.placingPin = false;
      for (const side of ['start', 'end']) $('#pin-' + side).setAttribute('aria-pressed', 'false');
    } else { $('#edit-route').focus(); }
  }
  beginPin(target) {
    this.cancelLocate();
    this.pinTarget = target; this.placingPin = true;
    for (const side of ['start', 'end']) $('#pin-' + side).setAttribute('aria-pressed', String(side === target));
    $('#pin-help').textContent = `Choose ${target === 'start' ? 'start' : 'destination'}: tap the map, or use arrow keys then Enter at the crosshair. Escape cancels.`;
    this.setPlannerOpen(false); $('#edit-route').textContent = `Cancel ${target} pin`;
    this.map.getContainer().focus();
  }
  placePin(point) {
    if ($('#route-planner').hidden && !this.placingPin) return;
    if (!withinCornell(point)) { this.notify(`Choose a ${this.pinTarget === 'start' ? 'starting point' : 'destination'} inside Cornell coverage.`); return; }
    const start = this.pinTarget === 'start';
    $(start ? '#start-location' : '#destination-location').value = `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`;
    if (start) this.markStart(point); else this.markDestination(point);
    this.setPlannerOpen(true); $('#route-status').textContent = `${start ? 'Start' : 'End'} pinned. Tap Start Route.`;
    $(start ? '#start-location' : '#destination-location').focus();
    this.searches[start ? 0 : 1]?.close();
  }
  handlePinKey(event) {
    if (!this.placingPin || !['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Enter') { const point = this.map.getCenter(); this.placePin({ lat: point.lat, lon: point.lng }); }
    else { const target = this.pinTarget; this.setPlannerOpen(true); $(target === 'start' ? '#start-location' : '#destination-location').focus(); }
  }
  cancelLocate() {
    this.locateId = (this.locateId || 0) + 1;
    $('#locate-me').disabled = false; $('#locate-me').textContent = 'Locate me';
  }
  async locate() {
    this.cancelLocate(); const id = this.locateId; this.unlockAudio();
    $('#locate-me').disabled = true; $('#locate-me').textContent = 'Locating…';
    try {
      await this.ensureLocation(); if (id !== this.locateId) return;
      const point = this.getLocation();
      if (!point) throw new Error('Location is unavailable. Try again or choose a pin.');
      this.map.setView([point.lat, point.lon], 18); $('#start-location').value = 'My live location';
    } catch (error) { if (id === this.locateId) this.notify(error.message); }
    finally { if (id === this.locateId) this.cancelLocate(); }
  }
  markStart(point) {
    if (this.startMarker) this.startMarker.setLatLng([point.lat, point.lon]);
    else this.startMarker = window.L.circleMarker([point.lat, point.lon], { radius: 7, color: 'white', weight: 3, fillColor: '#2459e0', fillOpacity: 1 }).addTo(this.map).bindTooltip('Start');
  }
  unlockAudio() {
    if (!this.sound || this.audioUnlocked) return;
    this.audio.muted = true;
    this.audio.play().then(() => { this.audio.pause(); this.audio.currentTime = 0; this.audio.muted = false; this.audioUnlocked = true; }).catch(() => { this.audio.muted = false; });
  }
  chime() {
    if (!this.sound) return;
    this.audio.muted = false; this.audio.currentTime = 0; this.audio.play().catch(() => {});
  }
  setApi(api) {
    if (this.api === api) return;
    this.cancelLocate(); this.api = api; this.unsubscribe?.(); this.cancelRequest(); this.alerts = new RouteAlerts(); this.pending = [];
    clearTimeout(this.refreshTimer); this.refreshScheduled = false;
    this.from = null; this.to = null; this.snapshot = null; this.signature = null;
    this.hazards.clearLayers();
    $('#route-status').textContent = 'Connection changed. Tap Start Route to plan this walk.';
    this.options = null; this.active = null; this.routeUpdateError = ''; this.renderUpdateState(); this.routes.clearLayers(); $('#route-options').replaceChildren(); $('#active-route').hidden = true; this.setPlannerOpen(true); this.hideAlert(); this.connect();
  }
  connect() {
    this.unsubscribe?.();
    const configured = configuration();
    this.unsubscribe = subscribe(snapshot => this.onSnapshot(snapshot), status => {
      $('#map-stream').textContent = status === 'Live' ? 'Live hazards' : status;
    }, { ws: this.api === configured.api ? configured.ws : `${this.api.replace(/^http/, 'ws')}/ws/stream` });
  }
  updateLocation(point) {
    const L = window.L, coordinate = [point.lat, point.lon];
    if (!this.user) this.user = L.circleMarker(coordinate, { radius: 7, weight: 3, color: 'white', fillColor: '#2459e0', fillOpacity: 1 }).addTo(this.map);
    else this.user.setLatLng(coordinate);
    if (!this.accuracy) this.accuracy = L.circle(coordinate, { radius: point.accuracyMeters, weight: 1, color: '#2459e0', fillOpacity: .07 }).addTo(this.map);
    else this.accuracy.setLatLng(coordinate).setRadius(point.accuracyMeters);
    // Refresh from live GPS on a conservative cadence. Preserve the selected line
    // while options update; hazard-driven switches always need an explicit accept.
    if (this.active && this.liveStart && withinCornell(point) &&
        this.from && haversine(point, this.from) > 15 && Date.now() - (this.lastRefresh || 0) > 10000 && !this.loading) {
      this.from = { lat: point.lat, lon: point.lon }; this.queueRefresh();
    }
    this.pending = this.pending.filter(event => hazardAhead(this.active, event, point)); this.renderAlert(false);
    this.renderActive();
  }
  markDestination(point) {
    if (this.destinationMarker) this.destinationMarker.setLatLng([point.lat, point.lon]);
    else this.destinationMarker = window.L.circleMarker([point.lat, point.lon], { radius: 9, color: 'white', weight: 3, fillColor: '#192c3b', fillOpacity: 1 }).addTo(this.map).bindTooltip('Destination');
  }
  cancelRequest() { this.requestId++; this.planningId++; this.controller?.abort(); this.loading = false; $('#find-routes').disabled = false; }
  queueRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshScheduled = true;
    const delay = Math.max(0, 1000 - (Date.now() - (this.lastRefresh || 0)));
    this.refreshTimer = setTimeout(() => { this.refreshScheduled = false; this.refresh(false); }, delay);
  }
  async generate() {
    this.cancelLocate();
    clearTimeout(this.refreshTimer); this.refreshScheduled = false;
    this.cancelRequest(); this.pending = []; this.hideAlert();
    this.active = null; this.routeUpdateError = ''; this.renderUpdateState(); this.routes.clearLayers(); $('#route-options').replaceChildren(); $('#active-route').hidden = true;
    $('#return-to-map').hidden = true;
    $('#find-routes').disabled = true; $('#route-status').textContent = 'Finding walking routes…';
    const generation = this.planningId;
    try {
      const start = $('#start-location').value.trim();
      this.liveStart = !start || /^(my live location|current location|gps)$/i.test(start);
      if (!start || /^(my live location|current location|gps)$/i.test(start)) await this.ensureLocation();
      if (generation !== this.planningId) return;
      if (!$('#destination-location').value.trim()) throw new Error('Choose a destination or tap it on the map.');
      this.from = resolvePlace(start, this.getLocation()); this.to = resolvePlace($('#destination-location').value, this.getLocation());
      this.markStart(this.from); this.markDestination(this.to); await this.refresh(true);
    } catch (error) { if (generation === this.planningId && error.name !== 'AbortError') $('#route-status').textContent = error.message; }
    finally { if (generation === this.planningId) $('#find-routes').disabled = false; }
  }
  async refresh(newTrip = false) {
    if (!this.from || !this.to) return;
    this.controller?.abort(); const id = ++this.requestId; this.controller = new AbortController();
    this.loading = true; this.lastRefresh = Date.now(); this.renderUpdateState();
    const controller = this.controller, timeout = setTimeout(() => controller.abort(), 10000);
    $('#accept-reroute').disabled = true;
    this.renderAlert(false);
    try {
      const options = await request('/api/route/options', { api: this.api, method: 'POST', body: { from: this.from, to: this.to }, signal: this.controller.signal });
      if (id !== this.requestId) return;
      this.options = options;
      if (options.direct.status !== 'ok') {
        if (newTrip) { this.active = null; this.routes.clearLayers(); $('#route-options').replaceChildren(); }
        this.routeUpdateFailed(options.direct.status === 'off-path' ? `The ${options.direct.endpoint} is more than 40 m from a walking path.` : 'No walking connection was found.');
        return;
      }
      if (newTrip && options.direct.blocked && !options.alternative) {
        $('#route-status').textContent = 'A reported closure blocks this walk. No open detour was found. Choose another destination or try again later.';
        return;
      }
      if (newTrip) { this.active = options.direct.hazard_ids.length && options.alternative ? options.alternative : options.direct; this.activeChoice = this.active === options.direct ? 'direct' : 'alternative'; this.setPlannerOpen(false); }
      this.routeUpdateError = ''; this.renderUpdateState();
      this.renderRoutes(newTrip); this.renderAlert(false);
      $('#route-status').textContent = options.alternative ? 'Walking estimates · tap a route to select it' : 'No distinct hazard-free alternative is available.';
    } catch (error) {
      if (id === this.requestId) {
        this.routeUpdateFailed(error.name === 'AbortError' ? 'Route update timed out.' : 'Route update unavailable.');
        this.renderAlert(false);
      }
    } finally { clearTimeout(timeout); if (id === this.requestId) { this.loading = false; this.renderUpdateState(); this.renderAlert(false); } }
  }
  routeUpdateFailed(message) {
    $('#route-status').textContent = `${message} Try again.`;
    this.options = null; $('#route-options').replaceChildren();
    this.routeUpdateError = `${message} Showing your previous route.`;
    this.renderUpdateState();
  }
  renderUpdateState() {
    const hidden = !this.active || !this.routeUpdateError;
    if (hidden && document.activeElement === $('#retry-route')) $('#edit-route').focus();
    $('#route-update-warning').hidden = hidden;
    $('#route-update-status').textContent = this.routeUpdateError || '';
    $('#retry-route').disabled = !!this.loading;
  }
  renderRoutes(fit = false) {
    const options = this.options;
    if (!this.active) return;
    if (!options) { this.renderActive(); return; }
    this.routes.clearLayers(); const L = window.L;
    // Keep the actual selected route visible when a server update proposes a new line.
    const available = [{ key: 'direct', label: 'Direct', route: options.direct },
      ...(options.alternative ? [{ key: 'alternative', label: 'Alternative', route: options.alternative }] : [])];
    for (const item of available) {
      const selected = sameRoute(this.active, item.route);
      L.polyline(item.route.geometry.map(p => [p.lat, p.lon]), { color: selected ? '#2459e0' : '#8b96a7', weight: selected ? 7 : 5, opacity: .85,
        dashArray: item.route.hazard_ids.length ? '8 6' : undefined }).addTo(this.routes);
    }
    if (!available.some(item => sameRoute(item.route, this.active))) {
      L.polyline(this.active.geometry.map(p => [p.lat, p.lon]), { color: '#2459e0', weight: 7, opacity: 1 }).addTo(this.routes);
    }
    $('#route-options').replaceChildren();
    for (const item of available) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'route-card';
      button.setAttribute('aria-pressed', String(sameRoute(this.active, item.route)));
      const closed = item.route.blocked || routeHasClosure(item.route, this.snapshot?.events);
      button.disabled = closed || (this.snapshot && (options.instance_id !== this.snapshot.instance_id || options.revision < this.snapshot.revision));
      const title = document.createElement('strong'); title.textContent = `${item.label} · ${routeMinutes(item.route.durationSeconds)} min`;
      const detail = document.createElement('span'); const eta = new Date(Date.now() + item.route.durationSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      detail.textContent = closed ? 'Closed · choose an open route' : `${Math.round(item.route.distanceMeters)} m · ETA ${eta}${item.route.hazard_ids.length ? ' · reported hazard' : ''}`;
      button.append(title, detail);
      button.onclick = () => { this.active = item.route; this.activeChoice = item.key; this.pending = []; this.hideAlert(); this.renderRoutes(); };
      $('#route-options').append(button);
    }
    this.renderActive();
    if (fit && this.active.geometry.length > 1) {
      const panel = $($('#route-planner').hidden ? '#edit-route' : '#route-planner').getBoundingClientRect(), dock = $('.bottom-dock').getBoundingClientRect(), map = $('#navigation-map').getBoundingClientRect();
      const landscape = map.width > map.height && map.height < 560;
      this.map.fitBounds(L.latLngBounds(this.active.geometry.map(p => [p.lat, p.lon])), {
        paddingTopLeft: landscape ? [Math.min(panel.right + 12, map.width * .4), 30] : [28, Math.min(panel.bottom + 16, map.height * .45)],
        paddingBottomRight: landscape ? [Math.min(map.width - dock.left + 12, map.width * .4), 30] : [28, Math.min(map.height - dock.top + 16, map.height * .4)], maxZoom: 18, animate: false,
      });
    }
  }
  renderActive() {
    if (!this.active) return;
    $('#active-route').hidden = false;
    const closedAhead = this.snapshot?.events.some(event => event.blocked && hazardAhead(this.active, event, this.liveStart ? this.getLocation() : null));
    $('#active-route').textContent = closedAhead ? 'Reported closure ahead · choose an open route before continuing' : `${routeMinutes(this.active.durationSeconds)} min walk · ${Math.round(this.active.distanceMeters)} m · ${routeMinutes(remainingSeconds(this.active, this.liveStart ? this.getLocation() : null))} min remaining`;
  }
  onSnapshot(snapshot) {
    const fresh = this.alerts.observe(snapshot, this.active, this.getLocation());
    const signature = snapshot.events.map(event => `${event.id}:${event.timestamp}`).sort().join('|');
    const changed = signature !== this.signature || snapshot.revision !== this.snapshot?.revision || snapshot.instance_id !== this.snapshot?.instance_id;
    this.signature = signature; this.snapshot = snapshot;
    const ids = new Set(snapshot.events.map(event => event.id));
    this.pending = [...this.pending.filter(event => ids.has(event.id)), ...fresh].filter((event, i, all) => all.findIndex(other => other.id === event.id) === i);
    this.hazards.clearLayers();
    for (const event of snapshot.events) {
      const appearance = incidentAppearance(event, snapshot.time);
      const marker = window.L.circleMarker([event.coordinate.lat, event.coordinate.lng], { radius: 8, color: 'white', weight: 2,
        fillColor: appearance.color, fillOpacity: appearance.opacity, opacity: appearance.opacity }).addTo(this.hazards);
      const label = document.createElement('span');
      label.textContent = `${hazardName(event)} · ${event.blocked ? 'Active closure' : appearance.fraction > .5 ? 'Recent report' : 'Fading report'}`; marker.bindTooltip(label);
      const element = marker.getElement();
      if (element) { element.setAttribute('role', 'img'); element.setAttribute('tabindex', '0'); element.setAttribute('aria-label', label.textContent); }
    }
    if (changed && this.active) { this.renderRoutes(); this.queueRefresh(); }
    if (fresh.length) { this.renderAlert(true); this.chime(); }
    else this.renderAlert(false);
  }
  renderAlert(animate) {
    if (!this.pending.length || !this.active) { this.hideAlert(); return; }
    const alternative = this.options?.alternative;
    const valid = alternative && this.snapshot && this.options.instance_id === this.snapshot.instance_id && this.options.revision >= this.snapshot.revision &&
      !this.snapshot.events.some(event => event.edge_ids.some(id => alternative.edgeIds.includes(id)));
    const delta = alternative ? etaDelta(alternative, { durationSeconds: remainingSeconds(this.active, this.getLocation()) }) : 0;
    $('#reroute-message').textContent = `Obstacle reported ahead: ${this.pending.map(hazardName).join(', ')}. ${valid ? `Switch to alternative route? (New ETA: +${delta} mins)` : 'Checking for a hazard-free alternative…'}`;
    if (!this.loading && !this.refreshScheduled && !valid) $('#reroute-message').textContent = `Obstacle reported ahead: ${this.pending.map(hazardName).join(', ')}. No hazard-free alternative is currently available. Your route has not changed.`;
    $('#accept-reroute').disabled = !valid || this.loading;
    $('#reroute-alert').hidden = false;
    if (animate) { $('#reroute-alert').classList.remove('enter'); void $('#reroute-alert').offsetWidth; $('#reroute-alert').classList.add('enter'); }
  }
  hideAlert() { $('#reroute-alert').hidden = true; }
  acceptAlternative() {
    if ($('#accept-reroute').disabled || !this.options?.alternative) return;
    this.active = this.options.alternative; this.activeChoice = 'alternative'; this.pending = []; this.hideAlert(); this.renderRoutes();
    this.notify('Alternative route accepted.');
  }
  resume() {
    this.map.getContainer().addEventListener('keydown', this.pinKeyboard);
    this.connect(); this.resize.observe($('#navigation-map')); this.map.invalidateSize();
  }
  stop() { this.cancelLocate(); this.map.getContainer().removeEventListener('keydown', this.pinKeyboard); this.unsubscribe?.(); clearTimeout(this.refreshTimer); this.refreshScheduled = false; this.cancelRequest(); this.resize.disconnect(); this.audio.pause(); }
}
