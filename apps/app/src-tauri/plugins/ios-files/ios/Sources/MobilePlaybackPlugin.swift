import AVFoundation
import Foundation
import MediaPlayer
import Tauri
import UIKit

private struct AttachArgs: Decodable { let channel: Channel }
private struct EngineArgs {
    let kind: String
    let generation: UInt64
    let payload: Any?

    init(_ invoke: Invoke) throws {
        guard let values = try JSONSerialization.jsonObject(with: Data(invoke.getRawArgs().utf8)) as? [String: Any],
              let kind = values["kind"] as? String, let generation = values["generation"] as? UInt64 else {
            throw CocoaError(.coderReadCorrupt)
        }
        self.kind = kind
        self.generation = generation
        self.payload = values["payload"]
    }
}

final class MobilePlaybackPlugin: Plugin {
    private let player = AVPlayer()
    private let session = AVAudioSession.sharedInstance()
    private let remote = MPRemoteCommandCenter.shared()
    private var channel: Channel?
    private var generation: UInt64 = 0
    private var current: AVPlayerItem?
    private var itemStatus: NSKeyValueObservation?
    private var timeStatus: NSKeyValueObservation?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var failureObserver: NSObjectProtocol?
    private var systemObservers: [NSObjectProtocol] = []
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var info: [String: Any] = [:]
    private var interruptionState = PlaybackInterruption()
    private var wantsPlay = false
    private var hasSession = false
    private var canPrevious = false
    private var canNext = false

    @objc func attach(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(AttachArgs.self)
            DispatchQueue.main.async {
                self.channel = args.channel
                self.installControls()
                invoke.resolve()
            }
        } catch {
            invoke.reject("无法注册原生播放事件")
        }
    }

    @objc func engine(_ invoke: Invoke) {
        do {
            let args = try EngineArgs(invoke)
            DispatchQueue.main.async {
                do {
                    try self.handle(args)
                    invoke.resolve()
                } catch {
                    invoke.reject("无法控制 iOS 播放器")
                }
            }
        } catch {
            invoke.reject("播放参数无效")
        }
    }

    private func handle(_ args: EngineArgs) throws {
        let payload = args.payload
        switch args.kind {
        case "begin":
            clearItem()
            generation = args.generation
            hasSession = true
            let values = (payload as? [String: Any]) ?? [:]
            wantsPlay = (values["autoplay"] as? Bool) ?? true
            interruptionState.updateIntent(wantsPlay: wantsPlay)
            info = [
                MPMediaItemPropertyTitle: (values["title"] as? String) ?? "",
                MPMediaItemPropertyArtist: (values["artist"] as? String) ?? "",
                MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue
            ]
            if let duration = (values["duration"] as? Double), duration > 0 {
                info[MPMediaItemPropertyPlaybackDuration] = duration
            }
            setControls((values["controls"] as? [String: Any]) ?? [:])
            updateNowPlaying()
            beginBackgroundTask()
        case "stop", "fail":
            generation = args.generation
            clearItem()
            endBackgroundTask()
            wantsPlay = false
            interruptionState.updateIntent(wantsPlay: false)
            if args.kind == "stop" {
                hasSession = false
                info = [:]
            } else {
                info.removeValue(forKey: MPMediaItemPropertyArtwork)
            }
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            updateCommands()
            updateNowPlaying()
        default:
            guard hasSession, args.generation == generation else { return }
            switch args.kind {
            case "load":
                let values = (payload as? [String: Any]) ?? [:]
                guard let path = (values["path"] as? String) else { throw PlaybackError.invalidFile }
                player.volume = Float((values["volume"] as? Double) ?? 1)
                let url = URL(fileURLWithPath: path)
                try? FileManager.default.setAttributes(
                    [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path
                )
                let item = AVPlayerItem(url: url)
                current = item
                player.replaceCurrentItem(with: item)
                observe(item)
                if let position = values["position"] as? Double, position > 0 {
                    player.seek(to: CMTime(seconds: position, preferredTimescale: 600))
                }
                if (values["autoplay"] as? Bool) == true {
                    if !interruptionState.isActive { try resume() }
                } else {
                    wantsPlay = false
                    endBackgroundTask()
                    reportStatus()
                }
                updateCommands()
            case "pause":
                wantsPlay = false
                interruptionState.updateIntent(wantsPlay: false)
                player.pause()
                reportStatus()
            case "resume":
                wantsPlay = true
                interruptionState.updateIntent(wantsPlay: true)
                if current != nil && !interruptionState.isActive { try resume() }
            case "seek":
                if let position = payload as? Double { seek(position) }
            case "volume":
                if let volume = payload as? Double { player.volume = Float(volume) }
            case "controls":
                setControls((payload as? [String: Any]) ?? [:])
            case "metadata":
                let values = (payload as? [String: Any]) ?? [:]
                info[MPMediaItemPropertyTitle] = values["title"] as? String
                info[MPMediaItemPropertyArtist] = values["artist"] as? String
                updateNowPlaying()
            case "artwork":
                guard let path = payload as? String, let image = UIImage(contentsOfFile: path) else {
                    emit("artworkError")
                    return
                }
                info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                updateNowPlaying()
            default: break
            }
        }
    }

    private enum PlaybackError: Error { case invalidFile }

    private func emit(_ kind: String) {
        channel?.send(["kind": kind, "generation": generation] as JsonObject)
    }

    private func observe(_ item: AVPlayerItem) {
        let version = generation
        let center = NotificationCenter.default
        endObserver = center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            guard let self = self, self.generation == version else { return }
            self.beginBackgroundTask()
            self.emit("ended")
        }
        failureObserver = center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            guard let self = self, self.generation == version else { return }
            self.emit("error")
        }
        itemStatus = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self = self, self.generation == version else { return }
                if item.status == .failed { self.emit("error") }
                else { self.updateCommands(); self.reportStatus() }
            }
        }
        timeStatus = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                guard let self = self, self.generation == version else { return }
                self.reportStatus()
            }
        }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] _ in
            guard let self = self, self.generation == version else { return }
            self.reportStatus(updateInfo: false)
        }
    }

    private func clearItem() {
        itemStatus = nil
        timeStatus = nil
        if let observer = timeObserver { player.removeTimeObserver(observer) }
        if let observer = endObserver { NotificationCenter.default.removeObserver(observer) }
        if let observer = failureObserver { NotificationCenter.default.removeObserver(observer) }
        timeObserver = nil
        endObserver = nil
        failureObserver = nil
        current = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
    }

    private func resume() throws {
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
        wantsPlay = true
        player.play()
    }

    private func seek(_ position: Double) {
        guard let item = current, item.status == .readyToPlay else { return }
        let duration = item.duration.seconds
        let target = max(0, duration.isFinite ? min(position, duration) : position)
        let version = generation
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, self.generation == version else { return }
                self.reportStatus()
            }
        }
    }

    private func reportStatus(updateInfo: Bool = true) {
        guard let item = current, item.status != .failed else { return }
        let playing = player.timeControlStatus == .playing
        let buffering = wantsPlay && !interruptionState.isActive && !playing
        if playing || (!wantsPlay && item.status == .readyToPlay) { endBackgroundTask() }
        let position = player.currentTime().seconds
        let duration = item.duration.seconds
        channel?.send([
            "kind": "status",
            "generation": generation,
            "state": playing ? "playing" : "paused",
            "currentTime": position.isFinite ? position : 0,
            "duration": duration.isFinite ? (duration as Any) : NSNull(),
            "buffering": buffering,
            "ready": item.status == .readyToPlay
        ] as JsonObject)
        if updateInfo { updateNowPlaying() }
    }

    private func updateNowPlaying() {
        guard hasSession else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        let elapsed = player.currentTime().seconds
        let duration = current?.duration.seconds ?? .nan
        if duration.isFinite { info[MPMediaItemPropertyPlaybackDuration] = duration }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed.isFinite ? elapsed : 0
        info[MPNowPlayingInfoPropertyPlaybackRate] = player.timeControlStatus == .playing ? 1 : 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func beginBackgroundTask() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Prepare audio") { [weak self] in
            self?.emit("error")
            self?.endBackgroundTask()
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    private func setControls(_ values: [String: Any]) {
        canPrevious = (values["previous"] as? Bool) ?? false
        canNext = (values["next"] as? Bool) ?? false
        updateCommands()
    }

    private func updateCommands() {
        remote.playCommand.isEnabled = hasSession
        remote.pauseCommand.isEnabled = hasSession
        remote.togglePlayPauseCommand.isEnabled = hasSession
        remote.previousTrackCommand.isEnabled = hasSession && canPrevious
        remote.nextTrackCommand.isEnabled = hasSession && canNext
        remote.changePlaybackPositionCommand.isEnabled = current?.status == .readyToPlay
    }

    private func add(_ command: MPRemoteCommand, action: @escaping (MobilePlaybackPlugin, MPRemoteCommandEvent) -> Void) {
        let target = command.addTarget { [weak self] event in
            guard self != nil else { return .commandFailed }
            DispatchQueue.main.async {
                guard let self = self, self.hasSession else { return }
                action(self, event)
            }
            return .success
        }
        remoteTargets.append((command, target))
    }

    private func installControls() {
        guard remoteTargets.isEmpty else { return }
        add(remote.playCommand) { player, _ in player.emit("resume") }
        add(remote.pauseCommand) { player, _ in player.emit("pause") }
        add(remote.togglePlayPauseCommand) { player, _ in player.emit(player.wantsPlay ? "pause" : "resume") }
        add(remote.previousTrackCommand) { player, _ in player.emit("previous") }
        add(remote.nextTrackCommand) { player, _ in player.emit("next") }
        add(remote.changePlaybackPositionCommand) { player, event in
            if let event = event as? MPChangePlaybackPositionCommandEvent { player.seek(event.positionTime) }
        }
        updateCommands()
        let center = NotificationCenter.default
        systemObservers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            self?.interruption(note)
        })
        systemObservers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] note in
            if let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
               reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                self?.emit("pause")
            }
        })
    }

    private func interruption(_ note: Notification) {
        guard let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt else { return }
        if type == AVAudioSession.InterruptionType.began.rawValue {
            interruptionState.began(wantsPlay: wantsPlay)
            player.pause()
            reportStatus()
        } else if type == AVAudioSession.InterruptionType.ended.rawValue {
            let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let resume = interruptionState.ended(
                systemAllowsResume: AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
            )
            if hasSession { emit(resume ? "resumeAfterInterruption" : "pause") }
        }
    }

    deinit {
        for (command, target) in remoteTargets { command.removeTarget(target) }
        for observer in systemObservers { NotificationCenter.default.removeObserver(observer) }
        clearItem()
        endBackgroundTask()
    }
}

@_cdecl("init_plugin_mobile_playback")
func initMobilePlayback() -> Plugin {
    MobilePlaybackPlugin()
}
