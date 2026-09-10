// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FleetDriverCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "FleetDriverCore", targets: ["FleetDriverCore"])],
    targets: [
        .target(name: "FleetDriverCore", path: "Sources/Core"),
        .testTarget(name: "FleetDriverCoreTests", dependencies: ["FleetDriverCore"], path: "Tests")
    ]
)
