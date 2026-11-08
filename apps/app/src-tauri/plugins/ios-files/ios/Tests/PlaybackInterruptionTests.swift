@main
struct PlaybackInterruptionTests {
    static func main() {
        var interruption = PlaybackInterruption()
        interruption.began(wantsPlay: true)
        precondition(interruption.isActive)
        precondition(interruption.ended(systemAllowsResume: true))
        precondition(!interruption.isActive)

        interruption.began(wantsPlay: true)
        interruption.updateIntent(wantsPlay: false)
        precondition(!interruption.ended(systemAllowsResume: true))

        interruption.began(wantsPlay: true)
        precondition(!interruption.ended(systemAllowsResume: false))

        interruption.began(wantsPlay: false)
        interruption.updateIntent(wantsPlay: true)
        precondition(interruption.ended(systemAllowsResume: true))
    }
}
