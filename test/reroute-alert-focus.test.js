import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileNavigation } from '../frontend/mobile-navigation.js';
function fixture(t) {
  const old = globalThis.document;
  const dismiss = {}, accept = {}, outside = {};
  const alert = { hidden: false, contains: node => node === dismiss || node === accept };
  const planner = { hidden: true };
  const focusTarget = () => ({ focus() { document.activeElement = this; } });
  const edit = focusTarget(), start = focusTarget();
  const elements = new Map([['#reroute-alert', alert], ['#route-planner', planner], ['#edit-route', edit], ['#start-location', start], ['#accept-reroute', accept]]);
  globalThis.document = { activeElement: dismiss, querySelector: id => elements.get(id) };
  t.after(() => { globalThis.document = old; });
  return { nav: Object.create(MobileNavigation.prototype), alert, planner, edit, start, outside };
}
test('dismissing an alert restores focus to the visible collapsed-planner control', t => {
  const { nav, alert, edit } = fixture(t); nav.hideAlert();
  assert.equal(alert.hidden, true); assert.equal(document.activeElement, edit);
});
test('an alert cleared while editing returns focus to the visible start input', t => {
  const { nav, alert, planner, start } = fixture(t); planner.hidden = false; nav.hideAlert();
  assert.equal(alert.hidden, true); assert.equal(document.activeElement, start);
});
test('background alert clearance leaves unrelated keyboard focus in place', t => {
  const { nav, outside } = fixture(t); document.activeElement = outside; nav.hideAlert();
  assert.equal(document.activeElement, outside);
});
test('accepting the alternative restores focus without changing the selected route decision', t => {
  const { nav, alert, edit } = fixture(t); document.activeElement = document.querySelector('#accept-reroute');
  const route = {}; Object.assign(nav, { options: { alternative: route }, pending: [{}], renderRoutes() {}, notify() {} });
  nav.acceptAlternative();
  assert.equal(nav.active, route); assert.equal(nav.activeChoice, 'alternative');
  assert.deepEqual(nav.pending, []); assert.equal(alert.hidden, true); assert.equal(document.activeElement, edit);
});
