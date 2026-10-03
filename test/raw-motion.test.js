import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { buildWalkingGraph } from '../src/routing/index.js';
import { ScenarioRunner } from '../backend/simulator.js';
import { RawMotionReceiver } from '../backend/raw-motion.js';
import { createTelemetryServer } from '../backend/server.js';
import { RawMotionTransport } from '../frontend/connection.js';

const graph = buildWalkingGraph(JSON.parse(await readFile(new URL('../public/cornell-osm.json', import.meta.url), 'utf8')));
const samples = (now, heights = [0,2,8,2,0], gyro = 0) => [...Array(12).fill(0), ...heights].map((height, i) => ({
  timestamp: now * 1000 - 400 + i * 20,
  accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 + height },
  rotationRate: { alpha: gyro, beta: 0, gamma: 0 },
}));
function fixture() {
  const runner = new ScenarioRunner(graph, { baseTime: 1800000000 });
  const receiver = new RawMotionReceiver(runner.engine);
  const location = { lat: runner.corridor.center.lat, lng: runner.corridor.center.lon, accuracy_meters: 3, timestamp: runner.baseTime - 1 };
  return { runner, receiver, batch: { device_id: 'raw-phone', location, samples: samples(runner.baseTime) } };
}

test('raw samples retain continuity across batches and derive one impact and edge penalties', () => {
  const { runner, receiver, batch } = fixture();
  try {
    for (let i = 0; i < batch.samples.length; i += 3) {
      receiver.ingest({ ...batch, samples: batch.samples.slice(i, i + 3) });
    }
    const snapshot = runner.engine.snapshot();
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].source, 'web_motion');
    assert.ok(snapshot.edges.every(edge => edge.cost > edge.base_distance));
    // Replayed batches cannot invent additional hazards.
    assert.equal(receiver.ingest(batch).events.length, 0);
    assert.equal(runner.engine.events().length, 1);
  } finally { runner.dispose(); }
});

test('server rejects tumbling, broad impulses, missing gyro, and GPS-free impacts', () => {
  for (const modify of [
    b => ({ ...b, samples: samples(1800000000, [0,2,8,2,0], 301) }),
    b => ({ ...b, samples: samples(1800000000, [0,8,8,8,8,8,0]) }),
    b => ({ ...b, samples: b.samples.map(sample => ({ ...sample, rotationRate: null })) }),
    b => ({ ...b, location: null }),
  ]) {
    const { runner, receiver, batch } = fixture();
    try { assert.equal(receiver.ingest(modify(batch)).events.length, 0); assert.equal(runner.engine.events().length, 0); }
    finally { runner.dispose(); }
  }
});

test('invalid batches fail before changing filter state; inactive devices are pruned', () => {
  const { runner, receiver, batch } = fixture();
  try {
    for (const bad of [
      { ...batch, samples: [] },
      { ...batch, samples: [...batch.samples, ...batch.samples] },
      { ...batch, samples: [{ ...batch.samples[0], timestamp: 1 }] },
      { ...batch, location: { ...batch.location, timestamp: runner.baseTime - 11 } },
      { ...batch, location: { ...batch.location, accuracy_meters: 21 } },
    ]) assert.throws(() => receiver.ingest(bad));
    assert.equal(receiver.devices.size, 0);
    assert.equal(receiver.ingest(batch).events.length, 1);
    runner.offset = 46; receiver.prune(); assert.equal(receiver.devices.size, 0);
  } finally { runner.dispose(); }
});

const nextMessage = socket => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Observer broadcast timed out')), 3000);
  socket.once('message', data => { clearTimeout(timer); resolve(JSON.parse(data)); });
});
test('paired HTTPS raw route uses separate streaming limits and immediately broadcasts hazards', async t => {
  const { runner, batch } = fixture();
  const service = await createTelemetryServer({ graph, now: () => runner.baseTime, production: true,
    adminToken: 'a'.repeat(40), allowedOrigins: ['https://phone.example'], publicApiUrl: 'https://api.example', broadcastMs: 60000 });
  const address = await service.listen(0), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await service.close(); runner.dispose(); });
  const post = (path, body, token) => fetch(`${base}${path}`, { method: 'POST', headers: {
    Origin: 'https://phone.example', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
  }, body: JSON.stringify(body) });
  const pairing = await (await post('/api/pairing', { mobile_url: 'https://phone.example/mobile' }, service.adminToken)).json();
  const fragment = new URLSearchParams(new URL(pairing.url).hash.slice(1));
  batch.device_id = fragment.get('device_id'); const token = fragment.get('token');
  assert.equal((await post('/api/telemetry/raw', batch, 'wrong')).status, 401);
  assert.equal((await post('/api/telemetry/raw', { ...batch, device_id: 'wrong' }, token)).status, 403);
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws/stream`, { origin: 'https://phone.example' });
  await nextMessage(socket);
  const update = nextMessage(socket);
  const response = await post('/api/telemetry/raw', batch, token);
  assert.equal(response.status, 200); assert.equal((await response.json()).events.length, 1);
  const snapshot = await update;
  assert.equal(snapshot.events.length, 1); assert.equal(snapshot.connected_devices, 1);
  assert.ok(snapshot.edges.some(edge => edge.cost > edge.base_distance));
  assert.equal(JSON.stringify(snapshot).includes('accelerationIncludingGravity'), false);
  assert.equal(JSON.stringify(snapshot).includes(batch.device_id), false);
  for (let i = 0; i < 125; i++) assert.equal((await post('/api/telemetry/raw', batch, token)).status, 200);
  socket.close();
});

test('raw transport batches every sample, permits one in-flight request, and aborts on stop', async () => {
  const original = globalThis.fetch, calls = []; let resolve;
  globalThis.fetch = (_url, options) => { calls.push(options); return new Promise(done => { resolve = done; }); };
  const transport = new RawMotionTransport({ api: 'https://api.example', token: 'test', deviceId: 'phone', getLocation: () => null });
  try {
    transport.enabled = true;
    const sample = { timestamp: Date.now(), accelerationIncludingGravity: { x: 1, y: 2, z: 3 }, rotationRate: { alpha: 4, beta: 5, gamma: 6 } };
    transport.enqueue(sample); transport.enqueue(sample);
    const sending = transport.flush(); transport.enqueue(sample); await transport.flush();
    assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].body).samples.length, 2);
    assert.equal(transport.samples.length, 1);
    transport.stop(); assert.equal(calls[0].signal.aborted, true); assert.equal(transport.samples.length, 0);
    resolve({ ok: true, json: async () => ({ events: [] }) }); await sending;
  } finally { transport.stop(); globalThis.fetch = original; }
});
