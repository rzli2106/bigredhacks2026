import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileNavigation } from '../frontend/mobile-navigation.js';
function fixture(t) {
  const elements = new Map(['route-status', 'route-options', 'route-update-warning', 'route-update-status', 'retry-route', 'accept-reroute'].map(id => [`#${id}`, { hidden: false, disabled: false, textContent: '', children: ['old choice'], replaceChildren() { this.children = []; } }]));
  const oldDocument = globalThis.document, oldFetch = globalThis.fetch;
  globalThis.document = { querySelector: id => elements.get(id) };
  t.after(() => { globalThis.document = oldDocument; globalThis.fetch = oldFetch; });
  const nav = Object.create(MobileNavigation.prototype), active = { distanceMeters: 340, durationSeconds: 262 };
  Object.assign(nav, { api: 'https://synthetic.test', requestId: 0, from: {}, to: {}, active, options: { alternative: {} }, renderAlert() {}, renderRoutes() {}, setPlannerOpen() {} });
  return { nav, elements, active };
}
test('failed background route update preserves the selected route and exposes recovery outside the planner', async t => {
  const { nav, elements, active } = fixture(t);
  globalThis.fetch = async () => { throw new Error('offline'); };
  await nav.refresh();
  assert.equal(nav.active, active); assert.equal(nav.options, null);
  assert.equal(elements.get('#route-update-warning').hidden, false);
  assert.match(elements.get('#route-update-status').textContent, /unavailable.*previous route/);
  assert.deepEqual(elements.get('#route-options').children, []);
  assert.equal(elements.get('#retry-route').disabled, false);
});
test('retry disables recovery during the request and clears warning only after success', async t => {
  const { nav, elements, active } = fixture(t);
  nav.routeUpdateFailed('Route update timed out.');
  let finish; globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = nav.refresh();
  assert.equal(elements.get('#retry-route').disabled, true);
  assert.equal(elements.get('#route-update-warning').hidden, false);
  finish({ ok: true, json: async () => ({ direct: { status: 'ok' }, alternative: null }) });
  await pending;
  assert.equal(nav.active, active); assert.equal(nav.routeUpdateError, '');
  assert.equal(elements.get('#route-update-warning').hidden, true);
});
test('off-path refresh warns about stale route instead of leaving old choices available', async t => {
  const { nav, elements, active } = fixture(t);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ direct: { status: 'off-path', endpoint: 'start' } }) });
  await nav.refresh();
  assert.equal(nav.active, active); assert.equal(nav.options, null);
  assert.match(elements.get('#route-update-status').textContent, /start.*40 m/);
  assert.equal(elements.get('#route-update-warning').hidden, false);
});
test('late failed refresh cannot replace a successful current result with a warning', async t => {
  const { nav, elements } = fixture(t);
  let fail; globalThis.fetch = () => new Promise((_, reject) => { fail = reject; });
  const old = nav.refresh();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ direct: { status: 'ok' }, alternative: null }) });
  await nav.refresh(); fail(new Error('old connection failed')); await old;
  assert.equal(nav.routeUpdateError, ''); assert.equal(elements.get('#route-update-warning').hidden, true);
  assert.notEqual(nav.options, null);
});

test('another snapshot during an unavailable update cannot erase the selected map line', async t => {
  const { nav } = fixture(t);
  nav.options = null; let cleared = false, activeRendered = false;
  nav.routes = { clearLayers() { cleared = true; } };
  nav.renderActive = () => { activeRendered = true; };
  MobileNavigation.prototype.renderRoutes.call(nav);
  assert.equal(cleared, false); assert.equal(activeRendered, true);
});
