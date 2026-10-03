# Cornell map verification

## Current deployed mobile verification — October 3, 2026

Sharing status copy was corrected in minor main commit `fc0c980`, confirmed Live by Render. The public HTTPS page and a local 375-pixel browser show “Sensors inactive · start after pairing,” without an incorrect HTTPS warning. Initial health text reflects browser/native mode, and stopping native sharing clears the previous health message. Web checks and both SDK builds passed in [CI](https://github.com/rzli2106/bigredhacks2026/actions/runs/37115961275). Native label behavior on a physical phone remains unverified.

[Pairing recovery PR #6](https://github.com/rzli2106/bigredhacks2026/pull/6) is merged; Render confirmed `b46dece` Live. A 401/403 from heartbeat, event upload or raw motion stops sensor sharing, clears the invalid pairing and opens the paste-link controls. An isolated 375-pixel browser fixture used synthetic GPS and stubbed motion to verify expiry → stopped sensors/open pairing → fresh link/Connected → Stop Sensors. Two raw transport regressions fail against the previous code; **120 tests** and both SDK builds pass. Production remains connected to live hazards and opens pairing controls before requesting sensors when unpaired. Physical sensor delivery is not established by these checks.

[Route planning lifecycle PR #5](https://github.com/rzli2106/bigredhacks2026/pull/5) is merged; Render confirmed `5d2689a` Live. Only the current planning attempt can release Start Route or change planning status; cancellation restores controls and ignores late GPS results. Three regressions fail against the previous implementation, and **118 tests** pass. Both native SDK builds passed. A 375-pixel browser check recovered from an invalid destination and generated Ho Plaza → Arts Quad; public production verified Uris Hall → Ho Plaza (291 m / 4 min), with autocomplete and complete planner collapse.

Manual-report retry verification used a temporary, isolated browser build with synthetic Cornell GPS. The backend accepted the first report, but the fixture dropped its acknowledgement. Retry reused the event ID, closed the dialog, displayed exactly one report sent, and left exactly one backend hazard. The counter now treats a duplicate acknowledgement as confirmation of the original report. All 115 tests and the production build pass; the fixture is outside the repository and absent from production.

[Device transport PR #4](https://github.com/rzli2106/bigredhacks2026/pull/4) is merged; Render confirmed commit `75eb27f` Live. Uploads time out after 10 seconds, heartbeats after 60 seconds, overlapping heartbeats are suppressed, and stopped/restarted sharing ignores old responses. A full queue preserves its next report after an evicted in-flight upload succeeds or is rejected. All six new regression tests fail against the previous implementation; the full suite passes **115 tests**, with successful web, Android and iOS CI. The local APK was refreshed from [native CI](https://github.com/rzli2106/bigredhacks2026/actions/runs/37113838993). Local mobile checks repeated Ho Plaza → Arts Quad and Gates Hall → Bailey Hall; the public mobile page again showed live hazards, a 340 m / 5 minute route and complete planner collapse. Aborting a request cannot retract data already received by the server.

Follow-up reliability checks now pass **109 tests**. Queued/stale WebSocket callbacks cannot mutate a stopped/replaced stream; an isolated browser test recovered from a server restart and generated a route afterward. Switching server endpoints clears pending routes and stale hazard state. Production phone pairing was verified to generate canonical www.clearpath.wiki URLs without exposing its private token.

[Health validation PR #3](https://github.com/rzli2106/bigredhacks2026/pull/3) rejects malformed records before they contaminate baselines, preserves valid historical calibration, and selects valid precise GPS fixes. Four new cases fail against the previous detector. Unsupported pairing protocols now produce a useful error while the map remains functional. Native delivery-status updates and current Android/iOS SDK builds passed in [CI](https://github.com/rzli2106/bigredhacks2026/actions/runs/37112693627). Use `docs/native-device-verification.md` for the remaining physical-device checks.

Production is served over HTTPS at https://www.clearpath.wiki; https://clearpath.wiki redirects there. Render now deploys `main`. The mobile planner provides touch/keyboard autocomplete for both endpoints, separate start/end pin controls, physical walking time, complete planner collapse on success, and Edit route / Return to map controls. Browser verification covered 375 × 812 portrait and 812 × 375 landscape views.

Tested routes: Ho Plaza → Arts Quad (340 m, 5 min), Gates Hall → Bailey Hall (779 m, 10 min), and Uris Hall → Ho Plaza (291 m, 4 min). The first two also passed through the public production interface. Invalid destinations retain the planner; accidental map taps leave a running trip unchanged. Sound, pin cancellation, route switching, pairing failure, and report cancellation were exercised without browser console errors.

Isolated synthetic closure tests disabled the direct route immediately, allowed explicit acceptance of a 350 m open alternative, and refused to start a closed single-path walk without a detour. All 99 automated tests and production bundling passed. Both Android APK and iOS simulator builds passed in [native CI](https://github.com/rzli2106/bigredhacks2026/actions/runs/37110056213). The local verified APK is `artifacts/native/clearpath-android-debug.apk` (ignored build output).

Physical phone GPS/sensor delivery, HealthKit background wakes, and audible playback on actual phones remain unverified. Earlier records below describe historical local checks and their limitations at that time.

## Historical local verification

Tested locally at http://127.0.0.1:5173 using the browser UI, with desktop and 375 × 812 phone layouts.

| User action | Result |
| --- | --- |
| Choose Starting point, then click the map | A placed at the chosen coordinate; path connection and route update |
| Choose Destination, then click the map | B placed independently; Find a walking route displays a path route |
| Drag A or B | Endpoint labels, route geometry, distance and time update |
| Drop a pin outside campus | Coverage message; previous endpoint preserved; selection remains available |
| Cancel selection or press Escape | Selection banner closes without changing the pin |
| Pan map with keyboard, then Enter | Armed endpoint or report placed at center |
| Route from Ho Plaza to Arts Quad / Uris Hall / Gates Hall / Bailey Hall | Successful routes: 340 / 291 / 583 / 775 m before sample hazards |
| Same start and destination | 0 m, 0 min |
| Swap, zoom in/out, fit campus, toggle nodes | Each control changes the corresponding map state |
| Reload Cornell map | Fast local snapshot reload; selected pins and three submitted reports preserved |
| Load around my location / Show my location | Test browser GPS timed out; clear error, controls recover, campus map remains available |
| All five landmark buttons / Show entire campus | Requested landmark/campus appears with the walking graph still loaded |
| Report, choose map fallback, each of three categories | Closure, hazard and uneven-ground reports recorded on real paths |
| Confirm Still here | Report refreshed; closure renewed |
| Mark resolved / Undo | Report removed/restored and route recalculated |
| Undo newly submitted report | New report removed |
| Add samples twice | Three examples added on actual paths; no duplicates |
| Sample hazard on Ho Plaza–Arts Quad route | Route changed from 340 m to 377 m |
| List entry / map report pin / Close popup | Incident opens for verification and closes normally |
| Help/settings/report close controls, Escape, backdrop | Dialogs dismiss normally |
| Dismiss notification | Toast closes |
| Phone pin selection and report dialog | Readable banner and controls; no horizontal overflow |
| Fit route while switching phone/desktop sizes | Both endpoints retained in view after fixes |

Fixes found during testing: identical off-path-center pins previously counted their connection twice; route fit could retain dimensions from the preceding viewport or conflict with an in-progress zoom; phone route submission needed to return the user to the map. These flows were corrected and retested. Pending geolocation requests are ignored after the relevant dialog/selection is canceled.

Automated checks additionally cover all 25 campus route pairs, pedestrian one-way behavior, bends and partial segments, closure expiration, HTTP/schema/network failures with static fallback, and simulated fresh GPS fixes at all five landmarks. The browser's real GPS did not return a fix, so successful GPS acquisition on a physical phone remains unverified. Localhost supports browser geolocation; a physical phone needs an HTTPS origin. Sample incidents are fictional, and reports are kept only for the current page session.

## PathPulse integration verification — October 3, 2026

The newer PathPulse build extends the earlier Waymark controls with a shared backend, phone page, native health sources, and isolated simulation. The earlier session-only reporting limitations above are superseded by README.md / DEPLOYMENT.md.

- **80 automated tests pass.** Existing sensor, geometry, partial-edge routing, all 25 Cornell landmark combinations, decay, and spatial entropy checks remain green. New tests exercise policy/schema/freshness, evidence rejection, dedup, direct clearance, precise swerves, health sample age/location/cadence matching, HTTP pairing/auth/CORS, two simultaneous WebSocket observers, token expiry, closure renewal/replay, and a phone queue that continues after a rejected report.
- **Production bundle builds.** `NODE_ENV=production npm run build` creates both pages and locally served Leaflet assets. `npm run simulate` passes A–D on the actual Cornell graph. `sync:local -- --dry-run` validates the command plan without creating a tunnel.
- **Visible user testing:** Connect Device → create QR → copy feedback and readable link; open the paired `/mobile` interface; Start sharing; Report here → Cornell map fallback → choose a real path → send hazard. Phone counter increased and the live observer immediately displayed the report and one active device. Phone closure and uneven-ground categories also reached the backend. Stop/restart, valid/invalid pasted links, cancellation, and keyboard map placement were exercised. Test live reports were resolved afterward.
- **Five visible pin routes:** Ho Plaza → Arts Quad (340 m), Arts Quad → Uris Hall (329 m), Uris Hall → Gates Hall (430 m), Gates Hall → Bailey Hall (779 m), Bailey Hall → Ho Plaza (775 m). Each used the real Starting point/Destination controls, landmark view, map pin placement, and Find a walking route; none showed a route error.
- **Map/control coverage:** zoom in/out, fit campus, node overlay on/off, swap endpoints, campus reload, entire-campus reset, all five landmark buttons, information dialog, report dialog, pin cancellation, observer report submission/undo, Still here, and Mark resolved. Location/nearby controls timed out in this desktop browser and showed actionable landmark/map fallback while leaving the map usable.
- **Simulation UI:** individual A/B/C/D controls and Run all four passed visibly. A changed the route 36 → 62 m; B produced no payload/event; C retained after five bypasses; D verified 25 / 12.5 / 3.125 m decay. Slider Home/End and +15 min worked, all four map injection types worked, reset cleared simulation, and repeated Add samples retained exactly three examples. Confirming then resolving a closure remained resolved after a rewind.
- **Responsive checks:** phone page and observer at 375 × 812, no horizontal overflow; observer at 812 × 375 landscape, with a taller scrollable map so controls do not collide. Keyboard alternatives and explicit labels accompany color/drag controls. The default viewport was restored.

Bugs found during testing and fixed: server referrer suppression caused OSM policy-block tiles; corrected to strict-origin-when-cross-origin and verified normal tiles. Renewed simulation closures lost their verification identity; fixed history ID updates/replay. Copy status was hidden behind the pairing dialog; moved it inline and added a readable link. Permanently rejected phone reports blocked later valid reports; discard them with visible feedback. Stop sharing could receive late connection callbacks; inactive transports now ignore them. Native shells now start at the actual `/mobile.html` asset and use Capacitor native location rather than assuming WebView GPS support.

Native checks: Swift source parses syntactically; Capacitor generates/syncs Android and discovers `pathpulse-health` and `@capacitor/geolocation`; generated Android minimum SDK is 34. Native SDK compilation is **not verified**: no Android SDK/Android Studio, full Xcode, or CocoaPods is installed. iOS project creation stopped at the CocoaPods environment check. Physical phone sensor/GPS/health delivery, background HealthKit wakes, a live ngrok tunnel, and deployed Vercel/Render hosts are not claimed as tested. No domain or hosting account was modified.

## Map-first mobile navigation — October 3, 2026

The mobile client now uses a full-screen Leaflet map, overlaid route planner, and compact bottom dock. Production bundling and 97 automated tests pass; simulation A–D remains green. Automated coverage includes exact 15% impact threshold changes and strict cutoffs, smaller raw impacts, real campus detour exclusions, zero-length junction connectors, physical walking ETAs, unreachable alternatives, expired closures, fresh GPS/place parsing, ahead/behind intersection checks, repeated snapshot suppression, route options HTTP validation, and category metadata/privacy.

Browser verification used a 390 × 844 portrait view and an 812 × 375 landscape view. Ho Plaza → Arts Quad displayed two distinct routes (340 m / 347 m), ETA cards, a blue selected route and grey alternative, compact controls, and no browser console errors. A temporary build-only GPS fixture at the actual Cornell simulation corridor exercised the full live reporting flow: Report opened at the synthetic current fix with a non-draggable pin; Expand/Minimize preserved its coordinate; category selection kept the sent count at zero; Confirm Report sent the Pothole/Rough Terrain category and produced the live WebSocket alert. The 36 m direct route remained selected before the decision; Accept selected the 62 m detour, and Dismiss preserved the direct route without replay alerts.

The fixture is absent from the final build, and its reports were cleared by restarting only the local preview. Physical GPS delivery, phone sensor hardware, and audible chime playback on iOS/Android are not claimed as verified. HTTPS and actual-device checks remain necessary after redeploying the frontend and backend.
