import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribe } from '../frontend/connection.js';

function fixture(t) {
  const sockets = [], timers = [], original = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.closeCount = 0; sockets.push(this); }
    close() { this.closeCount++; this.onclose?.(); }
  };
  t.after(() => { if (original === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = original; });
  t.mock.method(globalThis, 'setTimeout', callback => { timers.push(callback); return timers.length; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const snapshots = [], statuses = [];
  const unsubscribe = subscribe(data => snapshots.push(data), status => statuses.push(status), { ws: 'wss://example.test/ws/stream' });
  t.after(unsubscribe);
  return { sockets, timers, snapshots, statuses, unsubscribe };
}

test('a stopped stream ignores queued open, message, error and close callbacks', t => {
  const { sockets, snapshots, statuses, timers, unsubscribe } = fixture(t), socket = sockets[0];
  socket.onopen(); socket.onmessage({ data: JSON.stringify({ type: 'snapshot', revision: 1 }) });
  assert.deepEqual(statuses, ['Connecting', 'Live']); assert.equal(snapshots.length, 1);
  unsubscribe();
  socket.onopen(); socket.onmessage({ data: JSON.stringify({ type: 'snapshot', revision: 2 }) });
  socket.onerror(); socket.onclose();
  assert.equal(snapshots.length, 1); assert.deepEqual(statuses, ['Connecting', 'Live']);
  assert.equal(timers.length, 0); assert.equal(socket.closeCount, 1);
});

test('a late callback from the previous socket cannot corrupt or close the replacement stream', t => {
  const { sockets, snapshots, statuses, timers } = fixture(t), old = sockets[0];
  old.onclose(); assert.equal(timers.length, 1); timers[0]();
  const replacement = sockets[1]; replacement.onopen();
  const before = statuses.length;
  old.onmessage({ data: JSON.stringify({ type: 'snapshot', instance_id: 'old' }) });
  old.onerror(); old.onopen(); old.onclose();
  assert.equal(replacement.closeCount, 0); assert.equal(statuses.length, before); assert.equal(timers.length, 1);
  replacement.onmessage({ data: JSON.stringify({ type: 'snapshot', instance_id: 'new' }) });
  assert.deepEqual(snapshots.map(s => s.instance_id), ['new']);
});
