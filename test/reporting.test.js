import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDeviceLocation, incidentAppearance, submitIncident } from '../src/ui/reporting.js';
import { createSampleArea, sampleCoordinate } from '../src/ui/sample-area.js';
import { DynamicEdgeCosts, EdgeIndex } from '../src/routing/index.js';

const T = 1700000000;
function fixture() {
  const { graph } = createSampleArea();
  return { costs: new DynamicEdgeCosts(graph, { now: () => T, cleanupIntervalMs: 0 }), index: new EdgeIndex(graph) };
}
const location = () => ({ ...sampleCoordinate(440, 640), timestamp: T, source: 'device', accuracyMeters: 3 });

test('first-tap capture requests a fresh position and freezes the result', async () => {
  let options;
  const result = await captureDeviceLocation({ getCurrentPosition(success, _error, config) {
    options = config;
    success({ coords: { latitude: 42.44, longitude: -76.48, accuracy: 3 }, timestamp: T * 1000 });
  } });
  assert.equal(options.maximumAge, 0);
  assert.equal(options.enableHighAccuracy, true);
  assert.equal(result.timestamp, T);
  assert.throws(() => { result.lat = 0; }, TypeError);
});

test('denied and unsupported geolocation produces actionable feedback', async () => {
  await assert.rejects(captureDeviceLocation(null), /map/);
  await assert.rejects(captureDeviceLocation({ getCurrentPosition(_success, fail) { fail({ code: 1 }); } }), /denied/);
});

test('all three categories map to registry events on both directed edges', () => {
  for (const [category, type] of [['closure','MANUAL_CLOSURE'], ['hazard','MANUAL_HAZARD'], ['uneven','MUD']]) {
    const f = fixture();
    const saved = submitIncident({ ...f, category, location: location(), now: T + 1 });
    assert.equal(saved.event.event_type, type);
    assert.equal(saved.edgeIds.length, 2);
    assert.equal(saved.event.timestamp, T);
    assert.equal(saved.event.coordinate.lat, location().lat);
    assert.equal(saved.event.coordinate.lng, location().lon);
  }
});

test('missing, stale, imprecise and unmatched coordinates cannot produce a report', () => {
  const f = fixture();
  for (const position of [null, { ...location(), timestamp: T - 121 }, { ...location(), accuracyMeters: 100 }, { ...location(), lat: 0, lon: 0 }]) {
    assert.throws(() => submitIncident({ ...f, category: 'hazard', location: position, now: T }));
  }
  assert.throws(() => submitIncident({ ...f, category: '__proto__', location: location(), now: T }));
  assert.equal([...f.costs.EdgeEventList.values()].flat().length, 0);
});

test('an explicitly selected map point can be reported without device precision', () => {
  const f = fixture();
  const saved = submitIncident({ ...f, category: 'hazard', location: { ...location(), source: 'map', accuracyMeters: 0 }, now: T });
  assert.equal(saved.source, 'map');
});

test('finite hazard pins fade in proportion to remaining penalty while closures stay visible', () => {
  const event = { initial_penalty: 300, timestamp: T, half_life: 1800 };
  const fresh = incidentAppearance(event, T), half = incidentAppearance(event, T + 1800), old = incidentAppearance(event, T + 3600);
  assert.equal(fresh.opacity, 1);
  assert.equal(half.opacity, 0.5);
  assert.equal(old.penalty, 75);
  assert.notEqual(old.color, fresh.color);
  assert.equal(incidentAppearance({ ...event, initial_penalty: Infinity }, T + 100000).opacity, 1);
});
