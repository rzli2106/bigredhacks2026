import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthAnalyzer } from '../frontend/health-analysis.js';

const now = 1800000000;
const fix = { lat: 42.4468, lon: -76.485, accuracyMeters: 3, timestamp: now };
const slow = { id: 'slow', metric: 'speed', value: .4, start: now, end: now, source: 'healthkit' };
function analyzer() {
  const result = new HealthAnalyzer();
  result.ingest(Array.from({ length: 5 }, (_, i) => ({ ...slow, id: `baseline-${i}`, value: 1.4, start: now - 10 + i, end: now - 10 + i })), [], now);
  return result;
}

test('malformed health ranges cannot generate an event or consume a corrected sample ID', () => {
  for (const changes of [{ start: undefined }, { start: NaN }, { start: now + 1 }, { start: -1 },
    { end: now + 6 }, { metric: 'unknown' }, { source: 'unknown' }, { value: Infinity }]) {
    const subject = analyzer();
    assert.equal(subject.ingest([{ ...slow, ...changes }], [fix], now).length, 0);
    assert.equal(subject.ingest([slow], [fix], now).length, 1);
  }
});

test('valid aggregated health history can calibrate a baseline but cannot be assigned to an instantaneous GPS fix', () => {
  const subject = new HealthAnalyzer();
  const historical = Array.from({ length: 5 }, (_, i) => ({ ...slow, id: `aggregate-${i}`, value: 1.4, start: now - 3600 - 300 + i, end: now - 3600 + i }));
  assert.deepEqual(subject.ingest(historical, [fix], now), []);
  assert.deepEqual(subject.ingest([{ ...slow, id: 'aggregated-slow', start: now - 61 }], [fix], now), []);
  assert.equal(subject.ingest([slow], [fix], now).length, 1);
});

test('invalid health records cannot inflate the walking-speed baseline into a false report', () => {
  const subject = analyzer();
  const corrupt = Array.from({ length: 15 }, (_, i) => ({ ...slow, id: `bad-${i}`, start: undefined, end: now - 2, value: 100 }));
  assert.deepEqual(subject.ingest(corrupt, [fix], now), []);
  assert.deepEqual(subject.ingest([{ ...slow, id: 'ordinary', value: 1.3 }], [fix], now), []);
  assert.equal(subject.ingest([slow], [fix], now).length, 1);
});

test('health anomalies require valid precise coordinates and can select a valid fix over a corrupt nearer fix', () => {
  for (const changes of [{ lat: 91 }, { lon: -181 }, { accuracyMeters: -1 }, { timestamp: NaN }, { lat: undefined }]) {
    const invalid = { ...fix, ...changes };
    assert.equal(analyzer().ingest([slow], [invalid], now).length, 0);
    const events = analyzer().ingest([slow], [invalid, { ...fix, timestamp: now - 1 }], now);
    assert.equal(events.length, 1); assert.equal(events[0].lat, fix.lat); assert.equal(events[0].lng, fix.lon);
  }
});

test('unsupported step records do not suppress a valid walking anomaly', () => {
  const subject = analyzer();
  const events = subject.ingest([{ id: 'bad-stop', metric: 'steps', source: 'unknown', value: 0, start: now - 5, end: now }, slow], [fix], now);
  assert.equal(events.length, 1);
  assert.deepEqual(analyzer().ingest([null, {}, { ...slow, id: '' }], [fix], now), []);
});
