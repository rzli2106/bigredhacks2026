# ClearPath

**A clearer way to walk.**

ClearPath is a pedestrian navigation prototype built for **BigRedHacks 2026**. It combines real Cornell walking paths with crowdsourced reports and possible sensor impacts to help walkers respond to temporary obstacles. Reports lose influence over time, and fresh evidence can confirm or resolve them.

[Open the dashboard](https://www.clearpath.wiki/) · [Open walking navigation](https://www.clearpath.wiki/mobile)

## What it does

- **Plan a campus walk:** search Cornell landmarks or place start and destination pins on the map.
- **Compare routes:** see walking distance, estimated duration, and an available alternative.
- **Report obstacles:** capture a location, adjust the pin, choose a category, and explicitly confirm the report.
- **Receive live updates:** new hazards on the selected route trigger an Accept/Dismiss reroute proposal.
- **Verify a passed hazard:** “Is this still here?” appears for three seconds; **Still here** refreshes the report, **Gone** resolves it, and no response leaves it unchanged.
- **Explore simulations:** test impacts, bag tumbles, avoidance, and decay without adding fictional reports to the live feed.

## Quick start

Requires **Node.js 20 or newer** and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173** for the dashboard or **http://127.0.0.1:5173/mobile** for walking navigation. The development command builds the frontend and starts the frontend server and backend. It does not watch source changes; restart it after editing.

If port 8000 is already in use:

```sh
BACKEND_PORT=8001 npm run dev
```

For configuration, use `.env.example` as a reference. Keep `ADMIN_TOKEN` private; never put it in a `PUBLIC_*` variable or commit credentials.

### Try a route

On the dashboard, choose **Starting point**, place pin A, choose **Destination**, place pin B, and select **Find a walking route**.

On `/mobile`, choose **Arts Quad** as the start and **Ho Plaza** as the destination, then select **Start Route**. The planner collapses to show the map. Use **Edit route** to change the endpoints.

Motion and location access require a secure context. For a physical phone, use the hosted HTTPS app or the local tunnel workflow in [DEPLOYMENT.md](DEPLOYMENT.md); the phone’s `127.0.0.1` does not refer to your computer. Manual routing between landmarks does not require sensor sharing.

### Try the simulations

Choose **Simulation → Run all four**, or run:

```sh
npm run simulate
```

| Scenario | Demonstrates |
| --- | --- |
| A · Pothole | A generated impact adds a penalty and changes the weighted route. |
| B · Bag tumble | Rotation gating rejects a generated tumble. |
| C · Swerves | Precise synthetic bypass traces reinforce a hazard. |
| D · Decay | A finite penalty halves over time and the weighted route returns. |

**Add samples** switches to Simulation and creates fictional incidents. Simulation state is separate from live reports.

## How it works

1. **Collect evidence.** Users submit manual reports, or motion filters identify possible impacts.
2. **Match a walking path.** A spatial index finds the nearest OpenStreetMap segment within 40 meters.
3. **Update costs.** Events attach temporary penalties to the relevant directed graph edges.
4. **Calculate routes.** Dijkstra’s algorithm evaluates paths using the applicable cost policy.
5. **Update connected maps.** WebSockets broadcast derived hazard snapshots after changes and every five seconds by default.

The bundled Cornell network contains **2,337 nodes and 6,008 directed edges**. Leaflet renders the map; OpenStreetMap supplies background tiles and walking geometry. Refresh the bundled geometry with `npm run map:refresh`.

### Time decay

A finite hazard contributes:

```text
remaining penalty = initial penalty × 2^(-age / half-life)
```

For example, a 50-meter penalty with a 15-minute half-life becomes 25 after 15 minutes and 12.5 after 30 minutes. Penalties are **virtual meters for route selection**, not additional distance or walking time. Finite events are pruned below 1% of their original penalty.

| Event | Initial penalty × severity | Half-life / expiry |
| --- | --- | --- |
| Sensor shock | 50 virtual meters | 15-minute half-life |
| Terrain drag | 100 virtual meters | 30-minute half-life |
| Manual hazard | 300 virtual meters | 60-minute half-life |
| Manual closure | Impassable | Hard expiry after four hours, or explicit resolution |

The core weighted router supports gradual cost decay. **Mobile alternatives currently exclude all active hazard edges**, while the direct route provides a distance-based comparison. Walking estimates use physical distance and traversal speed, including supported congestion effects.

### Sensors and native integration

The shared motion filter targets a 50 Hz sample grid and checks rotation, jerk, peak acceleration, and baseline-relative impulse width. Missing sensor data and broken sample continuity reset the filter. These checks produce **impact candidates**, not verified pothole classifications.

- **Browser:** raw motion is uploaded in bounded authenticated WebSocket batches and filtered on the backend; local filtering also runs.
- **Native:** Swift/Core Motion and Kotlin/SensorManager provide samples through Capacitor; gated impact candidates are uploaded.
- **Native health:** HealthKit or Android 14+ Health Connect supplies available mobility records. Local analysis matches fresh anomalies to location; raw health measurements stay on the phone.

See [native setup](native/README.md) and [device verification limits](docs/native-device-verification.md).

## Tech stack and code map

| Component | Technology | Main files |
| --- | --- | --- |
| Frontend | JavaScript, HTML, CSS, Leaflet | `frontend/mobile.js`, `frontend/mobile-navigation.js`, `src/ui/app.js` |
| Backend | Node.js HTTP server, `ws` | `backend/server.js`, `backend/engine.js` |
| Walking graph and routing | OpenStreetMap, KD-tree spatial index, Dijkstra | `src/routing/graph.js`, `edge-index.js`, `shortest-path.js` |
| Dynamic costs | In-memory events and exponential decay | `src/routing/dynamic-cost.js` |
| Motion filtering | Shared JavaScript pipeline | `src/sensor-pipeline.js`, `src/telemetry/policy.js` |
| Spatial evidence | Clearance, avoidance, and entropy checks | `src/routing/disambiguation.js`, `spatial-evidence.js` |
| Native bridge | Capacitor, Swift, Kotlin | `native/clearpath-health/` |
| Build and checks | esbuild, Node test runner, GitHub Actions | `scripts/build.js`, `test/`, `.github/workflows/` |

## API overview

Device submissions require a scoped device token. Observer reporting and administrative verification require the observer key in production. Route queries and derived snapshots are publicly readable.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/devices/register` | Create or renew a scoped device session. |
| `POST /api/devices/heartbeat` | Update device activity. |
| `POST /api/telemetry/event` | Submit a manual or derived event. |
| `POST /api/telemetry/raw` | Submit raw browser motion batches over HTTP. |
| `POST /api/telemetry/passage` | Submit a trace for spatial evidence analysis. |
| `POST /api/telemetry/feedback` | Confirm or resolve a nearby hazard. |
| `POST /api/telemetry/manual` | Submit an observer-authorized manual report. |
| `POST /api/telemetry/verify` | Confirm or resolve a report as an observer. |
| `GET /api/telemetry/snapshot` | Read current derived hazards. |
| `POST /api/route/options` | Get direct and available alternative routes. |
| `POST /api/route` | Get a dynamically weighted route. |
| `GET /api/cornell-map` | Read the bundled walking map. |
| `GET /api/health` | Check service health. |
| `/ws/stream` | Read live derived snapshots. |
| `/ws/device` | Upload authenticated browser motion. |

Repeated event IDs deduplicate report retries. Public snapshots omit device IDs, raw motion, and raw health values. Development loopback requests can use observer controls without a key; this bypass is disabled in production.

## Development and deployment

```sh
npm test                  # Automated checks
npm run build             # Build the dashboard and mobile app into dist/
npm run routing:benchmark # Benchmark nearest-edge lookup, not full routing load
```

The backend can serve the built frontend and API together. Production requires an `ADMIN_TOKEN`, allowed origins, and HTTPS/WSS URLs. Native builds also need the correct public backend URLs before syncing.

- [Deployment and environment configuration](DEPLOYMENT.md)
- [Routing and sensor internals](docs/routing-engine.md)
- [Browser verification](docs/ui-verification.md)
- [Native setup](native/README.md)
- [Physical-device verification checklist](docs/native-device-verification.md)

## Current limitations

ClearPath is a hackathon prototype:

- **Cornell coverage only:** location suggestions contain five campus landmarks, and routing uses a bundled OSM snapshot.
- **In-memory shared state:** reports and device sessions reset when the backend restarts; multiple backend instances do not share state.
- **No proof of report truth:** authorization, validation, rate limits, and deduplication limit misuse but do not establish that a report or location is genuine.
- **Conservative spatial clearance:** automatic swerve/clearance and crowd checks require unusually precise trajectories; uncertain observations do not clear hazards.
- **Field validation pending:** automated tests and native compilation do not establish real-device detection accuracy, battery usage, or health-record delivery.
- **No complete wheelchair profile:** steps, slopes, surfaces, and curb access need additional accessibility policies and validation.

OpenStreetMap geometry and tiles retain their contributor attribution. The bundled map data is licensed under **ODbL-1.0**.
