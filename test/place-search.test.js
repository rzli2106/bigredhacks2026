import test from 'node:test';
import assert from 'node:assert/strict';
import { placeSuggestions } from '../frontend/place-search.js';

test('campus suggestions update for partial, case-insensitive and multiword searches', () => {
  assert.deepEqual(placeSuggestions('  HO ').map(p => p.name), ['Ho Plaza']);
  assert.deepEqual(placeSuggestions('hall gates').map(p => p.name), ['Gates Hall']);
  assert.deepEqual(placeSuggestions('hall').map(p => p.name), ['Uris Hall', 'Gates Hall', 'Bailey Hall']);
  assert.deepEqual(placeSuggestions('unknown'), []);
});
test('live GPS is offered for starts only and empty queries expose campus choices', () => {
  assert.equal(placeSuggestions('').length, 5);
  assert.equal(placeSuggestions('', { live: true }).length, 6);
  assert.deepEqual(placeSuggestions('live'), []);
  assert.equal(placeSuggestions('live', { live: true })[0].name, 'My live location');
});
