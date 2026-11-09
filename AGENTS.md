# 项目指引

## 项目与入口

Bun workspace + Turborepo，包含 Tauri 桌面/Android/iOS 播放器和 Cloudflare 音乐服务。本地播放独立可用；网络功能提供文件夹同步、增量上传和播放。功能与启动说明统一维护在本文件。

- `apps/app`：Tauri 2、React 19、TypeScript、Vite、TanStack Router、Zustand、Tailwind CSS 4、shadcn/Radix。
- 本地索引：`apps/app/src-tauri/src/local_audio.rs`；IPC：`src/lib/local-audio.ts`；文件夹与扫描：`src/store/app-store.ts`、`local-audio-store.ts`。
- 播放：`src/store/audio-store.ts`、`src/lib/playback-queue.ts`、`src/layout/audio-player`；共用歌曲列表：`src/routes/-shared/audio-list.tsx`。
- 网络：`src/lib/network-audio.ts`、`network-cache.ts`、`file-hash.ts`、`src/store/network-audio-store.ts`、`network-settings.ts`；磁盘缓存：`src-tauri/src/network_cache.rs`；页面：`src/routes/local`、`network`、`settings.tsx`。
- `apps/server`：Workers + Hono + Drizzle + D1 + 私有 R2。入口 `src/main.ts` 管理鉴权、CORS、中间件和定时任务；`src/business/index.ts` 定义接口，`metadata.ts` 校验元数据，`cleanup.ts` 清理文件。

## 组件放置约定

- 新增业务组件放在 `apps/app/src/routes` 下，与对应页面就近维护；页面专用组件放在对应路由的 `-` 前缀目录中，跨页面共用的业务组件放在 `src/routes/-shared`，避免被 TanStack Router 识别为路由。
- `apps/app/src/components` 仅放与业务无关的通用组件和 UI 基础组件，不放业务组件；歌曲列表 `audio-list`、歌曲封面 `audio-cover` 等属于业务组件。
- 业务界面优先复用 `apps/app/src/components/ui` 中已有的 UI 组件及其样式变体，例如按钮使用 `Button`；已有组件能满足需求时，不直接使用原生 HTML 元素手写同类控件及交互样式。缺少通用能力时先扩展 UI 基础组件，再由业务组件组合使用。

## App 端 API 编写约定

- 服务端 HTTP 请求统一使用 `@jying/http`，业务调用从 `@/api` 导入。当前网络接口全部集中在 `apps/app/src/api/business/network.ts`，统一导出 `networkApi`；新增网络接口继续放在此文件。Windows、macOS、Android 和 iOS 的原生播放是例外，Rust 下载音频、歌词和封面，校验服务端路径、鉴权和 hash，并拒绝重定向。歌曲列表和系统媒体面板共用封面缓存。
- 沿用现有工厂格式：业务文件默认导出接收 `HttpRequest` 的函数，返回接口方法对象；`api/index.ts` 通过动态导入加载工厂并注入 `http-client.ts` 的共享 `http` 实例。请求与响应类型统一放在 `api/types.ts`。
- 接口方法按行为命名，如 `listFolders`、`createFolder`、`createUpload`、`commitUpload`；媒体下载使用 `getAudio`、`getLyrics`、`getCover`。
- 业务方法使用相对 API 路径（如 `/folder/list`）；`http-client.ts` 统一从当前 App 设置读取服务端地址和密钥，拼接服务端地址及 `/api`，通过 `query.authToken` 传递原始密钥鉴权（不带 Bearer 前缀）。收到现有歌曲条目的完整媒体 URL 时，先通过 `mediaPath` 校验属于当前服务端并提取相对路径；共享请求钩子将 URL 已有查询参数合并到 `query`，保留 hash 参数并以当前设置覆盖 `authToken`。
- JSON 请求体使用库的 `data`，查询参数使用 `query`，二进制上传使用 `body`。媒体方法通过 `responseType` 直接返回音频 `ArrayBuffer`、歌词文本或封面 `Blob`，调用方直接使用解析后的数据。
- 服务端错误统一为文本；`afterError` 使用 `Response.text()` 读取错误消息，空内容使用带状态码的默认提示，构造保留 `status`、`statusText` 的 `HttpError`。业务按需检查 `HttpError.status`。
- `signal` 仅在调用方实际需要取消请求时添加并透传，如播放、封面加载和同步；`listFolders`、`listAudios` 保持无 `signal` 参数。连接级取消统一由 `http-client.ts` 维护，与调用方信号合并；地址或密钥变化时取消旧连接请求。
- Store 和组件负责业务编排、状态与缓存，接口路径、请求发送及响应解析集中在 API 层；新增或调整接口时同步更新调用处及相关网络测试，测试中的错误响应也使用文本。

## 安装与启动

根目录执行 `bun install`，使用 `package.json` 指定的 Bun 和 `bun.lock`。桌面开发需 Rust/Cargo。Windows 使用 MSVC C++ 构建工具及 WebView2，macOS 使用 Xcode 命令行工具。首次构建需要下载 Rust 依赖。

**终端一：服务端**（仅本地播放可省略）：

```powershell
cd apps/server
if (!(Test-Path .env)) { Copy-Item .env.example .env }
# 编辑 .env，设置自己的 API_TOKEN，保留已有配置。
bunx wrangler d1 migrations apply D1 --local
bun run dev
```

Wrangler 默认地址为 `http://localhost:8787`，以终端输出为准。本地 D1/R2 数据位于 `apps/server/.wrangler/state`；本地启动和迁移不操作线上资源。更新数据库结构后先应用迁移，再重启服务端。

**终端二：桌面应用**：

```powershell
cd apps/app
bun run tauri dev
```

Tauri 自动启动 Vite 并打开窗口。Vite 固定使用 `http://localhost:1420`，端口占用会失败；不要再同时启动 app 的 `dev`。`TAURI_DEV_HOST` 可改变开发地址，HMR 使用 1421。根目录 `bun run dev` 只启动 Vite + Wrangler，不打开桌面窗口；仅查看前端可运行 `bun run --filter @ying/app dev`，文件选择、读取及完整播放验证使用 Tauri 窗口。

**使用流程**：在「App 设置」填写服务端根地址（不带 `/api`）和与 `API_TOKEN` 相同的密钥 → 导入本地 MP3 文件夹 → 点击列表「同步」 → 展开左侧「网络」，选择文件夹并双击歌曲。网络列表与本地共用布局，展示名称、封面、歌手、时长和大小。

### Windows / macOS 原生播放

- Windows 使用 WinRT MediaPlayer 和系统媒体控件，macOS 使用 AVPlayer 和系统「正在播放」。系统面板与键盘媒体键共用 Rust 队列，支持播放、暂停、切歌和进度调整，并显示歌曲信息与封面。
- 最小化、切换应用或锁屏时继续播放。关闭主窗口或退出应用会停止播放、清理系统媒体信息与播放临时文件。输出设备变化时暂停，重新连接后可手动继续。系统休眠期间由操作系统管理音频，唤醒后同步状态。
- 本地歌曲按索引 ID 读取原文件，播放不复制音乐目录。Linux 和浏览器预览使用 WebView 后端。
- Windows 上运行 `cargo check` 和 `cargo test`，系统媒体面板与媒体键使用 Release 绿色版人工验证。macOS 上用同样的 Rust 命令检查 AVPlayer 适配，系统媒体控件另做人工验收。

### Android

- 安装 Android Studio 的 JDK、SDK Platform 37、Platform Tools 和 NDK，设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`，并安装 `aarch64-linux-android` Rust target。Windows 的 Tauri 打包需要启用系统开发者模式以创建符号链接。
- 工程已在 `apps/app/src-tauri/gen/android`，首次重新生成时在 `apps/app` 执行 `bun run android:init`；已有工程不要重复初始化，以免覆盖原生定制。`bun run android:dev` 启动开发，`bun run android:build` 构建 ARM64 APK；本地调试包使用 `bun run tauri android build --target aarch64 --apk --debug --ci`。最低 Android 7.0/API 24，系统 WebView 需保持更新。
- 交付安装包使用 Release（`android:build` 默认），Debug 包仅供开发调试。交付前检查 APK 实际大小与内容，避免交付含大量调试符号或增量打包残留的产物。
- 真机开发通过 USB 调试连接，执行 `adb reverse tcp:1420 tcp:1420`、`adb reverse tcp:1421 tcp:1421`；访问本机 Worker 时再执行 `adb reverse tcp:8787 tcp:8787`，App 内填写 `http://localhost:8787`。`android:dev` 固定使用 `127.0.0.1`，保持开发页面处于安全上下文，并匹配服务端 CORS；Vite 由 Tauri 启动，不另起一个前端开发服务。发布版继续支持用户填写 HTTP/HTTPS 根地址。
- Android 原生目录访问位于 `src-tauri/plugins/android-files`。通过系统目录选择器持久授权，只扫描所选目录直接子文件；Android 系统限制选择存储根目录、Download 根目录等位置时，应选择其下的音乐文件夹。取消选择不改索引；撤销授权后重新导入原文件夹恢复访问，授权失效的刷新保留旧索引。
- URI 是不透明标识；文件夹名和原始 `filename` 来自文档提供者。播放和同步都按歌曲 ID 查询索引，禁止解析 URI 拼接文件名。同步通过 `localAudio.readAudio/readLyrics` 读取，播放将临时文件交给原生播放器。读取结束或播放器释放文件后清理临时副本，不永久复制导入目录。
- Android 包名统一为 `ying.audio.player`。SQLite 与 `.network-cache` 直接位于 `Android/data/ying.audio.player/`；原生层通过 `getExternalFilesDir(null)` 取得系统创建目录的父目录，不硬编码存储盘路径，不申请全盘权限。外部存储不可写时报错，不回退内部目录；卸载仍清除这些数据。更换包名视为新应用，旧包私有数据、设置及目录授权不自动迁移，需重新配置和导入。桌面继续使用可执行文件同目录。音乐列表在 Android 单击播放，桌面双击；布局沿用响应式界面。
- 移动端原生播放直接读取和写入磁盘缓存。保留的移动缓存 IPC 走 JSON，二进制数据分为最多 64 KiB 的有序数据块，收齐并校验总长度后发布完成标记。
- 使用 Media3 原生播放服务，支持切后台或锁屏后连续播放，以及通知栏、锁屏和耳机的播放控制。从最近任务划掉 App 时停止播放并清理通知。返回键先关闭弹层与侧栏，再收起全屏歌词，再返回历史页面，无历史时退出 App。
- 原生代码测试：完成一次 Tauri Android 构建生成依赖配置后，在 `src-tauri/gen/android` 执行 `./gradlew.bat :tauri-plugin-android-files:testDebugUnitTest`；这些 JVM 单元测试不启动 App 或模拟器。改动 Kotlin、Rust、IPC 后同步检查两端类型和 capabilities。

### iOS

- 支持 iOS 16.4 及以上的 iPhone、iPad。使用 macOS 完整 Xcode（含 iOS SDK 和模拟器）、XcodeGen、CocoaPods、libimobiledevice，并安装 `aarch64-apple-ios` 与 `aarch64-apple-ios-sim` Rust targets（Intel Mac 的模拟器使用 `x86_64-apple-ios`）。在 `apps/app` 运行 `bun run ios:init` 初始化缺失的工程，`bun run ios:dev` 开发，`bun run ios:build` 打包。真机签名在本地配置 Xcode 开发团队或设置 `APPLE_DEVELOPMENT_TEAM`。
- 模拟器可用 `http://localhost:8787` 访问本机 Worker。真机 Vite 热更新使用 `bun run ios:dev --host`（Vite 读取 Tauri 提供的 `TAURI_DEV_HOST`）；联调默认 CORS 的 Worker 时使用模拟器 localhost 或安装已构建的 App。真机访问局域网 Worker 时使 Worker 监听局域网地址，App 填写 Mac 的局域网地址及端口，并允许 iOS 的局域网访问提示。内置 WebView 允许用户配置 HTTP 或 HTTPS；发布版 Tauri 来源已由 Worker 放行。
- 通过系统「文件」选择音乐文件夹，仅扫描直接子文件。Swift 插件 `src-tauri/plugins/ios-files` 保存目录授权书签并协调读取，Rust 负责索引。授权失效后重新选择原文件夹恢复访问；刷新失败保留旧索引；移除导入记录释放授权书签并保留原文件。
- SQLite、授权书签和 `.network-cache` 位于应用沙盒的 `Library/Application Support/YingAudioPlayer`，缓存目录排除系统备份。歌曲单击播放，通过 AVPlayer 和后台音频会话连续播放，可在锁屏、控制中心和耳机上操作。强制退出 App 停止播放。锁屏期间加载未缓存歌曲若超过系统允许的后台准备时间，暂停并显示可重试错误。
- 书签和文件扫描逻辑可用 macOS 主机上的 Swift 测试验证。在 `apps/app` 执行 `ios_plugin=src-tauri/plugins/ios-files/ios; swiftc "$ios_plugin/Sources/FolderAccess.swift" "$ios_plugin/Tests/FolderAccessTests.swift" -o /tmp/ying-ios-folder-access-tests && /tmp/ying-ios-folder-access-tests`。系统选择器与实际安全作用域由 iOS 真机验证。

## 音乐与同步约定

- 侧栏「本地」展开后可删除文件夹，确认后仅移除导入记录和本地歌曲索引，保留磁盘原文件及云端歌曲，可随时重新导入。移除当前播放歌曲所在文件夹会停止播放，并从队列清除该文件夹歌曲；同步或刷新期间不可移除。
- 侧栏「网络」展开后可删除整个云端文件夹，确认后删除其中全部歌曲、音频、歌词、封面及上传暂存资源，不可恢复；保留本地原始文件与已下载的磁盘缓存。同名本地文件夹同步与网络删除互斥。删除成功后停止该文件夹的播放、清除队列条目和内存缓存；当前位于该文件夹时返回网络首页。以后主动同步同名本地文件夹可重新创建云端文件夹。
- 只扫描目录直接子文件中的 MP3，扩展名不区分大小写；不递归。同名 LRC 为歌词，封面取自音频内嵌图片。
- 本地 SQLite 为**可执行文件同目录**的 `localAudio.sqlite3`，开发时通常在 `apps/app/src-tauri/target/debug`；目录需可写，移动程序或清理构建目录会影响索引。
- 查询、重复导入和同步都使用已有索引，不隐式扫描；文件增删或标签变化后先手动刷新。刷新事务保留仍存在歌曲的 ID，失败保留旧索引；元数据读取失败仍可入库并显示警告。
- 同步按文件夹名称精确合并、按「文件夹 + 去掉末尾 .mp3 的文件名」匹配歌曲（扩展名忽略大小写）；同名覆盖，云端独有歌曲保留。上传音频、歌词、封面和本地歌曲元数据，不提交本地数据库 ID、绝对路径、`scanError` 或整个 SQLite 文件。
- 仅保存音频 `hash` 与可空的 `lyricsHash`，分别为文件原始内容的 SHA-256；不保存封面 hash。封面取自音频内嵌图片，随音频 hash 更新。创建上传返回 `requiredFiles` 和 `unchanged`；音频、歌词分别去重并补传缺失文件，完全一致时跳过；仅元数据变化复用对象。上传及提交时核对 R2 实际音频、歌词摘要。
- 同步逐首执行并显示成功、跳过及失败数量；普通文件失败继续，鉴权失败停止。同一文件夹同步期间禁用重复同步和刷新。索引声明有歌词却读取失败时，该歌曲同步失败；无歌词或封面时覆盖会清除旧关联。
- 网络播放通过查询参数 `authToken` 携带密钥下载完整音频。原生平台由播放器读取临时文件，WebView 后端转为 Blob 播放；封面按需加载，歌词或封面失败不阻止音频。音频上限 50 MiB、歌词 1 MiB、封面 10 MiB。
- 原生平台按「磁盘 → 网络」读取并由 Rust 保存，WebView 后端按「内存 → 磁盘 → 网络」读取并通过二进制 IPC 保存。下载后开始播放，随后在后台写入各平台数据目录中的 `.network-cache/<歌曲文件夹名>/<原始文件名>`。同目录保存同名 LRC 和以完整音频文件名加 `.json` 命名的完成标记。保留中文、空格和扩展名大小写，仅处理文件系统非法名称。桌面开发缓存通常位于 `apps/app/src-tauri/target/debug/.network-cache`，目录需可写。完成标记保存音频 hash、歌词 hash 和连接摘要，不含明文密钥。不同连接的同路径文件覆盖保存，只匹配当前连接的缓存。原生网络播放用独立的临时文件，播放器释放文件后清理。
- 磁盘缓存按列表已有音频 hash 与歌词 hash 及歌词存在状态匹配，不额外请求标识。命中时不请求音频与歌词；文件夹和歌曲列表仍联网，暂不支持完整离线浏览。新版本覆盖原文件，无歌词时删除旧 LRC。缓存使用临时文件和完成标记；文件缺失、长度不符或读取失败时重新下载。歌词下载失败时播放音频并警告，不发布完整缓存；保存失败不阻止本次播放。可手动删除 `.network-cache` 清理缓存。
- 网络封面按连接和歌曲音频 hash 缓存。App 内共用有大小上限的内存缓存，原生平台的列表和系统媒体面板共用歌曲目录中的 `<原始文件名>.cover`。封面可独立于音频和歌词缓存，未命中时合并同一首歌的封面下载。
- 本地和网络共用暂停、上一首/下一首、顺序/随机/单曲循环、进度、音量及歌词。WebView 后端使用请求序号防竞态并回收 Blob URL，原生平台由 Rust 维护队列和会话版本并忽略已取消的媒体加载；覆盖当前歌曲后同步更新当前条目及队列 hash。
- 地址和密钥保存在 localStorage 的 `ying-audio-player-network`；音量和模式保存在 `ying-audio-player-settings`。修改连接配置时终止旧网络请求、停止网络播放并释放网络缓存，本地播放不受影响。

## 服务端数据与接口

- API 基础路径为 `/api`：`GET /folder/list`、`POST /folder`、`DELETE /folder/:id`、`GET /audio/list?folderId=<id>`、`POST /upload`、`PUT /upload/:id/{audio,lyrics,cover}`、`POST /upload/:id/commit`、`GET /audio/:id?kind=<audio|lyrics|cover>`。文件夹删除幂等返回 `{ ok: true }`，D1 原子登记全部资源清理并删除文件夹、歌曲及上传记录，随后立即后台尝试清理 R2；失败保留队列，由每小时任务重试。
- D1/R2 绑定名为 `D1`、`R2`；schema 位于 `apps/server/src/db/schema.ts`，SQL 表名使用单数，导出变量加 `Table` 后缀。歌曲通过表达式唯一索引按「folderId + filename 去掉末尾 .mp3」匹配，保留其余大小写，不额外存储歌曲匹配名称。
- `folder` 保存文件夹；`audio` 保存已发布的元数据、R2 引用和音频 hash 与歌词 hash。R2 key 为 `文件夹名/去扩展名文件名/audio|lyrics|cover`；不保留历史对象。音频/封面 URL 使用音频 `hash`，歌词 URL 使用 `lyricsHash` 作为 `hash` 查询参数，区分缓存并拒绝过期请求。
- 创建上传会话时在 JSON 请求体中传入 `folderId`。`audioUpload` 保存待发布元数据、hash 和复用/新上传的对象引用；其 hash 用于本次上传校验，`audio` 的 hash 用于下次比较。上传 hash 必填；同曲最多一个未过期待提交会话。上传记录保存必需文件及完成状态，旧对象存在不能代替本次上传完成。
- D1 与 R2 不共享事务：文件齐全后通过 Drizzle `db.batch` 原子更新歌曲、旧文件清理队列及提交标记。保留幂等、过期和并发检查；固定路径覆盖前设置 `updating` 并阻止媒体读取，提交后恢复；失败不回滚旧文件，释放失败会话以便立即重试；失败或过期后的下一次同步强制重传。D1 限制正常同曲并发，删除/过期和在途请求的极端交错仍可能冲突。
- `audioGarbage` 仅保存待删除 R2 key。每小时清理替换的旧文件及超过 30 分钟的上传记录/暂存对象；删除前检查当前歌曲和未过期待提交上传的引用，删除失败保留队列重试。R2 桶保持私有。
- 数据库访问由 `src/db/middleware.ts` 配置的 Drizzle 实例提供；接口通过 `c.get('db')` 获取，定时任务通过 `createDb` 初始化。
- `business/dto.ts` 集中定义请求校验，数值 ID 为正安全整数，上传 ID 由服务端生成 UUID。`app.error.handler.ts` 统一处理 HTTP 异常。
- 服务端请求的 Zod schema 校验统一使用 `business/base.validator.ts` 导出的 `zValidator` 中间件，通过 `c.req.valid(...)` 获取校验后的数据；不要在路由中手写 `safeParse` / `parse` 及校验错误处理。
- 服务端通过 `API_TOKEN` 对查询参数 `authToken` 的原始值做时序安全比较，仅接受 query 鉴权。本地配置位于 `.env`，示例为 `.env.example`。鉴权与 CORS 在 `main.ts`，放行开发浏览器/Tauri 来源的预检；实际密钥不写入文档、日志或提交。

## 验证与维护

- Git 提交信息（标题和正文）统一使用英文。
- 每次执行完计划模式的计划后，仅进行代码测试，不启动 App 的 E2E 测试，不自动提交代码。

| 目的                             | 工作目录             | 命令                                                |
| -------------------------------- | -------------------- | --------------------------------------------------- |
| workspace 类型检查 / lint / 构建 | 根目录               | `bun run check` / `bun run lint` / `bun run build`  |
| 播放队列、网络同步及播放测试     | 根目录               | `bun test apps/app/tests`                           |
| 前端测试类型检查                 | 根目录               | `bunx tsc --noEmit -p apps/app/tests/tsconfig.json` |
| 服务端测试及其类型检查           | `apps/server`        | `bun run test` / `bun run test:check`               |
| Rust 扫描/索引测试               | `apps/app/src-tauri` | `cargo test`                                        |
| Windows 桌面绿色版               | `apps/app`           | `bun run windows:build`                             |

普通前端 `check` 不含测试；Rust 检查不由 Turbo 执行；根目录 `build` 不打桌面包或部署 Worker。缺少 `.git` 导致 Turbo 失败时，可用 `bun run --filter '*' check`（或 `lint` / `build`）。

- Windows 桌面交付默认为 Release 绿色版，交付目录 `apps/app/src-tauri/target/release/portable` 仅保留压缩包，沿用 target 的现有忽略规则。压缩包按 `ying-audio-player-<版本>-windows-x64-portable.zip` 命名，版本读取 `src-tauri/tauri.conf.json`；包内为 `YingAudioPlayer/YingAudioPlayer.exe`，文件夹和主程序仅使用应用名称的大驼峰形式。仅打包程序文件，避免混入运行后生成的索引、设置或音乐缓存。

- 桌面回归：导入、刷新及重启恢复；本地/网络播放控制、三种播放模式和歌词；重复同步跳过、只改歌词、仅元数据变化、覆盖正在播放的歌曲、缺失文件、断网及错误密钥。
- Worker 联调使用独立本地库：在 `apps/server` 执行 `bunx wrangler d1 migrations apply D1 --local --persist-to .wrangler/music-smoke`，再运行 `bunx wrangler dev --ip 127.0.0.1 --port 8788 --persist-to .wrangler/music-smoke --var API_TOKEN:local-smoke-key --test-scheduled`；另开终端在同目录执行 `bun run test:worker`。脚本默认本机 8788 和上述测试密钥，覆盖 hash 去重、校验、发布及清理；本地定时任务需 `--test-scheduled` 后调用 `/__scheduled` 触发。
- 在 `apps/server` 执行 `bunx drizzle-kit generate` 生成迁移、`bunx wrangler types` 更新绑定类型；修改 schema 时检查 `src/db/relations.ts`。已有数据库结构演进使用显式迁移并保留歌曲与文件引用，本地 SQLite 也不能仅改建表语句。
- 线上变更单独执行：确认 D1/R2 资源和绑定正确，再运行 `bunx wrangler d1 migrations apply D1 --remote`、`bunx wrangler secret put API_TOKEN`、`bunx wrangler deploy`。客户端配置 Worker HTTPS 根地址及同一密钥；这些操作不属于本地启动步骤。
- IPC 字段变化同步检查 Rust、`local-audio.ts` 与 `AudioInfo`；新增命令/文件能力检查 `src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`。扫描成功不保证播放器能解码音频。
- 文件路由由 Vite/TanStack Router 更新 `routeTree.gen.ts`；Tauri schemas 和 `worker-configuration.d.ts` 按生成流程维护。两个 workspace 的 `@/*` 各指向自己的 `src/*`。
- 格式以根 `.oxfmtrc.json` 为准，局部修改仅格式化目标文件。`.husky/pre-commit` 运行 `bun lint-staged`，不能代替类型检查、测试和桌面行为验证。

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
