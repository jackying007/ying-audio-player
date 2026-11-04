// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-ios-files",
    platforms: [.iOS("16.4")],
    products: [.library(name: "tauri-plugin-ios-files", type: .static, targets: ["IosFiles"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "IosFiles", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
