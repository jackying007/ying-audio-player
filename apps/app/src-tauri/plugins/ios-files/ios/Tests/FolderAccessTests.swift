import Foundation

// Compile with FolderAccess.swift on macOS to test the bookmark store without UIKit.
@main
struct FolderAccessTests {
    static func main() throws {
        let manager = FileManager.default
        let root = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? manager.removeItem(at: root) }
        let music = root.appendingPathComponent("音乐", isDirectory: true)
        let nested = music.appendingPathComponent("嵌套", isDirectory: true)
        try manager.createDirectory(at: nested, withIntermediateDirectories: true)
        let song = music.appendingPathComponent("我的歌.MP3")
        let bytes = Data([1, 2, 3])
        try bytes.write(to: song)
        try Data("歌词".utf8).write(to: music.appendingPathComponent("我的歌.LRC"))
        try bytes.write(to: nested.appendingPathComponent("不递归.mp3"))
        try manager.createSymbolicLink(at: music.appendingPathComponent("跳过.mp3"), withDestinationURL: song)

        let grants = root.appendingPathComponent("grants.json")
        let staging = root.appendingPathComponent("staging")
        let initial = FolderAccess(grantsURL: grants, temporaryDirectory: staging,
                                   startAccess: { _ in true }, stopAccess: { _ in })
        let id = try initial.remember(music)
        var reopened = FolderAccess(grantsURL: grants, temporaryDirectory: staging,
                                    startAccess: { _ in true }, stopAccess: { _ in })
        let directory = try reopened.list(id)
        precondition(directory.name == "音乐")
        precondition(directory.files.map(\.name) == ["我的歌.MP3"])
        let file = directory.files[0]
        let copy = try reopened.materialize(file.uri)
        let copyBytes = try Data(contentsOf: copy)
        precondition(copyBytes == bytes && copy != song)
        try manager.removeItem(at: copy)
        let lyrics = try reopened.materialize(file.lyricsUri!)
        let lyricsText = try String(contentsOf: lyrics, encoding: .utf8)
        precondition(lyricsText == "歌词")

        reopened.startAccess = { _ in false }
        do {
            _ = try reopened.list(id)
            preconditionFailure("Revoked access must not publish an empty scan")
        } catch FolderError.unauthorized {}

        reopened.startAccess = { _ in true }
        let reauthorized = try reopened.remember(music)
        precondition(reauthorized == id)
        let refreshed = try reopened.list(id)
        precondition(refreshed.files[0].uri == file.uri)

        try reopened.release(id)
        do {
            _ = try reopened.list(id)
            preconditionFailure("Removed grants must not resolve")
        } catch FolderError.unauthorized {}
        precondition(manager.fileExists(atPath: song.path))
    }
}
