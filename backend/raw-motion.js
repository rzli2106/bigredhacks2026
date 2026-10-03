import { SensorPipeline } from '../src/sensor-pipeline.js';
import { ApiError } from './engine.js';
import { validateCoordinate } from '../src/routing/geo.js';

/** Raw data is transient; only server-derived hazards enter the public stream. */
export class RawMotionReceiver {
  constructor(engine) { this.engine = engine; this.devices = new Map(); }
  prune() {
    for (const [id, state] of this.devices) {
      if (this.engine.now() - state.lastSeen > 45) this.devices.delete(id);
    }
  }
  ingest({ device_id, samples, location } = {}) {
    if (typeof device_id !== 'string' || !/^[\w:-]{1,80}$/.test(device_id)) throw new ApiError(400, 'Invalid device_id.');
    if (!Array.isArray(samples) || samples.length < 1 || samples.length > 32) throw new ApiError(400, 'Send 1–32 raw motion samples per batch.');
    const now = this.engine.now();
    // Validate the whole batch before changing filter state.
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (!sample || !Number.isFinite(sample.timestamp) || sample.timestamp / 1000 > now + 5 || now - sample.timestamp / 1000 > 5 ||
          (i && sample.timestamp <= samples[i - 1].timestamp)) throw new ApiError(422, 'Raw samples need fresh, increasing Unix millisecond timestamps.');
      for (const [vector, axes] of [[sample.accelerationIncludingGravity, ['x','y','z']], [sample.rotationRate, ['alpha','beta','gamma']]]) {
        // Null axes reset continuity inside SensorPipeline; never infer zero gyro.
        if (vector !== null && (!vector || !axes.every(axis => vector[axis] === null || (Number.isFinite(vector[axis]) && Math.abs(vector[axis]) <= 10000)))) {
          throw new ApiError(400, 'Invalid raw sensor axes.');
        }
      }
    }
    if (location !== null) {
      try { validateCoordinate({ lat: location?.lat, lon: location?.lng }); } catch { throw new ApiError(400, 'Invalid location.'); }
      if (!Number.isFinite(location.timestamp) || !Number.isFinite(location.accuracy_meters) || location.accuracy_meters < 0 ||
          location.timestamp > samples[0].timestamp / 1000 + 5 || now - location.timestamp > 10 || location.accuracy_meters > 20) {
        throw new ApiError(422, 'Raw telemetry needs a fresh location with accuracy at most 20 m, or null while GPS is unavailable.');
      }
    }
    this.prune();
    let state = this.devices.get(device_id);
    if (!state) {
      if (this.devices.size >= 500) throw new ApiError(429, 'Active sensor capacity reached.');
      state = { pipeline: new SensorPipeline({ rotationLimitRadS: 300 * Math.PI / 180 }), lastSeen: now };
      this.devices.set(device_id, state);
    }
    state.lastSeen = now;
    const events = [], rejected = [];
    for (const sample of samples) {
      const result = state.pipeline.push(sample);
      if (result.droppedReason) rejected.push(result.droppedReason);
      for (const candidate of result.candidates) {
        if (!location) { rejected.push('location-unavailable'); continue; }
        const event = this.engine.ingest({
          device_id, event_id: `raw:${candidate.timestamp}`, source: 'web_motion', metric_type: 'SENSOR_SHOCK', severity: 1,
          lat: location.lat, lng: location.lng, accuracy_meters: location.accuracy_meters, timestamp: candidate.timestamp / 1000,
          evidence: { gyro_deg_s: candidate.peakAngularSpeed * 180 / Math.PI, peak_jerk: candidate.peakJerk,
            peak_acceleration: candidate.peakAcceleration, fwhm_ms: candidate.fwhmMs },
        });
        if (event.accepted && !event.duplicate) events.push(event);
        else if (event.reason) rejected.push(event.reason);
      }
    }
    return { accepted: true, samples_received: samples.length, events, rejected };
  }
}
