struct PlaybackInterruption {
    private(set) var isActive = false
    private var resumeRequested = false

    mutating func began(wantsPlay: Bool) {
        isActive = true
        resumeRequested = wantsPlay
    }

    mutating func updateIntent(wantsPlay: Bool) {
        if isActive { resumeRequested = wantsPlay }
    }

    mutating func ended(systemAllowsResume: Bool) -> Bool {
        let resume = isActive && resumeRequested && systemAllowsResume
        isActive = false
        resumeRequested = false
        return resume
    }
}
