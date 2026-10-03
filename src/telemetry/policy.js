export const TELEMETRY_POLICY = Object.freeze({
  SENSOR_SHOCK: { event_type: 'SENSOR_SHOCK', penalty: 50, halfLife: 900 },
  TERRAIN_DRAG: { event_type: 'TERRAIN_DRAG', penalty: 100, halfLife: 1800 },
  MANUAL_HAZARD: { event_type: 'MANUAL_HAZARD', penalty: 300, halfLife: 3600 },
  MANUAL_CLOSURE: { event_type: 'MANUAL_CLOSURE', penalty: Infinity, halfLife: 14400 },
});
// Exactly 15% lower than the original impact thresholds (85 and 16).
// Gyro and pulse-width rejection ceilings remain unchanged to reject bag tumbles.
export const SHOCK_GATE = Object.freeze({ gyroLimitDegS: 300, jerkThreshold: 72.25, accelerationThreshold: 13.6, maxFwhmMs: 45 });
export function shockRejection(evidence) {
  if (!evidence || !['gyro_deg_s','peak_jerk','peak_acceleration','fwhm_ms'].every(key => Number.isFinite(evidence[key]) && evidence[key] >= 0)) return 'missing-motion-evidence';
  if (evidence.gyro_deg_s > SHOCK_GATE.gyroLimitDegS) return 'bag-tumble';
  if (evidence.peak_jerk <= SHOCK_GATE.jerkThreshold) return 'low-jerk';
  if (evidence.peak_acceleration <= SHOCK_GATE.accelerationThreshold) return 'low-impact';
  if (evidence.fwhm_ms <= 0 || evidence.fwhm_ms >= SHOCK_GATE.maxFwhmMs) return 'wide-impulse';
  return null;
}
export function unixSeconds(value) {
  const result = typeof value === 'string' ? Date.parse(value) / 1000 : value > 1e12 ? value / 1000 : value;
  if (!Number.isFinite(result) || result < 0) throw new Error('timestamp must be Unix seconds, milliseconds, or an ISO date.');
  return result;
}
