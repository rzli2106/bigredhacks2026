# Cornell map verification

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
