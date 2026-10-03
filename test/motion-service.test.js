import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionService } from '../src/motion-service.js';

function browser(requestPermission) {
  const target = new EventTarget();
  target.document = new EventTarget();
  target.document.hidden = false;
  target.isSecureContext = true;
  target.DeviceMotionEvent = requestPermission ? { requestPermission } : {};
  return target;
}

test('permission granted attaches once and stop removes the listener', async () => {
  const target = browser(async () => 'granted');
  const service = new MotionService({ window: target });
  let calls = 0;
  service.pipeline.push = () => { calls++; return { candidates: [] }; };
  await service.start();
  await service.start();
  target.dispatchEvent(new Event('devicemotion'));
  assert.equal(calls, 1);
  service.stop();
  target.dispatchEvent(new Event('devicemotion'));
  assert.equal(calls, 1);
});

test('denial, unsupported APIs, and insecure contexts reject startup', async () => {
  await assert.rejects(new MotionService({ window: browser(async () => 'denied') }).start(), /denied/);
  const target = browser();
  target.DeviceMotionEvent = undefined;
  await assert.rejects(new MotionService({ window: target }).start(), /unavailable/);
  target.isSecureContext = false;
  await assert.rejects(new MotionService({ window: target }).start(), /HTTPS/);
});

test('stop during a permission prompt prevents late startup', async () => {
  let resolve;
  const target = browser(() => new Promise((done) => { resolve = done; }));
  const service = new MotionService({ window: target });
  const starting = service.start();
  service.stop();
  resolve('granted');
  await starting;
  assert.equal(service.running, false);
});

test('hidden pages ignore events and visibility changes reset continuity', async () => {
  const target = browser();
  const service = new MotionService({ window: target });
  await service.start();
  let calls = 0;
  let resets = 0;
  service.pipeline.push = () => { calls++; return { candidates: [] }; };
  service.pipeline.reset = () => { resets++; };
  target.document.hidden = true;
  target.document.dispatchEvent(new Event('visibilitychange'));
  target.dispatchEvent(new Event('devicemotion'));
  assert.equal(calls, 0);
  assert.equal(resets, 1);
  service.stop();
});

test('only accepted candidates reach the application callback', async () => {
  const target = browser();
  const candidates = [];
  const service = new MotionService({ window: target, onCandidate: (value) => candidates.push(value) });
  await service.start();
  const heights = [...Array(12).fill(0), 0, 2, 8, 2, 0];
  heights.forEach((height, i) => {
    const event = new Event('devicemotion');
    Object.defineProperties(event, {
      timeStamp: { value: i * 20 },
      accelerationIncludingGravity: { value: { x: 0, y: 0, z: 9.81 + height } },
      rotationRate: { value: { alpha: 0, beta: 0, gamma: 0 } },
    });
    target.dispatchEvent(event);
  });
  assert.equal(candidates.length, 1);
  service.stop();
});

test('raw callback preserves all axes and converts motion timestamps to Unix milliseconds', async () => {
  const target = browser(async () => 'granted'), raw = [];
  target.performance = { timeOrigin: 1800000000000 };
  const service = new MotionService({ window: target, onRawSample: sample => raw.push(sample) });
  await service.start();
  const event = new Event('devicemotion');
  Object.defineProperties(event, {
    timeStamp: { value: 20 },
    accelerationIncludingGravity: { value: { x: 1, y: 2, z: 3 } },
    rotationRate: { value: { alpha: 4, beta: 5, gamma: 6 } },
  });
  target.dispatchEvent(event);
  assert.deepEqual(raw, [{ timestamp: 1800000000020, accelerationIncludingGravity: { x: 1, y: 2, z: 3 }, rotationRate: { alpha: 4, beta: 5, gamma: 6 } }]);
  service.stop(); target.dispatchEvent(event); assert.equal(raw.length, 1);
});
