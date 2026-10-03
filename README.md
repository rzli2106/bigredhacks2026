# Micro-hazard sensing — Step 1

Dependency-free browser motion service and deterministic signal processor. This implements the first roadmap step only: it emits **impact candidates**, not confirmed potholes or accessibility hazards. No data is uploaded.

## Run checks

Requires Node.js 20 or later. Run `npm test`. No package installation is necessary.

## Browser integration

Import `MotionService` from `./src/motion-service.js` in a browser ES module. Construct it with `onCandidate(candidate)` and optionally `onStatus(status)` callbacks. Call and await `service.start()` directly inside a button's click handler, catching errors to show permission or compatibility feedback. Call `service.stop()` to release listeners. Supply threshold overrides through the optional `config` object.

Serve over HTTPS (localhost also works for local development). Browsers with `DeviceMotionEvent.requestPermission()` require a user gesture. Listener registration does not guarantee that a device will deliver sensor events. Missing acceleration or gyroscope readings are rejected; backgrounded pages are ignored and visibility changes reset the stream. This is an in-page service, not a background Service Worker. It has no UI yet.

The `onCandidate` callback receives the peak's monotonic timestamp in milliseconds (not a Unix timestamp), peak and baseline acceleration in m/s², peak jerk in m/s³, estimated FWHM in milliseconds, and output sample period. Location and wall-clock correlation belong to subsequent ingestion work.

## Processing decisions

1. Read `accelerationIncludingGravity` and compute `sqrt(x² + y² + z²)`. Compute angular speed as `sqrt(alpha² + beta² + gamma²) × π/180`, because browser gyroscope values are degrees/second.
2. Reject raw events above **5.2 rad/s** before resampling. Clear pending pulse and interpolation state so no jerk is calculated across a rejected window. Missing readings and gaps above **60 ms** also break continuity.
3. Linearly interpolate acceleration **magnitudes** onto a **20 ms / 50 Hz** grid. Faster events contribute bracketing values; duplicate and out-of-order timestamps are ignored. Magnitude-first interpolation avoids artificial dips when the coordinate frame rotates.
4. Calculate absolute acceleration-magnitude difference divided by **0.020 seconds**.
5. Calibrate a local baseline from the first **10** standardized samples. Outside a pulse, maintain a rolling baseline; freeze it while measuring a pulse. Start a positive pulse above baseline + **0.5 m/s²** and finish when it returns to that floor. Use interpolated crossings at half the peak height **above baseline** for FWHM, avoiding gravity's DC offset.
6. Emit once only when peak jerk is strictly **greater than 85 m/s³** and FWHM is strictly **less than 45 ms**. Discard unclosed pulses after **300 ms** and recalibrate; use a **250 ms** cooldown after closed pulses to reduce double counting.

The supplied final inequality was truncated; this implementation assumes `jerk > 85 AND FWHM < 45 ms`. Defaults are exported as `DEFAULT_CONFIG`. Baseline, gap, pulse-floor, and cooldown parameters are engineering assumptions introduced for a bounded streaming implementation, not validated physical constants.

## Limits and validation

At 50 Hz, a 45 ms pulse spans only about two sample intervals. Interpolation does not restore missing physical information, and lower hardware rates can miss or distort short impacts. FWHM is an estimate. Warm-up requires a relatively quiet period; handling noise below the rotation threshold can still pass. Only positive peaks above the local magnitude baseline are classified in this initial implementation.

The tests cover narrow and broad pulses, normal periodic movement, threshold boundaries, irregular timestamps, orientation invariance, degree-to-radian gating, missing sensors, gaps, lifecycle and permission behavior, and event-to-candidate integration. Real mobile hardware, sensor rates, battery use, and detection accuracy have **not** been validated. The specified thresholds alone cannot establish whether an event was caused by a physical hazard.

Browser references: [DeviceMotionEvent](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent), [rotationRate units](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/rotationRate).
