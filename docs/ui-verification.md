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
