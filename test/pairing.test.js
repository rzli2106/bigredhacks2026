import test from 'node:test';
import assert from 'node:assert/strict';
import { readPairingLink } from '../frontend/pairing.js';

const link = api => `https://www.clearpath.wiki/mobile#${new URLSearchParams({ api, token: 'synthetic-token', device_id: 'synthetic-device' })}`;
test('pairing accepts production HTTPS and HTTP loopback development endpoints', () => {
  for (const api of ['https://www.clearpath.wiki', 'http://localhost:8002', 'http://127.0.0.1:8002', 'http://[::1]:8002']) {
    assert.deepEqual(readPairingLink(link(api)), { api, token: 'synthetic-token', deviceId: 'synthetic-device' });
  }
});
test('pairing rejects unsupported protocols even when their hostname is localhost', () => {
  for (const api of ['ftp://localhost', 'ws://localhost', 'file:///tmp/test', 'javascript:alert(1)', 'http://example.test']) {
    assert.throws(() => readPairingLink(link(api)), /HTTPS/);
  }
});
test('malformed and incomplete pairing links produce actionable errors', () => {
  assert.throws(() => readPairingLink(''), /complete pairing link/);
  assert.throws(() => readPairingLink('https://www.clearpath.wiki/mobile'), /complete link/);
  assert.throws(() => readPairingLink(link('not a URL')), /invalid server address/);
});
