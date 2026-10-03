# Micro-hazard sensing and routing scaffolding

Dependency-free JavaScript implementation of roadmap Steps 1 and 2: a browser motion service, deterministic signal processor, Overpass ingestion, directed walking graph, and spatial edge index. Sensing emits **impact candidates**, not confirmed potholes or accessibility hazards. Sensor data is not uploaded. Map ingestion sends only the requested bounding box and query to Overpass.

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

## Step 2: routing graph

Import from `src/routing/index.js`. `loadRoutingZone({ south, west, north, east })` fetches OSM data and returns `{ graph, index }`. The caller must supply the target zone. An optional second argument accepts `walkingSpeedMps`, `endpoint`, `signal`, `timeoutMs`, and `fetchImpl`. For offline fixtures or cached responses, use `buildWalkingGraph(overpassJson)` and `new EdgeIndex(graph)` directly.

The Overpass query selects highway values `footway`, `pedestrian`, `path`, `sidewalk`, `residential`, and `steps`, then fetches their referenced nodes. Complete ways can extend beyond the requested box; geometry is not clipped. HTTP errors, Overpass runtime remarks, invalid coordinates, and missing referenced nodes fail explicitly. Requests time out after 30 seconds by default. There is no automatic retry loop against the public server.

The graph has:

- `nodes`: a Map of OSM IDs to `{ id, lat, lon, tags }` at termini, shared nodes, and tagged points.
- `edges`: a Map of stable directed IDs to `{ from, to, segmentId, wayId, direction, distanceMeters, baselineCostSeconds, tags }`. Baseline time is distance / **1.3 m/s**, with a configurable speed.
- `adjacency`: a Map from node ID to outgoing edge IDs.
- `segments`: shared physical polylines containing all intermediate geometry points, their directed `edgeIds`, and OSM tags. Distance is the sum of Haversine distances along the entire polyline.

Walking is bidirectional unless `oneway:foot` or `foot:forward`/`foot:backward` restricts it. Vehicle `oneway` is not applied to pedestrians. Explicit foot permissions override general access; foot prohibitions and private/general restricted access are excluded. Polygon areas are excluded because their boundaries are not walking routes. Crossings connect only through shared OSM node IDs, avoiding invented connections at bridges. Steps remain present with their tags for future accessibility policies.

Call `index.nearest({ lat, lon }, { maxDistanceMeters: 50 })` to get `{ segmentId, edgeIds, distanceMeters, coordinate, partIndex, fraction }`, or `null` outside the search radius. `coordinate` is the snapped point; `fraction` is along the specified polyline part in OSM order, independent of directed edge orientation. Both edge IDs are returned for bidirectional segments because a location alone cannot establish travel direction.

The static index is a packed binary bounding-box tree over individual polyline segments, with nearest-first traversal and distance pruning. It uses a local equirectangular metric projection; nearest distances are approximate geographic distances. The index accepts zones spanning at most one degree on each axis and latitudes within ±85°. Antimeridian-spanning and larger zones must be partitioned. Rebuild the index after changing graph geometry. Equal-distance ties return one segment; elevation, trajectory, or heading-based disambiguation is not implemented.

### Commands

```sh
npm test
npm run routing:benchmark
npm run routing:ingest -- SOUTH WEST NORTH EAST output.json
```

Replace the four uppercase arguments with numeric bounding-box coordinates. The import command fetches a map, constructs and validates its index, and writes a graph snapshot without overwriting existing files. The JSON snapshot encodes node/edge Maps as arrays of values and adjacency as entries; reconstruct Maps by ID when loading it, and rebuild the index from `segments`.

### Validation and scope

All 26 tests pass, including graph topology, full polyline cost, pedestrian access/direction, incomplete-data rejection, index matching against exhaustive distances, and mocked Overpass ingestion/errors/timeouts. A local Node.js benchmark on a synthetic 10,000-node grid (39,600 directed edges, 19,800 physical segments) measured 10,000 queries after warm-up: mean **0.009 ms**, p95 **0.016 ms**, p99 **0.042 ms**, maximum **0.580 ms**, with no misses. These measurements are specific to this machine and fixture, not a mobile-device or worst-case guarantee. Live Overpass ingestion has not been exercised and no target-zone map has been downloaded.

This is graph scaffolding, not a complete routing engine. Conditional access, barrier enforcement, opening hours, polygon navigation, mobility-specific restrictions, turn restrictions, dynamic hazard costs, and route search are not implemented. Preserve tags for those later steps. OSM data is attributed to **© OpenStreetMap contributors** under **ODbL-1.0**; preserve attribution when displaying or distributing maps.

References: [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL), [pedestrian direction tags](https://wiki.openstreetmap.org/wiki/Key:oneway:foot), [OSM attribution and license](https://www.openstreetmap.org/copyright).
