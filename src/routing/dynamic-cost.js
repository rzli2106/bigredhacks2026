import { validateCoordinate } from './geo.js';

export const EVENT_DEFAULTS = Object.freeze({
  POTHOLE: Object.freeze({ initial_penalty: 50, half_life: 1800 }),
  MUD: Object.freeze({ initial_penalty: 100, half_life: 1800 }),
  MANUAL_HAZARD: Object.freeze({ initial_penalty: 300, half_life: 14400 }),
  MANUAL_CLOSURE: Object.freeze({ initial_penalty: Infinity, half_life: 14400 }),
});

const validTime = (time) => {
  if (!Number.isFinite(time) || time < 0) throw new RangeError('Time must be Unix seconds, finite and nonnegative.');
  return time;
};

/** In-memory evidence store. Occurrence and evaluation timestamps use Unix SECONDS. */
export class DynamicEdgeCosts {
  #events = new Map();
  #sequence = 0;
  #timer;

  constructor(graph, {
    now = () => Date.now() / 1000,
    closureMaxSeconds = 14400,
    cleanupIntervalMs = 60000,
  } = {}) {
    if (!Number.isFinite(closureMaxSeconds) || closureMaxSeconds <= 0) throw new RangeError('closureMaxSeconds must be positive.');
    if (!Number.isFinite(cleanupIntervalMs) || cleanupIntervalMs < 0) throw new RangeError('cleanupIntervalMs must be nonnegative.');
    if (typeof now !== 'function') throw new TypeError('now must be a clock function.');
    validTime(now());
    this.graph = graph;
    this.now = now;
    this.closureMaxSeconds = closureMaxSeconds;
    for (const [id, edge] of graph.edges) {
      if (!Number.isFinite(edge.distanceMeters) || edge.distanceMeters < 0) throw new RangeError(`Invalid baseline distance for ${id}.`);
      this.#events.set(id, []);
    }
    if (cleanupIntervalMs > 0) {
      this.#timer = setInterval(() => this.prune(), cleanupIntervalMs);
      this.#timer.unref?.();
    }
  }

  dispose() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #assertEdge(edgeId) {
    if (!this.#events.has(edgeId)) throw new Error(`Unknown graph edge: ${edgeId}`);
  }

  /** A snapshot of EdgeEventList[edge_id]; callers cannot mutate the store. */
  get EdgeEventList() {
    return new Map([...this.#events].map(([id, events]) => [id, [...events]]));
  }

  getEvents(edgeId) {
    this.#assertEdge(edgeId);
    return [...this.#events.get(edgeId)];
  }

  /** Apply a verified report to one edge or explicitly to multiple directed edges. */
  recordEvent(edgeIds, report = {}) {
    const ids = [...new Set(Array.isArray(edgeIds) ? edgeIds : [edgeIds])];
    if (!ids.length) throw new Error('At least one edge is required.');
    ids.forEach((id) => this.#assertEdge(id));
    if (!Object.hasOwn(EVENT_DEFAULTS, report.event_type)) throw new TypeError('Unknown event_type.');
    const defaults = EVENT_DEFAULTS[report.event_type];
    const initial_penalty = report.initial_penalty ?? defaults.initial_penalty;
    const half_life = report.half_life ?? defaults.half_life;
    const timestamp = validTime(report.timestamp ?? this.now());
    if (!(initial_penalty > 0) || (!Number.isFinite(initial_penalty) && initial_penalty !== Infinity)) {
      throw new RangeError('initial_penalty must be positive or Infinity.');
    }
    if (initial_penalty === Infinity && report.event_type !== 'MANUAL_CLOSURE') {
      throw new RangeError('Only MANUAL_CLOSURE may have an infinite penalty.');
    }
    if (!Number.isFinite(half_life) || half_life <= 0) throw new RangeError('half_life must be positive seconds.');
    validateCoordinate({ lat: report.coordinate?.lat, lon: report.coordinate?.lng });
    const closure_max = report.closure_max ?? this.closureMaxSeconds;
    if (!Number.isFinite(closure_max) || closure_max <= 0) throw new RangeError('closure_max must be positive seconds.');
    const event = Object.freeze({
      id: ++this.#sequence,
      event_type: report.event_type,
      initial_penalty, half_life, timestamp,
      coordinate: Object.freeze({ lat: report.coordinate.lat, lng: report.coordinate.lng }),
      ...(initial_penalty === Infinity ? { closure_max } : {}),
    });
    // Validation completes before modifying any edge; one immutable observation is shared.
    for (const id of ids) this.#events.get(id).push(event);
    return event;
  }

  #expired(event, time) {
    const age = time - event.timestamp;
    if (age < 0) return false;
    if (event.initial_penalty === Infinity) return age >= event.closure_max;
    // Log-domain comparison avoids penalty underflow and keeps exactly 1%.
    return age / event.half_life > Math.log2(100);
  }

  #pruneEdge(edgeId, time) {
    const events = this.#events.get(edgeId);
    const retained = events.filter((event) => !this.#expired(event, time));
    if (retained.length !== events.length) this.#events.set(edgeId, retained);
    return events.length - retained.length;
  }

  /** Sweeps all edges, including those not visited by routing. Returns removed attachments. */
  prune(time = this.now()) {
    validTime(time);
    let removed = 0;
    for (const id of this.#events.keys()) removed += this.#pruneEdge(id, time);
    return removed;
  }

  weight(edgeId, time = this.now()) {
    this.#assertEdge(edgeId);
    validTime(time);
    this.#pruneEdge(edgeId, time);
    let cost = this.graph.edges.get(edgeId).distanceMeters;
    for (const event of this.#events.get(edgeId)) {
      const age = time - event.timestamp;
      if (age < 0) continue; // A future observation is inactive until its occurrence time.
      if (event.initial_penalty === Infinity) return Infinity;
      cost += event.initial_penalty * 2 ** (-age / event.half_life);
    }
    return cost;
  }

  /** One evaluation time per route; never mix meter penalties with baseline seconds. */
  evaluator(time = this.now()) {
    validTime(time);
    return (edgeId) => this.weight(edgeId, time);
  }
}
