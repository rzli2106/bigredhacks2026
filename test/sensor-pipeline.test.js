import test from 'node:test';
import assert from 'node:assert/strict';
import { SensorPipeline } from '../src/sensor-pipeline.js';

const event = (timestamp, height = 0, rotation = 0) => ({
  timestamp,
  accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 + height },
  rotationRate: { alpha: rotation, beta: 0, gamma: 0 },
});
function trace(heights, config) {
  const pipeline = new SensorPipeline(config);
  const candidates = [];
  const values = [...Array(12).fill(0), ...heights, ...Array(20).fill(0)];
  values.forEach((height, i) => candidates.push(...pipeline.push(event(i * 20, height)).candidates));
  return candidates;
}

test('narrow impact produces one candidate with a baseline-relative FWHM', () => {
  const candidates = trace([0, 2, 8, 2, 0]);
  assert.equal(candidates.length, 1);
  assert.ok(Math.abs(candidates[0].fwhmMs - 26.6666666667) < 1e-6);
  assert.ok(Math.abs(candidates[0].peakJerk - 300) < 1e-6);
});

test('broad padded impact is rejected despite high jerk', () => {
  assert.equal(trace([0, 8, 8, 8, 8, 8, 8, 0]).length, 0);
});

test('low jerk and ordinary periodic gait do not trigger', () => {
  assert.equal(trace([0, 1, 0]).length, 0);
  assert.equal(trace(Array.from({ length: 200 }, (_, i) => Math.sin(i / 4))).length, 0);
});

test('strict width and jerk thresholds reject equality', () => {
  assert.equal(trace([0, 8, 0], { maxFwhmMs: 20 }).length, 0);
  assert.equal(trace([0, 8, 0], { jerkThreshold: 400 }).length, 0);
});

test('irregular timestamps are interpolated onto a 20 ms grid', () => {
  const pipeline = new SensorPipeline();
  const samples = [0, 13, 37, 55, 81].flatMap((t) => pipeline.push(event(t, t / 100)).samples);
  assert.deepEqual(samples.map((s) => s.timestamp), [0, 20, 40, 60, 80]);
  samples.forEach((s) => assert.ok(Math.abs(s.magnitude - (9.81 + s.timestamp / 100)) < 1e-10));
});

test('orientation changes with constant magnitude produce zero jerk', () => {
  const pipeline = new SensorPipeline();
  pipeline.push(event(0));
  const sample = event(20);
  sample.accelerationIncludingGravity = { x: 9.81, y: 0, z: 0 };
  assert.equal(pipeline.push(sample).samples[0].jerk, 0);
});

test('tumble gate converts degrees to radians and detects sub-grid events', () => {
  const pipeline = new SensorPipeline();
  for (let t = 0; t <= 240; t += 20) pipeline.push(event(t));
  pipeline.push(event(260, 8));
  assert.equal(pipeline.push(event(265, 8, 301)).droppedReason, 'tumble');
  const result = pipeline.push(event(280));
  assert.equal(result.samples[0].jerk, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(pipeline.push(event(300, 0, 290)).droppedReason, null);
});

test('missing gyroscope and acceleration values fail closed', () => {
  for (const field of ['rotationRate', 'accelerationIncludingGravity']) {
    const pipeline = new SensorPipeline();
    const sample = event(0);
    sample[field] = null;
    assert.equal(pipeline.push(sample).droppedReason, 'missing-sensor-data');
  }
  const sample = event(0);
  sample.rotationRate.alpha = null;
  assert.equal(new SensorPipeline().push(sample).droppedReason, 'missing-sensor-data');
});

test('gaps reset continuity and duplicate or out-of-order samples are ignored', () => {
  const pipeline = new SensorPipeline();
  pipeline.push(event(100));
  assert.equal(pipeline.push(event(100)).droppedReason, 'non-monotonic-timestamp');
  assert.equal(pipeline.push(event(90)).droppedReason, 'non-monotonic-timestamp');
  const result = pipeline.push(event(1000, 8));
  assert.equal(result.droppedReason, 'sensor-gap');
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].jerk, 0);
});

test('sustained acceleration does not emit an unclosed pulse', () => {
  assert.equal(trace(Array(40).fill(8)).length, 0);
});

test('invalid configuration is rejected', () => {
  assert.throws(() => new SensorPipeline({ samplePeriodMs: 0 }), RangeError);
  assert.throws(() => new SensorPipeline({ baselineSamples: 1.5 }), RangeError);
});
