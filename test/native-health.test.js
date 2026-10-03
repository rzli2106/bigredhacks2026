import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeHealthService } from '../frontend/native-health.js';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(t, overrides = {}) {
  const calls = [], samples = [], statuses = [];
  const bridge = { availability: async () => ({ available: true }), requestPermissions: async () => {},
    startMonitoring: async () => { calls.push('start'); }, stopMonitoring: async () => { calls.push('stop'); }, readSamples: async () => ({ samples: [] }), ...overrides };
  const service = new NativeHealthService({ bridge, intervalMs: 1e6, onSamples: batch => samples.push(batch), onStatus: status => statuses.push(status) });
  t.after(() => service.stop()); return { service, bridge, calls, samples, statuses };
}
test('stop during native startup shuts down before a new sharing session starts', async t => {
  const entered = deferred(), finish = deferred(); let starts = 0;
  const f = fixture(t, { startMonitoring: async () => { f.calls.push('start'); if (++starts === 1) { entered.resolve(); await finish.promise; } } });
  const old = f.service.start(); await entered.promise;
  const stopping = f.service.stop(), next = f.service.start(); finish.resolve();
  await old; await stopping; await next; await f.service.pending;
  assert.deepEqual(f.calls, ['start', 'stop', 'start']); assert.equal(f.service.running, true);
  assert.equal(f.statuses.filter(status => status.state === 'waiting').length, 1);
});
test('repeated polls share one provider read, including while its result is pending', async t => {
  const entered = deferred(), finish = deferred(); let reads = 0;
  const f = fixture(t, { readSamples: async () => { reads++; entered.resolve(); return finish.promise; } });
  await f.service.start(); await entered.promise;
  const first = f.service.read(), second = f.service.read(); assert.equal(first, second);
  finish.resolve({ samples: [{ id: 'new' }] }); await first;
  assert.equal(reads, 1); assert.deepEqual(f.samples, [[{ id: 'new' }]]);
});
test('a stopped read cannot deliver old samples or update the next session', async t => {
  const entered = deferred(), finish = deferred(); let reads = 0;
  const f = fixture(t, { readSamples: async () => { f.calls.push('read'); if (++reads === 1) { entered.resolve(); return finish.promise; } return { samples: [{ id: 'current' }] }; } });
  await f.service.start(); await entered.promise;
  const stopping = f.service.stop(), next = f.service.start(); finish.resolve({ samples: [{ id: 'old' }] });
  await stopping; await next; await f.service.pending;
  assert.deepEqual(f.calls, ['start', 'read', 'stop', 'start', 'read']);
  assert.deepEqual(f.samples, [[{ id: 'current' }]]);
});
test('provider read failure releases the poll gate and permits a successful retry', async t => {
  let reads = 0; const f = fixture(t, { readSamples: async () => { if (++reads === 1) throw new Error('Provider offline'); return { samples: [] }; } });
  await f.service.start(); await f.service.pending;
  assert.equal(f.statuses.at(-1).state, 'error'); assert.equal(f.service.reading, false);
  await f.service.read(); assert.equal(reads, 2); assert.deepEqual(f.samples, [[]]);
});
test('cancelled permission request cannot start monitoring after shutdown', async t => {
  const entered = deferred(), finish = deferred(); const f = fixture(t, { requestPermissions: async () => { entered.resolve(); await finish.promise; } });
  const starting = f.service.start(); await entered.promise; const stopping = f.service.stop(); finish.resolve();
  await starting; await stopping; assert.deepEqual(f.calls, ['stop']); assert.equal(f.service.running, false);
});
test('permission failure permits a later startup and unavailable providers do not request access', async t => {
  let available = false, permissions = 0;
  const f = fixture(t, { availability: async () => ({ available, reason: 'Provider missing' }), requestPermissions: async () => { if (++permissions === 1) throw new Error('Permission denied'); } });
  await f.service.start(); assert.equal(permissions, 0); assert.equal(f.statuses.at(-1).reason, 'Provider missing');
  available = true; await assert.rejects(f.service.start(), /Permission denied/);
  assert.equal(f.service.starting, false); assert.equal(f.service.running, false);
  assert.deepEqual(f.calls, ['stop']);
  await f.service.start(); await f.service.pending; assert.equal(f.service.running, true); assert.equal(permissions, 2);
});
