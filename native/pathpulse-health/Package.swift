// swift-tools-version: 5.9
import PackageDescription
// Capacitor derives the product name from the npm package as "PathpulseHealth".
// Keep the Swift module/target PathPulseHealth for AppDelegate imports.
let package = Package(name: "PathpulseHealth", platforms: [.iOS(.v14)], products: [.library(name: "PathpulseHealth", targets: ["PathPulseHealth"])], dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "7.0.0")], targets: [.target(name: "PathPulseHealth", dependencies: [.product(name: "Capacitor", package: "capacitor-swift-pm")], path: "ios/Sources")])
