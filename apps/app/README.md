# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## android

### 模拟器

```bash
bun android:dev
```

### 真机

```bash
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
adb -d reverse tcp:1420 tcp:1420
adb -d reverse tcp:1421 tcp:1421
adb -d reverse tcp:8787 tcp:8787
bun android:dev
```

服务端地址需使用 localhost

### 打包

准备签名密钥库

```bash
keytool -genkeypair \
  -keystore "$HOME/.android/ying-audio-player.jks" \
  -storetype JKS \
  -alias ying-audio-player \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Ying Audio Player"
```

新建 `src-tauri/gen/android/keystore.properties` 填入

```
storeFile=keystore文件的真实地址
storePassword=密码
keyAlias=ying-audio-player
keyPassword=密码
```

## iOS

### 模拟器

指定模拟器名称。连接 iPhone 时，省略设备名称会优先选择真机。

```bash
bun ios:dev "iPhone Air"
```

如果启动失败，试试以下命令手动启动模拟器，再执行上面的命令

```bash
open -a "$(xcode-select -p)/Applications/Simulator.app"
```

打开本地模拟器应用内部目录

```bash
open "$(xcrun simctl get_app_container booted ying.audio.player data)/Library/Application Support/YingAudioPlayer"
```

### 真机

#### 第一次运行

连接并信任 iPhone 后，运行

```bash
bun ios:dev --open --host
```

在 Xcode 选择已连接的 iPhone，再按 `⌘R`，第一次运行会失败，打开错误，提示 `Signing for "ying-audio-player_iOS" requires a development team.`，选择 Team，选择你的 Personal Team， 这时候 `project.pbxproj` 会自动生成 `DEVELOPMENT_TEAM`，再按 `⌘R`。

#### 后续运行

有了这个就可以直接运行启动，不需要打开 Xcode 了

```bash
bun ios:dev
```

会默认选择真机
