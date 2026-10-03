# Native mobility bridge

The local `pathpulse-health` Capacitor 7 plugin contains Swift HealthKit and Kotlin Health Connect implementations. The phone web interface uses the same transport in a native shell; a browser falls back to Web Motion and GPS-pinned reporting with explicit confirmation. Node 20 is sufficient for Capacitor 7. Native projects are generated locally and ignored; plugin sources and configuration are tracked.

## iOS

Requires macOS with **full Xcode**, an iOS signing team with HealthKit capability, and a physical HealthKit-capable device. This project uses Swift Package Manager and does not require CocoaPods. `native:ios` works around the Capacitor 7.6.9 CLI SPM argument bug without modifying installed packages; recheck the wrapper when upgrading the CLI.

```sh
npm ci
npm run native:ios       # once; creates ios/
npm run native:sync
npm run native:configure
npx cap open ios
```

In the App target, enable **HealthKit** and **Background Delivery** under Signing & Capabilities. The configure script selects `App/PathPulse.entitlements` for Debug and Release; select your signing team and verify that both `com.apple.developer.healthkit` and `com.apple.developer.healthkit.background-delivery` are true. The configure script writes this file, privacy strings, and `PathPulseHealthManager.shared.restoreObservers()` in `AppDelegate.didFinishLaunchingWithOptions`. Confirm that hook remains before returning from launch; background HealthKit wake-up requires reinstating queries during launch, not just after a WebView loads. `NSHealthShareUsageDescription`, motion, and both native location usage-description keys are installed (the app requests foreground location only); the plugin never requests health write access.

The bridge requests walking asymmetry, speed, step length and step count. Observers execute anchored queries, persist anchors and at most 500 pending samples **on device**, and always call their completion handler after collection. Background delivery frequency `.immediate` is a request to iOS, not a real-time guarantee. `readSamples` drains that local queue into the foreground analyzer. Stop sharing stops observers and background delivery. HealthKit does not disclose whether read access was denied; a successful authorization request is labeled **requested**, not **granted**.

Asymmetry uses `.percent()` fractions (0.10 = 10%). The analyzer compares the current value with the median of at least five preceding readings: relative asymmetry increase >15% or speed drop >50% is a candidate. Short step records are converted to cadence (steps/second), and a confirmed stopped interval suppresses terrain drag. Step length is read and retained in the rolling local baseline for future combined gait validation; it does not alone trigger a report. Raw health values never enter the backend payload.

Apple's walking-asymmetry samples are often delayed and sparse (typically 10–30/day), and apply to supported walking measurements, not wheelchair gait. The analyzer requires an interval ≤60 seconds, sample end within the last 120 seconds, a captured GPS fix within ±5 seconds of that end, and accuracy ≤20 m. Delayed/long records can establish a baseline but **cannot be pinned to today's location**. A background query may queue a sample while JavaScript sleeps; a live network upload is not promised in that state. Real-time impacts use foreground raw motion instead.

## Android 14+

Requires Android Studio, JDK 17 or newer, Android SDK 36, and a physical/emulated Android 14+ environment with Health Connect enabled and records supplied by a compatible source app/device.

```sh
npm run native:android   # once; creates android/
npm run native:sync
npm run native:configure # sets app minSdkVersion to 34
npx cap open android
```

The plugin uses stable `androidx.health.connect:connect-client:1.1.0`, read-only StepsRecord/SpeedRecord permissions, a permission-result callback, paginated reads, and the required rationale/privacy activity intents. Check the merged manifest for `READ_STEPS`, `READ_SPEED`, and the rationale aliases. The shared analyzer calculates rolling speed drag with stopped-cadence suppression. Reads occur every 30 seconds while sharing in the foreground. This build does not request Android background health-read permission or claim continuous background access.

## Pair and validate

Set the build-time PUBLIC_* URLs to your production hosts and include `capacitor://localhost` and `https://localhost` in backend CORS. Rebuild/sync after changing URLs. The native shell starts at the bundled `/mobile.html` asset. Native location uses `@capacitor/geolocation`, not an assumption that a WebView exposes browser GPS. Use the observer's QR in Safari/Chrome for browser mode; to use native health, copy its **complete pairing link** into the native app's **Paste a pairing link** field and tap Start Sensors. An HTTPS backend is required on the physical phone; `127.0.0.1` points to the phone itself, not your development computer. `npm run sync:local` generates the tunnel link.

Validate permission denial/revocation, empty health stores, a fresh speed change with contemporaneous GPS, a delayed record with no matching fix, app background/foreground, stop sharing, and real hardware motion before relying on detections. The generated iOS SPM and Android projects have both been synced with the local plugin. The current workstation has command-line Swift but no full Xcode or Android SDK, but both platform SDK builds have passed on GitHub Actions: an unsigned iOS simulator app and a signed Android debug APK. Physical-device motion, health permissions/background delivery, and gait measurements remain unverified. iOS installation on a physical phone still requires your Apple signing team.

References: [Capacitor iOS plugins](https://capacitorjs.com/docs/v7/plugins/ios), [Capacitor Android plugins](https://capacitorjs.com/docs/v7/plugins/android), [HealthKit observer queries](https://developer.apple.com/documentation/healthkit/executing-observer-queries), [HealthKit asymmetry](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/walkingasymmetrypercentage), [Health Connect setup](https://developer.android.com/health-and-fitness/health-connect/get-started), [Health Connect releases](https://developer.android.com/jetpack/androidx/releases/health-connect).

## Native impact motion

The native shell uses Core Motion on iOS and SensorManager on Android at a requested 50 Hz, rather than WebView DeviceMotionEvent. iOS converts gravity plus user acceleration from g to m/s² and angular velocity from rad/s to deg/s. Android pairs accelerometer samples with gyroscope data no more than 40 ms old. Missing or stale rotation fails closed. Both platforms release sensors when backgrounded and resume only while sharing is requested. Stop sharing unregisters native sensors and JavaScript listeners; a late asynchronous startup cannot restart sharing. The shared SensorPipeline applies exactly the browser tumble, jerk, pulse-width, warm-up, gap and cooldown gates. Only accepted impact evidence is uploaded with source `native_motion`; raw streams stay on device. HealthKit and Health Connect remain complementary sources of terrain-drag evidence.

To build against the deployed domain, run:

```sh
PUBLIC_API_URL=https://www.clearpath.wiki PUBLIC_WS_URL=wss://www.clearpath.wiki/ws/stream PUBLIC_MOBILE_URL=https://www.clearpath.wiki/mobile npm run native:sync
npm run native:configure
```
