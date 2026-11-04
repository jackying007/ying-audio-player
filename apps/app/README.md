# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## iOS 本地启动

```bash
open -a "$(xcode-select -p)/Applications/Simulator.app"
bun ios:dev
```

打开本地模拟器应用内部目录

```bash
open "$(xcrun simctl get_app_container booted ying.audio.player data)/Library/Application Support/YingAudioPlayer"
```
