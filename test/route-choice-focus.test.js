import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileNavigation } from '../frontend/mobile-navigation.js';
function fixture(t) {
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  function element() {
    return { dataset: {}, children: [], setAttribute() {}, append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; }, focus() { document.activeElement = this; } };
  }
  const choices = element(), edit = element(), previous = element(); previous.dataset.routeChoice = 'alternative';
  globalThis.document = { activeElement: previous, createElement: element, querySelector: id => id === '#route-options' ? choices : edit };
  globalThis.window = { L: { polyline: () => ({ addTo() {} }) } };
  t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
  const direct = { status: 'ok', edgeIds: ['a'], geometry: [], hazard_ids: [], distanceMeters: 340, durationSeconds: 262 };
  const alternative = { ...direct, edgeIds: ['b'] };
  const nav = Object.create(MobileNavigation.prototype);
  Object.assign(nav, { active: direct, options: { direct, alternative }, routes: { clearLayers() {} }, renderActive() {} });
  return { nav, choices, edit, previous };
}
test('rebuilding route cards preserves keyboard focus on the corresponding choice', t => {
  const { nav, choices, previous } = fixture(t);
  nav.renderRoutes();
  assert.notEqual(document.activeElement, previous);
  assert.equal(document.activeElement, choices.children[1]);
  assert.equal(document.activeElement.dataset.routeChoice, 'alternative');
});
test('removed or newly blocked focused choices return focus to Edit route', t => {
  const { nav, edit } = fixture(t);
  nav.options.alternative.blocked = true;
  nav.renderRoutes(); assert.equal(document.activeElement, edit);
  const missing = { dataset: { routeChoice: 'alternative' } }; document.activeElement = missing;
  nav.options.alternative = null;
  nav.renderRoutes(); assert.equal(document.activeElement, edit);
});
test('background card updates do not steal focus from another control', t => {
  const { nav, edit } = fixture(t); document.activeElement = edit;
  nav.renderRoutes(); assert.equal(document.activeElement, edit);
});
