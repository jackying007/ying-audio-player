import Foundation
import Tauri
import UIKit
import UniformTypeIdentifiers

private struct UriArgs: Decodable { let uri: String }
private struct PathResult: Encodable { let path: String }
private struct Selection: Encodable { let uri: String? }

final class IosFilesPlugin: Plugin, UIDocumentPickerDelegate {
    private let queue = DispatchQueue(label: "ying.audio.player.ios-files", qos: .userInitiated)
    private var selection: Invoke?

    // Remove staging files left by an interrupted read when first used after launch.
    private lazy var staging: URL = {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ios-files", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
        return root
    }()

    private func storageRoot() throws -> URL {
        let manager = FileManager.default
        return try manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                               appropriateFor: nil, create: true)
            .appendingPathComponent("YingAudioPlayer", isDirectory: true)
    }

    private func access() throws -> FolderAccess {
        FolderAccess(grantsURL: try storageRoot().appendingPathComponent("folder-bookmarks.json"),
                     temporaryDirectory: staging)
    }

    @objc func storageRoot(_ invoke: Invoke) {
        queue.async {
            do {
                let root = try self.storageRoot()
                for name in ["network", ".network-cache"] {
                    var url = root.appendingPathComponent(name, isDirectory: true)
                    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                    var values = URLResourceValues()
                    values.isExcludedFromBackup = true
                    try url.setResourceValues(values)
                }
                invoke.resolve(PathResult(path: root.path))
            } catch {
                invoke.reject(error.localizedDescription)
            }
        }
    }

    @objc func pickFolder(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard self.selection == nil, let presenter = self.manager.viewController,
                  presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
                invoke.reject("暂时无法打开目录选择器")
                return
            }
            self.selection = invoke
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            picker.modalPresentationStyle = .fullScreen
            presenter.present(picker, animated: true)
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finishSelection(nil)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finishSelection(urls.first)
    }

    private func finishSelection(_ url: URL?) {
        guard let invoke = selection else { return }
        selection = nil
        guard let url = url else {
            invoke.resolve(Selection(uri: nil))
            return
        }
        queue.async {
            do {
                invoke.resolve(Selection(uri: try self.access().remember(url)))
            } catch {
                invoke.reject(error.localizedDescription)
            }
        }
    }

    private func withUri<T: Encodable>(_ invoke: Invoke, _ operation: @escaping (FolderAccess, String) throws -> T) {
        queue.async {
            do {
                let args = try invoke.parseArgs(UriArgs.self)
                invoke.resolve(try operation(self.access(), args.uri))
            } catch {
                invoke.reject(error.localizedDescription)
            }
        }
    }

    @objc func list(_ invoke: Invoke) {
        withUri(invoke) { try $0.list($1) }
    }

    @objc func materialize(_ invoke: Invoke) {
        withUri(invoke) { PathResult(path: try $0.materialize($1).path) }
    }

    @objc func release(_ invoke: Invoke) {
        withUri(invoke) { access, uri in
            try access.release(uri)
            return [String: String]()
        }
    }
}

@_cdecl("init_plugin_ios_files")
func initIosFiles() -> Plugin {
    IosFilesPlugin()
}
