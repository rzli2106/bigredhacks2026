import { haversine } from '../src/routing/geo.js';
import { routeProgress } from './navigation-state.js';

/** Require a fresh, plausible crossing, not merely a hazard behind the first fix. */
export class PassedHazards {
  constructor() { this.reset(); }
  reset() { this.approaches = new Map(); this.seen = new Set(); this.last = null; this.instance = null; }
  observe(route, snapshot, point, now = Date.now() / 1000) {
    if (snapshot?.instance_id !== this.instance) { this.reset(); this.instance = snapshot?.instance_id; }
    if (!route || route.status !== 'ok' || !point || !Number.isFinite(point.timestamp) ||
        now - point.timestamp > 10 || point.timestamp > now + 5 || !Number.isFinite(point.accuracyMeters) || point.accuracyMeters > 20 || point.accuracyMeters < 0) {
      this.approaches.clear(); this.last = null; return [];
    }
    const routeKey = route.edgeIds.join('|');
    if (routeKey !== this.routeKey) { this.approaches.clear(); this.routeKey = routeKey; }
    if (this.last && point.timestamp <= this.last.timestamp) return [];
    const validMovement = !this.last || (point.timestamp - this.last.timestamp <= 15 && haversine(this.last, point) / (point.timestamp - this.last.timestamp) <= 6);
    if (!validMovement) this.approaches.clear();
    this.last = point;
    const position = routeProgress(route.geometry, point), events = snapshot?.events ?? [];
    const ids = new Set(events.map(event => event.id));
    for (const id of this.approaches.keys()) if (!ids.has(id)) this.approaches.delete(id);
    if (position.distance > 20) { this.approaches.clear(); return []; }
    const passed = [];
    for (const event of events) {
      if (this.seen.has(event.id) || !event.coordinate || !event.edge_ids.some(id => route.edgeIds.includes(id))) continue;
      const coordinate = { lat: event.coordinate.lat, lon: event.coordinate.lng };
      const hazard = routeProgress(route.geometry, coordinate);
      if (hazard.distance > 20 || haversine(point, coordinate) + point.accuracyMeters > 40) continue;
      const margin = Math.max(5, point.accuracyMeters);
      const passedMargin = Math.max(12, point.accuracyMeters + 2);
      if (hazard.along - position.along >= margin) this.approaches.set(event.id, point.timestamp);
      else if (position.along - hazard.along >= passedMargin && this.approaches.has(event.id)) {
        this.seen.add(event.id); this.approaches.delete(event.id); passed.push(event);
      }
    }
    return passed;
  }
}

export class HazardCheckPrompt {
  constructor({ element, label, yes, no, onAnswer, onError = () => {}, returnFocus, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) }) {
    Object.assign(this, { element, label, yes, no, onAnswer, onError, returnFocus, schedule, cancel });
    this.generation = 0;
    yes.onclick = () => this.answer('confirm'); no.onclick = () => this.answer('resolve');
  }
  show(event, name) {
    this.hide(); const generation = this.generation;
    this.event = event; this.label.textContent = `${name}: is this still here?`;
    this.element.hidden = false; this.yes.disabled = false; this.no.disabled = false;
    this.timer = this.schedule(() => { if (generation === this.generation) this.hide(); }, 3000);
  }
  hide() {
    this.cancel(this.timer); this.generation++;
    this.returnFocus?.(this.element); this.element.hidden = true; this.event = null;
  }
  answer(action) {
    if (!this.event) return;
    const event = this.event; this.hide(); const generation = this.generation;
    Promise.resolve().then(() => this.onAnswer(event, action)).catch(error => { if (generation === this.generation) this.onError(error); });
  }
}
