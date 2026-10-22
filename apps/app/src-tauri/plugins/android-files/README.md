# Android directory access

Internal Rust-to-Kotlin bridge for the app's local music index. It exposes no JavaScript commands; the app's `local-audio` IPC checks indexed song IDs before reading documents.

- `pickFolder` persists read access to a system-selected document tree and returns null on cancellation.
- `list` returns direct MP3 children, original display names, sizes and matching LRC document URIs.
- `materialize` copies one authorized document into a unique private temporary file. Kotlin deletes failed copies; Rust owns and deletes successful copies after reading or scanning.
- `release` releases read access after the indexed folder is removed.
- `storageRoot` resolves Android's own external app directory and returns its package root, so SQLite and network caches live directly under `Android/data/ying.audio.player/`. Unavailable or read-only external storage is an error; it never silently falls back to internal storage.

Run JVM tests through the generated app Gradle project: `gradlew.bat :tauri-plugin-android-files:testDebugUnitTest`. `AGENTS.md` at the repository root documents Android setup and commands.
