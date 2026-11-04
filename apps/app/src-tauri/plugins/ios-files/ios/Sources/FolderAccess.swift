import Foundation

enum FolderError: LocalizedError {
    case unauthorized, invalidFile

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "文件夹授权已失效，请重新导入原文件夹"
        case .invalidFile: return "无法读取所选文件"
        }
    }
}

struct FolderAccess {
    struct Grant: Codable {
        let bookmark: Data
        let lastPath: String
    }

    struct Document: Encodable {
        let uri: String
        let name: String
        let size: Int?
        let lyricsUri: String?
    }

    struct Directory: Encodable {
        let name: String
        let files: [Document]
    }

    let grantsURL: URL
    let temporaryDirectory: URL
    var startAccess: (URL) -> Bool = { $0.startAccessingSecurityScopedResource() }
    var stopAccess: (URL) -> Void = { $0.stopAccessingSecurityScopedResource() }

    private let fileManager = FileManager.default

    private func grants() throws -> [UUID: Grant] {
        do {
            return try JSONDecoder().decode([UUID: Grant].self, from: Data(contentsOf: grantsURL))
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return [:]
        }
    }

    private func save(_ grants: [UUID: Grant]) throws {
        try fileManager.createDirectory(at: grantsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(grants).write(to: grantsURL, options: .atomic)
    }

    private func resolve(_ grant: Grant) throws -> (url: URL, stale: Bool) {
        var stale = false
        let url = try URL(resolvingBookmarkData: grant.bookmark, options: [.withoutUI], relativeTo: nil,
                          bookmarkDataIsStale: &stale)
        return (url, stale)
    }

    private func grant(for url: URL) throws -> Grant {
        Grant(bookmark: try url.bookmarkData(options: .minimalBookmark),
              lastPath: url.standardizedFileURL.path)
    }

    func remember(_ url: URL) throws -> String {
        guard startAccess(url) else { throw FolderError.unauthorized }
        defer { stopAccess(url) }
        var records = try grants()
        let newGrant = try grant(for: url)
        let id = records.first { _, old in
            let path = (try? resolve(old).url.standardizedFileURL.path) ?? old.lastPath
            return path == newGrant.lastPath
        }?.key ?? UUID()
        records[id] = newGrant
        try save(records)
        return id.uuidString
    }

    func release(_ uri: String) throws {
        guard let id = UUID(uuidString: uri) else { return }
        var records = try grants()
        if records.removeValue(forKey: id) != nil { try save(records) }
    }

    private func withFolder<T>(_ uri: String, _ operation: (URL) throws -> T) throws -> T {
        var records = try grants()
        guard let id = UUID(uuidString: uri), let old = records[id],
              let (url, stale) = try? resolve(old), startAccess(url) else {
            throw FolderError.unauthorized
        }
        defer { stopAccess(url) }
        if stale || url.standardizedFileURL.path != old.lastPath {
            records[id] = try grant(for: url)
            try save(records)
        }
        do {
            return try operation(url)
        } catch let error as CocoaError where error.code == .fileReadNoPermission {
            throw FolderError.unauthorized
        }
    }

    private func coordinate<T>(_ url: URL, _ read: (URL) throws -> T) throws -> T {
        var coordinationError: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinationError) {
            coordinatedURL in result = Result { try read(coordinatedURL) }
        }
        if let coordinationError = coordinationError { throw coordinationError }
        guard let result = result else { throw FolderError.invalidFile }
        return try result.get()
    }

    private func fileToken(_ folder: String, _ name: String) -> String {
        "\(folder):\(Data(name.utf8).base64EncodedString())"
    }

    func list(_ folder: String) throws -> Directory {
        try withFolder(folder) { url in
            try coordinate(url) { directory in
                let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
                let entries = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: Array(keys))
                var audio: [(URL, Int?)] = []
                var lyrics: [String: String] = [:]
                for entry in entries {
                    let ext = entry.pathExtension.lowercased()
                    guard ext == "mp3" || ext == "lrc" else { continue }
                    let values = try entry.resourceValues(forKeys: keys)
                    guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
                    if ext == "mp3" {
                        audio.append((entry, values.fileSize))
                    } else {
                        let stem = entry.deletingPathExtension().lastPathComponent
                        let name = entry.lastPathComponent
                        lyrics[stem] = min(lyrics[stem] ?? name, name)
                    }
                }
                return Directory(name: directory.lastPathComponent, files: audio.map { entry, size in
                    let name = entry.lastPathComponent
                    let stem = entry.deletingPathExtension().lastPathComponent
                    return Document(uri: fileToken(folder, name), name: name, size: size,
                                    lyricsUri: lyrics[stem].map { fileToken(folder, $0) })
                })
            }
        }
    }

    func materialize(_ uri: String) throws -> URL {
        let parts = uri.split(separator: ":", maxSplits: 1)
        guard parts.count == 2, let bytes = Data(base64Encoded: String(parts[1])),
              let name = String(data: bytes, encoding: .utf8), !name.isEmpty, name != ".", name != "..",
              !name.contains("/"), !name.contains("\0") else { throw FolderError.invalidFile }
        return try withFolder(String(parts[0])) { directory in
            let file = directory.appendingPathComponent(name, isDirectory: false)
            let ext = file.pathExtension.lowercased()
            guard ext == "mp3" || ext == "lrc" else { throw FolderError.invalidFile }
            return try coordinate(file) { source in
                let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard values.isRegularFile == true, values.isSymbolicLink != true else { throw FolderError.invalidFile }
                try fileManager.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
                let copy = temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
                do {
                    try fileManager.copyItem(at: source, to: copy)
                    return copy
                } catch {
                    try? fileManager.removeItem(at: copy)
                    throw error
                }
            }
        }
    }
}
