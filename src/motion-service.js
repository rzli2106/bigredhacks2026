import { SensorPipeline } from './sensor-pipeline.js';

/** Call start() directly from a user gesture. No network requests are made. */
export class MotionService {
  constructor({ config, onCandidate = () => {}, onStatus = () => {}, onSamples = () => {}, window: target = globalThis.window } = {}) {
    this.target = target;
    this.pipeline = new SensorPipeline(config);
    this.onCandidate = onCandidate;
    this.onStatus = onStatus;
    this.onSamples = onSamples;
    this.running = false;
    this.starting = false;
    this.generation = 0;
    this.handleMotion = (event) => {
      if (this.target.document?.hidden) return;
      const result = this.pipeline.push({
        timestamp: event.timeStamp,
        accelerationIncludingGravity: event.accelerationIncludingGravity,
        rotationRate: event.rotationRate,
      });
      if (result.droppedReason) this.onStatus({ state: 'sample-dropped', reason: result.droppedReason });
      if (result.samples?.length) this.onSamples(result.samples);
      for (const candidate of result.candidates) this.onCandidate(candidate);
    };
    this.handleVisibility = () => this.pipeline.reset();
  }

  async start() {
    if (this.running || this.starting) return;
    const target = this.target;
    if (!target?.isSecureContext) throw new Error('Motion sensing requires HTTPS or localhost.');
    if (!target.DeviceMotionEvent) throw new Error('DeviceMotionEvent is unavailable.');
    const generation = ++this.generation;
    this.starting = true;
    try {
      if (typeof target.DeviceMotionEvent.requestPermission === 'function') {
        const permission = await target.DeviceMotionEvent.requestPermission();
        if (generation !== this.generation) return;
        if (permission !== 'granted') throw new Error('Motion sensor permission was denied.');
      }
      if (generation !== this.generation) return;
      this.pipeline.reset();
      target.addEventListener('devicemotion', this.handleMotion);
      target.document?.addEventListener('visibilitychange', this.handleVisibility);
      this.running = true;
      this.onStatus({ state: 'listening' });
    } finally {
      if (generation === this.generation) this.starting = false;
    }
  }

  stop() {
    this.generation++;
    this.starting = false;
    this.target?.removeEventListener('devicemotion', this.handleMotion);
    this.target?.document?.removeEventListener('visibilitychange', this.handleVisibility);
    this.running = false;
    this.pipeline.reset();
    this.onStatus({ state: 'stopped' });
  }
}
