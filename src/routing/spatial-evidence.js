import { EARTH_RADIUS_M, radians, validateCoordinate } from './geo.js';

export function localProjection(origin) {
  validateCoordinate(origin);
  if (Math.abs(origin.lat) > 85) throw new RangeError('Spatial evidence requires a local zone away from the poles.');
  const xScale = EARTH_RADIUS_M * Math.cos(radians(origin.lat)) * Math.PI / 180;
  const yScale = EARTH_RADIUS_M * Math.PI / 180;
  return ({ lat, lon }) => {
    validateCoordinate({ lat, lon });
    // Wrap longitudinal differences for local traces crossing the antimeridian.
    const dLon = ((lon - origin.lon + 540) % 360) - 180;
    if (Math.abs(lat - origin.lat) > 1 || Math.abs(dLon) > 1) throw new RangeError('Spatial evidence coordinates must be within a local one-degree zone.');
    return { x: dLon * xScale, y: (lat - origin.lat) * yScale };
  };
}

export function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const squared = dx * dx + dy * dy;
  const fraction = squared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0;
  return { distanceMeters: Math.hypot(point.x - a.x - fraction * dx, point.y - a.y - fraction * dy), fraction };
}

/** Points: {lat, lon, timestamp: Unix seconds, accuracyMeters}. */
export function analyzePassage(trace, coordinate, {
  clearanceMeters = 0.8,
  avoidanceMeters = 2.5,
  maxSampleGapSeconds = 0.5,
  maxSpeedMps = 6,
} = {}) {
  for (const value of [clearanceMeters, avoidanceMeters, maxSampleGapSeconds, maxSpeedMps]) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('Passage thresholds must be positive.');
  }
  if (clearanceMeters >= avoidanceMeters) throw new RangeError('Clearance threshold must be smaller than avoidance threshold.');
  const inconclusive = (reason, distanceMeters = null) => ({ classification: 'inconclusive', reason, distanceMeters });
  if (!Array.isArray(trace) || trace.length < 3) return inconclusive('insufficient-trace');
  const project = localProjection({ lat: coordinate.lat, lon: coordinate.lng });
  const points = trace.map((point) => ({ ...point, ...project(point) }));
  if (points.some((point) => !Number.isFinite(point.timestamp) || point.timestamp < 0 ||
      !Number.isFinite(point.accuracyMeters) || point.accuracyMeters < 0)) return inconclusive('missing-trace-quality');
  let nearest = null;
  let lower = Infinity, upper = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dt = b.timestamp - a.timestamp;
    if (dt <= 0 || dt > maxSampleGapSeconds) return inconclusive('trace-gap-or-order');
    if (Math.hypot(b.x - a.x, b.y - a.y) / dt > maxSpeedMps) return inconclusive('implausible-speed');
    const hit = pointSegmentDistance({ x: 0, y: 0 }, a, b);
    const accuracyMeters = Math.max(a.accuracyMeters, b.accuracyMeters);
    lower = Math.min(lower, Math.max(0, hit.distanceMeters - accuracyMeters));
    upper = Math.min(upper, hit.distanceMeters + accuracyMeters);
    if (!nearest || hit.distanceMeters < nearest.distanceMeters) {
      nearest = { ...hit, accuracyMeters, partIndex: i - 1 };
    }
  }
  // Require approach and departure, so a partial trace or a stationary observer cannot clear a pin.
  const first = points[0], last = points.at(-1);
  if (Math.hypot(first.x, first.y) - first.accuracyMeters <= avoidanceMeters ||
      Math.hypot(last.x, last.y) - last.accuracyMeters <= avoidanceMeters) {
    return inconclusive('incomplete-passage', nearest.distanceMeters);
  }
  const closestIsEndpoint = (nearest.partIndex === 0 && nearest.fraction === 0) ||
    (nearest.partIndex === points.length - 2 && nearest.fraction === 1);
  if (closestIsEndpoint) return inconclusive('no-passage', nearest.distanceMeters);
  const tolerance = 1e-8;
  const classification = upper <= clearanceMeters + tolerance ? 'clearance'
    : lower > clearanceMeters + tolerance && upper <= avoidanceMeters + tolerance ? 'avoidance' : 'inconclusive';
  return { classification, reason: classification === 'inconclusive' ? 'outside-range-or-uncertain' : null,
    distanceMeters: nearest.distanceMeters, uncertaintyMeters: nearest.accuracyMeters,
    lowerDistanceMeters: lower, upperDistanceMeters: upper };
}

/** H = -sum(p * log2(p)); empty cells contribute zero. */
export function spatialEntropy(counts) {
  const values = [...counts];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new RangeError('Cell counts must be finite and nonnegative.');
  const total = values.reduce((sum, value) => sum + value, 0);
  return total ? values.reduce((h, count) => count ? h - count / total * Math.log2(count / total) : h, 0) : 0;
}

/** Coarse heading/speed features from precise geographic traces; ignores sub-meter jitter. */
export function extractDeflections(trace, {
  minTurnDegrees = 30, minTurnTravelMeters = 0.5, minSeparationSeconds = 1,
  slowdownRatio = 0.5, baselineSpeedMps = 1.3,
  maxSampleGapSeconds = 0.5, maxSpeedMps = 6,
} = {}) {
  for (const value of [minTurnDegrees, minTurnTravelMeters, minSeparationSeconds, slowdownRatio, baselineSpeedMps, maxSampleGapSeconds, maxSpeedMps]) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('Deflection extraction thresholds must be positive.');
  }
  if (minTurnDegrees > 180 || slowdownRatio >= 1) throw new RangeError('Invalid heading angle or slowdown ratio.');
  if (!Array.isArray(trace) || trace.length < 3) return [];
  const project = localProjection(trace[0]);
  const points = trace.map((point) => ({ ...point, ...project(point) }));
  if (points.some((point) => !Number.isFinite(point.timestamp) || point.timestamp < 0 ||
      !Number.isFinite(point.accuracyMeters) || point.accuracyMeters < 0)) return [];
  const candidates = [];
  const anchors = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dt = b.timestamp - a.timestamp;
    if (dt <= 0 || dt > maxSampleGapSeconds) return [];
    const speed = Math.hypot(b.x - a.x, b.y - a.y) / dt;
    if (speed > maxSpeedMps) return [];
    if (speed < baselineSpeedMps * slowdownRatio) candidates.push({ point: b, kind: 'slowdown' });
    const last = anchors.at(-1);
    if (Math.hypot(b.x - last.x, b.y - last.y) >= minTurnTravelMeters) anchors.push(b);
  }
  for (let i = 1; i < anchors.length - 1; i++) {
    const a = anchors[i - 1], b = anchors[i], c = anchors[i + 1];
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    const angle = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))))) * 180 / Math.PI;
    if (angle >= minTurnDegrees) candidates.push({ point: b, kind: 'turn' });
  }
  candidates.sort((a, b) => a.point.timestamp - b.point.timestamp);
  let lastTimestamp = -Infinity;
  return candidates.flatMap(({ point, kind }) => {
    if (point.timestamp - lastTimestamp < minSeparationSeconds) return [];
    lastTimestamp = point.timestamp;
    const { lat, lon, timestamp, accuracyMeters } = point;
    return [{ lat, lon, timestamp, accuracyMeters, kind }];
  });
}
