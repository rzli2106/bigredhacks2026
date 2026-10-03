/** All timestamps are monotonic milliseconds; acceleration is m/s². */
export const DEFAULT_CONFIG = Object.freeze({
  samplePeriodMs: 20,
  rotationLimitRadS: 5.2,
  jerkThreshold: 85,
  maxFwhmMs: 45,
  maxGapMs: 60,
  baselineSamples: 10,
  pulseFloor: 0.5,
  maxPulseMs: 300,
  cooldownMs: 250,
});

const finiteVector = (v, axes) => v && axes.every((axis) => Number.isFinite(v[axis]));
const lerp = (a, b, fraction) => a + (b - a) * fraction;
const crossing = (a, b, level) =>
  lerp(a.timestamp, b.timestamp, (level - a.height) / (b.height - a.height));

/** Pure streaming processor. Output is evidence of an impact, not a hazard classification. */
export class SensorPipeline {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    for (const [key, value] of Object.entries(this.config)) {
      if (!(Number.isFinite(value) && value > 0)) throw new RangeError(`Invalid ${key}`);
    }
    if (!Number.isInteger(this.config.baselineSamples) || this.config.baselineSamples < 2) {
      throw new RangeError('baselineSamples must be an integer >= 2');
    }
    this.reset();
  }

  reset() {
    this.raw = null;
    this.nextTimestamp = null;
    this.lastTimestamp = null;
    this.previous = null;
    this.baseline = [];
    this.pulse = null;
    this.cooldownUntil = -Infinity;
  }

  /** Input rotationRate uses browser units: degrees/second. */
  push({ timestamp, accelerationIncludingGravity: acceleration, rotationRate } = {}) {
    const result = { samples: [], candidates: [], droppedReason: null };
    const drop = (reason) => {
      this.reset();
      // Retain the ordering watermark even when continuity is broken.
      this.lastTimestamp = Number.isFinite(timestamp) ? timestamp : null;
      result.droppedReason = reason;
      return result;
    };
    if (!Number.isFinite(timestamp)) return drop('invalid-timestamp');
    if (this.lastTimestamp !== null && timestamp <= this.lastTimestamp) {
      result.droppedReason = 'non-monotonic-timestamp';
      return result;
    }
    this.lastTimestamp = timestamp;
    if (!finiteVector(acceleration, ['x', 'y', 'z']) ||
        !finiteVector(rotationRate, ['alpha', 'beta', 'gamma'])) {
      return drop('missing-sensor-data');
    }
    const angularSpeed = Math.hypot(rotationRate.alpha, rotationRate.beta, rotationRate.gamma) * Math.PI / 180;
    // Gate raw events before downsampling so brief rotations cannot disappear.
    if (angularSpeed > this.config.rotationLimitRadS) return drop('tumble');
    const current = { timestamp, magnitude: Math.hypot(acceleration.x, acceleration.y, acceleration.z) };
    if (!Number.isFinite(current.magnitude)) return drop('invalid-acceleration');
    if (this.raw && timestamp - this.raw.timestamp > this.config.maxGapMs) {
      drop('sensor-gap');
    }
    if (!this.raw) {
      this.raw = current;
      this.nextTimestamp = timestamp + this.config.samplePeriodMs;
      this.consume(current, result);
      return result;
    }
    while (this.nextTimestamp <= timestamp) {
      const fraction = (this.nextTimestamp - this.raw.timestamp) / (timestamp - this.raw.timestamp);
      this.consume({
        timestamp: this.nextTimestamp,
        magnitude: lerp(this.raw.magnitude, current.magnitude, fraction),
      }, result);
      this.nextTimestamp += this.config.samplePeriodMs;
    }
    this.raw = current;
    return result;
  }

  consume(sample, result) {
    const c = this.config;
    const jerk = this.previous ? Math.abs(sample.magnitude - this.previous.magnitude) / (c.samplePeriodMs / 1000) : 0;
    result.samples.push({ ...sample, jerk });
    if (this.baseline.length < c.baselineSamples) {
      this.baseline.push(sample.magnitude);
      this.previous = sample;
      return;
    }
    const baseline = this.baseline.reduce((sum, value) => sum + value, 0) / this.baseline.length;
    if (!this.pulse && sample.magnitude - baseline > c.pulseFloor && sample.timestamp >= this.cooldownUntil) {
      this.pulse = {
        baseline,
        points: [{ ...this.previous, height: this.previous.magnitude - baseline, jerk: 0 }],
      };
    }
    if (this.pulse) {
      const point = { ...sample, height: sample.magnitude - this.pulse.baseline, jerk };
      this.pulse.points.push(point);
      if (point.height <= c.pulseFloor) {
        const candidate = this.finishPulse();
        if (candidate) result.candidates.push(candidate);
        this.pulse = null;
        this.cooldownUntil = sample.timestamp + c.cooldownMs;
      } else if (sample.timestamp - this.pulse.points[0].timestamp >= c.maxPulseMs) {
        // Recalibrate after a sustained acceleration change; never classify an unclosed pulse.
        this.pulse = null;
        this.baseline = [];
        this.cooldownUntil = sample.timestamp + c.cooldownMs;
      }
    } else {
      this.baseline.shift();
      this.baseline.push(sample.magnitude);
    }
    this.previous = sample;
  }

  finishPulse() {
    const { points, baseline } = this.pulse;
    let peakIndex = 0;
    for (let i = 1; i < points.length; i++) if (points[i].height > points[peakIndex].height) peakIndex = i;
    const half = points[peakIndex].height / 2;
    let left = peakIndex;
    let right = peakIndex;
    while (left > 0 && points[left - 1].height > half) left--;
    while (right < points.length - 1 && points[right + 1].height > half) right++;
    if (left === 0 || right === points.length - 1) return null;
    const start = crossing(points[left - 1], points[left], half);
    const end = crossing(points[right], points[right + 1], half);
    const fwhmMs = end - start;
    const peakJerk = Math.max(...points.map((point) => point.jerk));
    // Preserve strict cutoffs when arithmetic introduces machine-scale roundoff.
    const jerkMargin = this.config.jerkThreshold * 1e-12;
    const widthMargin = this.config.maxFwhmMs * 1e-12;
    if (!(peakJerk - this.config.jerkThreshold > jerkMargin &&
          this.config.maxFwhmMs - fwhmMs > widthMargin)) return null;
    return {
      type: 'impact-candidate',
      timestamp: points[peakIndex].timestamp,
      peakAcceleration: points[peakIndex].magnitude,
      baselineAcceleration: baseline,
      peakJerk,
      fwhmMs,
      samplePeriodMs: this.config.samplePeriodMs,
    };
  }
}
