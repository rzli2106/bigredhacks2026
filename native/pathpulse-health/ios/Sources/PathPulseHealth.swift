import Foundation
import Capacitor
import HealthKit
import CoreMotion
import UIKit

/// Reinstall observers during AppDelegate launch to receive HealthKit background wakes.
@objc public final class PathPulseHealthManager: NSObject {
    public static let shared = PathPulseHealthManager()
    private let store = HKHealthStore()
    private let lock = NSLock()
    private var observers: [HKObserverQuery] = []
    private let identifiers: [HKQuantityTypeIdentifier] = [.walkingAsymmetryPercentage, .walkingSpeed, .walkingStepLength, .stepCount]
    private let names = ["asymmetry", "speed", "step_length", "steps"]
    private let enabledKey = "PathPulse.health.enabled"
    private let queueKey = "PathPulse.health.queue"
    public var available: Bool { HKHealthStore.isHealthDataAvailable() }
    public func restoreObservers() { if UserDefaults.standard.bool(forKey: enabledKey) { start() } }
    public func request(_ completion: @escaping (Error?) -> Void) {
        let types = Set(identifiers.compactMap { HKQuantityType.quantityType(forIdentifier: $0) })
        store.requestAuthorization(toShare: [], read: types) { success, error in
            completion(error ?? (success ? nil : NSError(domain: "PathPulse", code: 1, userInfo: [NSLocalizedDescriptionKey: "Health authorization could not be requested."])))
        }
    }
    public func start() {
        guard available else { return }
        lock.lock()
        guard observers.isEmpty else { lock.unlock(); return }
        UserDefaults.standard.set(true, forKey: enabledKey)
        for (index, identifier) in identifiers.enumerated() {
            guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { continue }
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
                guard error == nil, let self = self else { completion(); return }
                self.collect(type: type, index: index, completion: completion)
            }
            observers.append(query)
        }
        let queries = observers
        lock.unlock()
        for query in queries { store.execute(query) }
        for (index, identifier) in identifiers.enumerated() {
            guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { continue }
            store.enableBackgroundDelivery(for: type, frequency: .immediate) { _, _ in }
            collect(type: type, index: index, completion: {})
        }
    }
    public func stop() {
        lock.lock(); let queries = observers; observers.removeAll(); UserDefaults.standard.set(false, forKey: enabledKey); lock.unlock()
        for query in queries { store.stop(query) }
        for identifier in identifiers {
            if let type = HKQuantityType.quantityType(forIdentifier: identifier) { store.disableBackgroundDelivery(for: type) { _, _ in } }
        }
    }
    private func collect(type: HKQuantityType, index: Int, completion: @escaping () -> Void) {
        let anchorKey = "PathPulse.anchor.\(names[index])"
        let saved = UserDefaults.standard.data(forKey: anchorKey)
        let anchor = saved.flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0) }
        let predicate = HKQuery.predicateForSamples(withStart: Date().addingTimeInterval(-86400), end: nil, options: [])
        let query = HKAnchoredObjectQuery(type: type, predicate: predicate, anchor: anchor, limit: HKObjectQueryNoLimit) { [weak self] _, samples, deleted, next, error in
            defer { completion() }
            guard error == nil, let self = self else { return }
            let unit: HKUnit = index == 0 ? .percent() : index == 1 ? HKUnit.meter().unitDivided(by: .second()) : index == 2 ? .meter() : .count()
            self.lock.lock(); defer { self.lock.unlock() }
            guard UserDefaults.standard.bool(forKey: self.enabledKey) else { return }
            var queue = UserDefaults.standard.array(forKey: self.queueKey) as? [[String: Any]] ?? []
            let deletedIDs = Set((deleted ?? []).map { $0.uuid.uuidString })
            queue.removeAll { deletedIDs.contains($0["id"] as? String ?? "") }
            var ids = Set(queue.compactMap { $0["id"] as? String })
            for sample in (samples ?? []).compactMap({ $0 as? HKQuantitySample }) where !ids.contains(sample.uuid.uuidString) {
                ids.insert(sample.uuid.uuidString)
                queue.append(["id": sample.uuid.uuidString, "metric": self.names[index], "value": sample.quantity.doubleValue(for: unit), "start": sample.startDate.timeIntervalSince1970, "end": sample.endDate.timeIntervalSince1970, "source": "healthkit"])
            }
            UserDefaults.standard.set(Array(queue.suffix(500)), forKey: self.queueKey)
            if let next = next, let data = try? NSKeyedArchiver.archivedData(withRootObject: next, requiringSecureCoding: true) { UserDefaults.standard.set(data, forKey: anchorKey) }
        }
        store.execute(query)
    }
    public func drain() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        let samples = UserDefaults.standard.array(forKey: queueKey) as? [[String: Any]] ?? []
        UserDefaults.standard.removeObject(forKey: queueKey)
        return samples
    }
}
@objc(PathPulseHealthPlugin)
public class PathPulseHealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PathPulseHealthPlugin"
    public let jsName = "PathPulseHealth"
    public let pluginMethods: [CAPPluginMethod] = ["availability", "requestPermissions", "startMonitoring", "stopMonitoring", "readSamples", "startMotion", "stopMotion"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private let motion = CMMotionManager()
    private var motionRequested = false
    private var lifecycleObservers: [NSObjectProtocol] = []
    public override func load() {
        PathPulseHealthManager.shared.restoreObservers()
        lifecycleObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.motion.stopDeviceMotionUpdates() })
        lifecycleObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self, self.motionRequested else { return }; self.beginMotion()
        })
    }
    deinit { motion.stopDeviceMotionUpdates(); for observer in lifecycleObservers { NotificationCenter.default.removeObserver(observer) } }
    private func beginMotion() {
        guard !motion.isDeviceMotionActive else { return }
        motion.deviceMotionUpdateInterval = 0.02
        motion.startDeviceMotionUpdates(to: .main) { [weak self] sample, error in
            guard let self = self, self.motionRequested else { return }
            guard error == nil, let sample = sample else {
                self.notifyListeners("motionSample", data: ["timestamp": ProcessInfo.processInfo.systemUptime * 1000]); return
            }
            // Core Motion acceleration is in g; rotation is rad/s. The shared gate expects m/s² and deg/s.
            let gravity = sample.gravity, acceleration = sample.userAcceleration, rotation = sample.rotationRate
            let degrees = 180.0 / Double.pi
            self.notifyListeners("motionSample", data: ["timestamp": sample.timestamp * 1000,
                "accelerationIncludingGravity": ["x": (gravity.x + acceleration.x) * 9.80665, "y": (gravity.y + acceleration.y) * 9.80665, "z": (gravity.z + acceleration.z) * 9.80665],
                "rotationRate": ["alpha": rotation.z * degrees, "beta": rotation.x * degrees, "gamma": rotation.y * degrees]])
        }
    }
    @objc func startMotion(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.motion.isDeviceMotionAvailable else { call.reject("Accelerometer and gyroscope are unavailable on this device."); return }
            self.motionRequested = true
            if UIApplication.shared.applicationState != .background { self.beginMotion() }
            call.resolve()
        }
    }
    @objc func stopMotion(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.motionRequested = false; self.motion.stopDeviceMotionUpdates(); call.resolve() }
    }
    @objc func availability(_ call: CAPPluginCall) { call.resolve(["available": PathPulseHealthManager.shared.available]) }
    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        guard PathPulseHealthManager.shared.available else { call.reject("HealthKit is unavailable."); return }
        PathPulseHealthManager.shared.request { error in
            if let error = error { call.reject(error.localizedDescription) } else { call.resolve(["requested": true, "readAccess": "not-disclosed-by-healthkit"]) }
        }
    }
    @objc func startMonitoring(_ call: CAPPluginCall) { PathPulseHealthManager.shared.start(); call.resolve() }
    @objc func stopMonitoring(_ call: CAPPluginCall) { PathPulseHealthManager.shared.stop(); call.resolve() }
    @objc func readSamples(_ call: CAPPluginCall) { call.resolve(["samples": PathPulseHealthManager.shared.drain()]) }
}
