# Native device verification

Android APK and iOS simulator compilation are verified in CI. Physical sensor delivery, GPS precision, health-store delivery and background HealthKit wakes require a real device; they are not established by a successful build.

Current APK: main commit `dd0a9dc`, built in [native CI](https://github.com/rzli2106/bigredhacks2026/actions/runs/37116399781). Android health reads now terminate on null or empty page tokens, following [Health Connect pagination guidance](https://developer.android.com/health-and-fitness/health-connect/read-data). Web checks and both SDK builds passed; the empty-token behavior has not been exercised against a physical Health Connect provider.

## Install and pair

Use the latest `artifacts/native/clearpath-android-debug.apk` on Android 14 or newer. For iPhone, follow `native/README.md` to sync the app, open the iOS project in full Xcode, select a signing team and run on the phone.

On the desktop dashboard at https://www.clearpath.wiki, open **Connect Phone**, enter the Render `ADMIN_TOKEN` observer key and create a pairing link. In the installed native app, expand **Sharing & connection → Paste a pairing link**, paste that complete link and tap **Use this link**. The HTTPS QR opens the browser page; use the paste control when testing the native app. Keep the observer key and pairing link private.

## Check delivery

1. Tap **Start Sensors** and respond to the motion, location and native health permission prompts. **Motion sensors active** appears only after a valid processed motion sample arrives. A waiting message does not prove sample delivery.
2. Check the GPS accuracy/status and **Locate me**. Live navigation and reports require Cornell coverage. The native health status distinguishes receiving no new measurements from checking measurements and detecting a location-matched terrain change. An empty health store need not produce an anomaly.
3. Generate a walking route, confirm the planner collapses and walking time is visible, then reopen **Edit route**. Use an isolated backend for synthetic incident tests, or report an actual observed obstacle in production. Confirm the captured GPS pin stays fixed, choose a category, and explicitly confirm; the report count should increase once after acceptance.
4. Tap **Stop Sensors**. Sensor sharing stops and unsent sensor reports are discarded; GPS navigation remains active. The observer device count may take up to 45 seconds to expire. Verify that no additional automatic reports arrive after stopping.

For the background bridge check on iPhone, background and reopen the app, then confirm motion resumes only while sharing is enabled. Background health delivery also requires genuinely new permitted HealthKit records. Record device/OS, permission outcome, status changes and pass/fail without sharing raw health measurements, keys or pairing links.

Synthetic unit/browser tests already cover tumble rejection, threshold boundaries, delayed health records, malformed samples, deduplication and late permission/connection callbacks. These tests complement physical verification; they do not replace it.
