// swift-tools-version: 5.9
import PackageDescription
// Capacitor derives the product name from the npm package as "ClearpathHealth".
// Keep the Swift module/target ClearPathHealth for AppDelegate imports.
let package = Package(name: "ClearpathHealth", platforms: [.iOS(.v14)], products: [.library(name: "ClearpathHealth", targets: ["ClearPathHealth"])], dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "7.0.0")], targets: [.target(name: "ClearPathHealth", dependencies: [.product(name: "Capacitor", package: "capacitor-swift-pm")], path: "ios/Sources")])
