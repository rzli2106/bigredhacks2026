# PathPulse

A Cornell pedestrian map that receives derived phone hazards, changes walking routes, and lets evidence decay. Real OpenStreetMap geometry is shipped locally (2,337 nodes / 6,008 directed edges). Live observer and simulation modes have separate state; fictional samples never enter the live feed.

```sh
npm ci
npm run dev
# If another app uses 8000:
BACKEND_PORT=8001 npm run dev
```

Open http://127.0.0.1:5173. Choose **Starting point**, drop A; choose **Destination**, drop B; then find a walking route. Drag pins or use keyboard pan + Enter. Campus reloads use the bundled graph, with five landmark shortcuts and explicit outside-coverage feedback. Leaflet and the graph are served locally; background tiles come from OSM with attribution and a compliant referrer policy. For graph maintenance only, run `npm run map:refresh`.

**Connect Device** creates a four-hour scoped QR. On the phone, tap **Start sharing** to request motion/location permission. Raw motion is sampled onto a 50 Hz grid; gyro >300°/s, missing data, and wide impulses are rejected. An impact needs jerk >85 m/s³, magnitude >16 m/s², and FWHM <45 ms. A fresh Cornell fix is required before upload. The two-tap reporter captures location first, then selects a category; an explicit Cornell map-pin fallback handles unavailable GPS. Stop releases watchers and clears the queue. Rejected reports do not block later valid ones.

The Swift/Kotlin Capacitor bridge requests HealthKit mobility data or Android 14+ Health Connect StepsRecord/SpeedRecord. Local rolling baselines identify relative asymmetry jumps >15% or speed drops >50%; short step intervals normalize cadence and suppress confirmed stops. Delayed records never get attached to a current location. Native health data stays on the phone; only a fresh derived candidate and matched coordinate are sent. Health frameworks require a native app, not Safari/Chrome. See [native setup and validation limits](native/README.md).

Backend endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/pairing` | Observer-authorized, scoped phone QR |
| `POST /api/devices/heartbeat` | Paired device activity |
| `POST /api/telemetry/event` | Paired phone event ingestion |
| `POST /api/telemetry/manual` | Observer manual report |
| `POST /api/telemetry/passage` | Conservative swerve/clearance and spatial entropy checks |
| `POST /api/telemetry/verify` | Observer confirm/resolve |
| `GET /api/telemetry/snapshot` | Derived hazards and active device count |
| `WS /ws/stream` | Public read-only observer snapshots; reconnecting client |
| `POST /api/route` | Current dynamic route between `{lat,lon}` pins |
| `GET /api/health` | Service health |

Event payload: `{device_id,event_id,lat,lng,source,metric_type,severity,timestamp,accuracy_meters}`. Sources are `web_motion`, `native_motion`, `healthkit`, `health_connect`, `manual`; severity is `(0,1]`. Sensor shocks also need `{evidence:{gyro_deg_s,peak_jerk,peak_acceleration,fwhm_ms}}`. Timestamps may be Unix seconds/milliseconds or ISO, but must be fresh within two minutes. Events snap to a KD tree of real polyline primitives within 40 m and attach to applicable directions. Retry IDs deduplicate uploads. Public snapshots exclude device IDs and raw health values.

| Event | Initial virtual-meter penalty | Half-life / expiry |
| --- | --- | --- |
| SENSOR_SHOCK | 50 × severity | 15 min |
| TERRAIN_DRAG | 100 × severity | 30 min |
| MANUAL_HAZARD | 300 × severity | 60 min |
| MANUAL_CLOSURE | Infinity | Hard expiry at 240 min |

Finite cost is base distance + Σ `Pk × 2^(-(now-tk)/half_life)`, pruned below 1%. Infinity uses explicit expiry to avoid permanent blocks/NaN. Smooth traversal ≤0.8 m halves finite penalties; swerving >0.8–2.5 m preserves them. Full approach/departure, explicit shock-free evidence, high sample cadence, and sufficient precision are required. Typical phone GPS cannot support sub-meter clearance or a 0.5 m entropy grid; uncertain traces leave hazards unchanged. Congestion evidence changes traversal speed without erasing explicit closures. See [sensor and routing internals](docs/routing-engine.md).

Use **Simulation → Run all four** or `npm run simulate`: A injects a gated impact and detours 36 → 62 m; B rejects bag tumble in client/backend; C sends five precise bypass tracks and preserves the hazard; D verifies decay at +15/+30/+60 min and direct-path restoration. The time slider replays history when rewound, including confirmations/resolutions. Map-click injection offers all four types. Add samples switches to Simulation and creates clearly fictional campus incidents.

```sh
npm test
npm run simulate
npm run build
npm run sync:local -- --dry-run
```

[DEPLOYMENT.md](DEPLOYMENT.md) covers Vercel + Render HTTPS/WSS, environment/CORS, the ngrok phone-sync command, and optional custom DNS. **No GoDaddy domain is required**. Local pairing/verification is limited to direct loopback requests; remote production writes require the backend observer key or a scoped device token. No admin secret is bundled into the frontend.

Reports/pairings currently live in one backend process's memory and reset on restart. This is a hackathon implementation, not field-validated hazard detection or wheelchair accessibility routing. Browser and automated verification are documented in [UI verification](docs/ui-verification.md); native SDK builds, actual phone sensors/health delivery, a live ngrok tunnel, and hosted deployment need their respective toolchains/accounts/device checks.
