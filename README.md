# Micro-hazard sensing and routing scaffolding

Dependency-free JavaScript implementation of roadmap Steps 1–3: a browser motion service, deterministic signal processor, Overpass ingestion, directed walking graph, spatial edge index, and decaying event costs with route search. Sensing emits **impact candidates**, not confirmed potholes or accessibility hazards. Sensor data is not uploaded. Map ingestion sends only the requested bounding box and query to Overpass.

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

Conditional access, barrier enforcement, opening hours, polygon navigation, mobility-specific restrictions, and turn restrictions are not implemented. Preserve tags for those later steps. OSM data is attributed to **© OpenStreetMap contributors** under **ODbL-1.0**; preserve attribution when displaying or distributing maps.

References: [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL), [pedestrian direction tags](https://wiki.openstreetmap.org/wiki/Key:oneway:foot), [OSM attribution and license](https://www.openstreetmap.org/copyright).

## Step 3: dynamic costs and decay

`DynamicEdgeCosts` attaches an in-memory event registry to the graph's directed edge IDs. `EdgeEventList` returns a snapshot Map of edge IDs to event arrays; `getEvents(edgeId)` returns one edge's snapshot. Stored events and their exact coordinates are immutable. `recordEvent(edgeIdOrIds, report)` validates an entire submission before attaching it, and accepts the `edgeIds` returned by a nearest-edge lookup when both directions should be affected. Passing a single ID affects only that direction.

The report schema is `{ event_type, initial_penalty, half_life, timestamp, coordinate: { lat, lng } }`. Penalties and half-lives can be omitted to use these exported `EVENT_DEFAULTS`:

| Event type | Initial penalty (virtual meters) | Half-life (seconds) |
| --- | ---: | ---: |
| `POTHOLE` | 50 | 1,800 |
| `MUD` | 100 | 1,800 |
| `MANUAL_HAZARD` | 300 | 14,400 |
| `MANUAL_CLOSURE` | `Infinity` | 14,400 |

The mud penalty and manual-hazard half-life are configurable engineering defaults. **Hard closure expiry is separate from half-life**: `closureMaxSeconds` defaults to 14,400 seconds (four hours) and can be overridden per report as `closure_max`. This duration was unspecified in the roadmap and is an explicit policy assumption. Only `MANUAL_CLOSURE` permits an infinite penalty. A closure submitted with a finite penalty follows ordinary decay.

For an edge at time `t`, `weight(edgeId, t)` returns:

```text
distanceMeters + Σ(initial_penalty × 2 ** (-(t - timestamp) / half_life))
```

Only events with `timestamp <= t` contribute. Any unexpired infinite-penalty event returns `Infinity`, making the edge impassable. At `age >= closure_max`, that closure is removed. Infinite values never enter exponential multiplication. Finite events are removed once their remaining fraction is **strictly below 1%** (after approximately 6.644 half-lives); exactly 1% is retained. Other active events survive closure expiry.

Timestamps here are **Unix seconds**, defaulting to `Date.now() / 1000`. They are not Step 1's monotonic millisecond timestamps. In a browser, correlate a sensor candidate with wall time using `(performance.timeOrigin + candidate.timestamp) / 1000` before verification and ingestion. Geometry APIs use `{ lat, lon }`; report coordinates deliberately follow the requested `{ lat, lng }` schema. Reports retain the exact observation coordinate rather than replacing it with the snapped location.

```js
import { DynamicEdgeCosts, shortestPath } from './src/routing/index.js';

// graph and index come from loadRoutingZone() or an offline map fixture.
const costs = new DynamicEdgeCosts(graph, { closureMaxSeconds: 14400 });
const coordinate = { lat: 42.44, lng: -76.48 };
const match = index.nearest({ lat: coordinate.lat, lon: coordinate.lng });
if (match) {
  costs.recordEvent(match.edgeIds, {
    event_type: 'POTHOLE',
    timestamp: Date.now() / 1000,
    coordinate,
  });
}
// originNodeId and destinationNodeId must exist in graph.nodes.
const route = shortestPath(graph, originNodeId, destinationNodeId, { costs });
// route: { nodeIds, edgeIds, costMeters, distanceMeters }, or null if unreachable.
// Stop the maintenance timer when the owning application tears down:
costs.dispose();
```

The Dijkstra evaluator captures one time for each route request. `costMeters` includes hazard penalties; `distanceMeters` is physical route length. `baselineCostSeconds` is never added to meter penalties. Optional `timestamp` on `shortestPath` supports controlled simulations, and `costs.evaluator(time)` exposes the same weight callback to other search algorithms. Costs remain fixed during each search; this is not prediction of costs at future edge-arrival times.

Lazy cleanup occurs when evaluating an edge. A sweep every 60 seconds removes stale events from idle edges too; browser timer throttling can delay that sweep, but cost evaluation still removes expired events immediately. `prune(time)` supports explicit sweeps. Set `cleanupIntervalMs: 0` and inject a `now` function for deterministic simulations. Call `dispose()` when finished to release the timer. Pruning is destructive: this registry supports current/forward-time evaluation, not historical queries after events have been removed. Create a fresh registry for historical replay. Graph geometry and edge IDs should remain fixed for the registry's lifetime.

The full suite now contains **40 passing tests**, including additive independent decay, exact expiry boundaries, overlapping closures, future observations, input validation, atomic multi-edge updates, idle cleanup, and route changes as evidence ages. Persistence, report deduplication across repeated submissions, report verification, and spatial avoidance/clearance inference remain separate ingestion work. Raw Step 1 candidates are not automatically labeled as potholes or inserted into the registry.
