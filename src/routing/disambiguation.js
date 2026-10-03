import { analyzePassage, extractDeflections, localProjection, pointSegmentDistance, spatialEntropy } from './spatial-evidence.js';

export const DISAMBIGUATION_DEFAULTS = Object.freeze({
  clearanceMeters: 0.8, avoidanceMeters: 2.5,
  maxSampleGapSeconds: 0.5, maxSpeedMps: 6, maxTraceAgeSeconds: 60,
  cellSizeMeters: 0.5, windowSeconds: 60, entropyThresholdBits: 2,
  minDeflections: 8, minObservers: 3, corridorRadiusMeters: 3,
  congestionSpeedMps: 0.7,
  minTurnDegrees: 30, minTurnTravelMeters: 0.5, minSeparationSeconds: 1, slowdownRatio: 0.5,
});

const timeCheck = (time) => {
  if (!Number.isFinite(time) || time < 0) throw new RangeError('Expected a nonnegative Unix timestamp in seconds.');
};
const idCheck = (id) => {
  if (typeof id !== 'string' || !id.length) throw new TypeError('Evidence IDs must be nonempty strings.');
};

/** Caller supplies matched traces and extracted turn/slowdown points. */
export class DisambiguationEngine {
  #windows = new Map();
  #passages = new Map();
  constructor(costs, config = {}) {
    this.costs = costs;
    this.graph = costs.graph;
    this.config = { ...DISAMBIGUATION_DEFAULTS, ...config };
    for (const [key, value] of Object.entries(this.config)) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Invalid ${key}`);
    }
    if (this.config.clearanceMeters >= this.config.avoidanceMeters) throw new RangeError('Clearance distance must be less than avoidance distance.');
    if (!Number.isInteger(this.config.minDeflections) || !Number.isInteger(this.config.minObservers)) throw new RangeError('Evidence minimums must be integers.');
    if (this.config.congestionSpeedMps > costs.walkingSpeedMps) throw new RangeError('Congestion speed exceeds baseline.');
    if (this.config.minTurnDegrees > 180 || this.config.slowdownRatio >= 1) throw new RangeError('Invalid turn or slowdown threshold.');
    this.segments = new Map(this.graph.segments.map((segment) => [segment.id, segment]));
  }

  #segment(edgeId) {
    const edge = this.graph.edges.get(edgeId);
    if (!edge) throw new Error(`Unknown graph edge: ${edgeId}`);
    const segment = this.segments.get(edge.segmentId);
    if (!segment) throw new Error('Edge is missing physical segment geometry.');
    return segment;
  }

  observeTrajectory(edgeId, observation, time = this.costs.now()) {
    timeCheck(time);
    idCheck(observation?.observerId);
    const deflections = extractDeflections(observation?.trace, {
      ...this.config, baselineSpeedMps: this.costs.walkingSpeedMps,
    });
    const passage = this.observePassage(edgeId, observation, time);
    // A shocked passage can still contribute movement features to crowd/obstacle analysis.
    const endTime = observation.trace?.at(-1)?.timestamp;
    const eligible = observation.mobilityMode === undefined || observation.mobilityMode === 'pedestrian';
    const accepted = [];
    if (eligible && Number.isFinite(endTime) && endTime <= time && time - endTime < this.config.maxTraceAgeSeconds) {
      for (const point of deflections) accepted.push(this.observeDeflection(edgeId, {
        ...point, id: `${observation.passageId}:${point.timestamp}`, observerId: observation.observerId,
      }, time));
    }
    return { passage, deflections: accepted, spatial: this.evaluateEdge(edgeId, time) };
  }

  observePassage(edgeId, { passageId, trace, shockDetected, mobilityMode = 'pedestrian' } = {}, time = this.costs.now()) {
    timeCheck(time);
    idCheck(passageId);
    const segment = this.#segment(edgeId);
    this.prune(time);
    const key = JSON.stringify([segment.id, passageId]);
    if (this.#passages.has(key)) return { status: 'duplicate', updates: [] };
    if (shockDetected !== false || mobilityMode !== 'pedestrian') return { status: 'ineligible', updates: [] };
    if (!Array.isArray(trace) || trace.length < 3) return { status: 'insufficient-trace', updates: [] };
    const passageTime = trace.at(-1).timestamp;
    if (!Number.isFinite(passageTime) || passageTime > time || time - passageTime >= this.config.maxTraceAgeSeconds) {
      return { status: 'stale-or-future-trace', updates: [] };
    }
    // Check the complete trace before any mutations, even when several pins share an edge.
    this.costs.prune(time);
    const analyses = this.costs.getEvents(edgeId).filter((event) => event.initial_penalty !== Infinity && event.event_type !== 'MANUAL_CLOSURE' &&
      trace[0].timestamp >= (event.last_evidence_timestamp ?? event.timestamp))
      .map((event) => ({ event, analysis: analyzePassage(trace, event.coordinate, this.config) }));
    this.#passages.set(key, time);
    const updates = analyses.map(({ event, analysis }) => {
      const updated = analysis.classification === 'inconclusive' ? null
        : this.costs.adjustEvent(event.id, analysis.classification, passageTime);
      return { eventId: event.id, ...analysis, updated: Boolean(updated) };
    });
    return { status: 'processed', updates };
  }

  observeDeflection(edgeId, { id, observerId, lat, lon, timestamp, accuracyMeters } = {}, time = this.costs.now()) {
    timeCheck(time); timeCheck(timestamp); idCheck(id); idCheck(observerId);
    const segment = this.#segment(edgeId);
    this.prune(time);
    if (timestamp > time || timestamp <= time - this.config.windowSeconds) return { accepted: false, reason: 'outside-window' };
    // Half-cell uncertainty protects the grid from being filled by GPS noise.
    if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > this.config.cellSizeMeters / 2) {
      return { accepted: false, reason: 'insufficient-position-accuracy' };
    }
    const project = localProjection(segment.geometry[0]);
    const point = project({ lat, lon });
    const geometry = segment.geometry.map(project);
    let distance = Infinity;
    for (let i = 1; i < geometry.length; i++) distance = Math.min(distance, pointSegmentDistance(point, geometry[i - 1], geometry[i]).distanceMeters);
    if (distance + accuracyMeters > this.config.corridorRadiusMeters) return { accepted: false, reason: 'outside-corridor' };
    let window = this.#windows.get(segment.id);
    if (!window) { window = new Map(); this.#windows.set(segment.id, window); }
    const key = JSON.stringify([observerId, id]);
    if (window.has(key)) return { accepted: false, reason: 'duplicate' };
    const cell = `${Math.floor(point.x / this.config.cellSizeMeters)},${Math.floor(point.y / this.config.cellSizeMeters)}`;
    window.set(key, { observerId, timestamp, cell, lat, lon });
    return { accepted: true, cell };
  }

  evaluateEdge(edgeId, time = this.costs.now()) {
    timeCheck(time);
    const segment = this.#segment(edgeId);
    this.prune(time);
    const observations = [...(this.#windows.get(segment.id)?.values() ?? [])].filter((point) => point.timestamp <= time);
    const cells = new Map();
    for (const point of observations) cells.set(point.cell, (cells.get(point.cell) ?? 0) + 1);
    const entropyBits = spatialEntropy(cells.values());
    const observers = new Set(observations.map((point) => point.observerId)).size;
    const result = { classification: 'insufficient-evidence', entropyBits, deflections: observations.length, observers, occupiedCells: cells.size, updatedEventIds: [] };
    if (observations.length < this.config.minDeflections || observers < this.config.minObservers) return result;
    this.costs.prune(time);
    const events = new Map();
    for (const id of segment.edgeIds) for (const event of this.costs.getEvents(id)) events.set(event.id, event);
    if (entropyBits >= this.config.entropyThresholdBits) {
      result.classification = 'congestion';
      const latest = Math.max(...observations.map((point) => point.timestamp));
      for (const event of events.values()) {
        if (event.initial_penalty === Infinity || event.event_type === 'MANUAL_CLOSURE' ||
            (event.last_evidence_timestamp ?? event.timestamp) > latest) continue;
        if (this.costs.removeEvent(event.id)) result.updatedEventIds.push(event.id);
      }
      // Expire with the newest supporting observation, not the time the evaluator is called.
      this.costs.setCongestion(segment.edgeIds, { walkingSpeedMps: this.config.congestionSpeedMps,
        timestamp: latest, durationSeconds: this.config.windowSeconds });
    } else {
      result.classification = 'localized-obstacle';
      this.costs.clearCongestion(segment.edgeIds);
      const dominant = [...cells].sort((a, b) => b[1] - a[1])[0][0];
      const cluster = observations.filter((point) => point.cell === dominant);
      const center = { lat: cluster.reduce((sum, point) => sum + point.lat, 0) / cluster.length,
        lon: cluster.reduce((sum, point) => sum + point.lon, 0) / cluster.length };
      result.coordinate = center;
      const project = localProjection(center);
      const evidenceTime = Math.max(...cluster.map((point) => point.timestamp));
      for (const event of events.values()) {
        if (event.initial_penalty === Infinity || event.event_type === 'MANUAL_CLOSURE') continue;
        const point = project({ lat: event.coordinate.lat, lon: event.coordinate.lng });
        if (Math.hypot(point.x, point.y) > this.config.avoidanceMeters || evidenceTime <= (event.last_evidence_timestamp ?? event.timestamp)) continue;
        if (this.costs.adjustEvent(event.id, 'avoidance', evidenceTime)) result.updatedEventIds.push(event.id);
      }
    }
    return result;
  }

  prune(time = this.costs.now()) {
    timeCheck(time);
    for (const [segmentId, window] of this.#windows) {
      for (const [key, point] of window) if (point.timestamp <= time - this.config.windowSeconds) window.delete(key);
      if (!window.size) this.#windows.delete(segmentId);
    }
    for (const [key, timestamp] of this.#passages) if (timestamp <= time - this.config.maxTraceAgeSeconds) this.#passages.delete(key);
  }
}
