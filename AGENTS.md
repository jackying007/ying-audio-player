# 项目指引

## 项目与入口

Bun workspace + Turborepo，包含 Tauri 桌面播放器和 Cloudflare 音乐服务。本地播放独立可用；网络功能提供文件夹同步、增量上传和播放。功能与启动说明统一维护在本文件。

- `apps/app`：Tauri 2、React 19、TypeScript、Vite、TanStack Router、Zustand、Tailwind CSS 4、shadcn/Radix。
- 本地索引：`apps/app/src-tauri/src/local_audio.rs`；IPC：`src/lib/local-audio.ts`；文件夹与扫描：`src/store/app-store.ts`、`local-audio-store.ts`。
- 播放：`src/store/audio-store.ts`、`src/lib/playback-queue.ts`、`src/layout/audio-player`；共用歌曲列表：`src/routes/-shared/audio-list.tsx`。
- 网络：`src/lib/network-audio.ts`、`file-hash.ts`、`src/store/network-audio-store.ts`、`network-settings.ts`；页面：`src/routes/local`、`network`、`settings.tsx`。
- `apps/server`：Workers + Hono + Drizzle + D1 + 私有 R2。入口 `src/main.ts` 管理鉴权、CORS、中间件和定时任务；`src/business/index.ts` 定义接口，`metadata.ts` 校验元数据，`cleanup.ts` 清理文件。

## 组件放置约定

- 新增业务组件放在 `apps/app/src/routes` 下，与对应页面就近维护；页面专用组件放在对应路由的 `-` 前缀目录中，跨页面共用的业务组件放在 `src/routes/-shared`，避免被 TanStack Router 识别为路由。
- `apps/app/src/components` 仅放与业务无关的通用组件和 UI 基础组件，不放业务组件；歌曲列表 `audio-list`、歌曲封面 `audio-cover` 等属于业务组件。

## 安装与启动

根目录执行 `bun install`，使用 `package.json` 指定的 Bun 和 `bun.lock`。桌面开发需 Rust/Cargo、MSVC C++ 构建工具及 WebView2，首次构建需要下载 Rust 依赖。

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

## 音乐与同步约定

- 只扫描目录直接子文件中的 MP3，扩展名不区分大小写；不递归。同名 LRC 为歌词，封面取自音频内嵌图片。
- 本地 SQLite 为**可执行文件同目录**的 `localAudio.sqlite3`，开发时通常在 `apps/app/src-tauri/target/debug`；目录需可写，移动程序或清理构建目录会影响索引。
- 查询、重复导入和同步都使用已有索引，不隐式扫描；文件增删或标签变化后先手动刷新。刷新事务保留仍存在歌曲的 ID，失败保留旧索引；元数据读取失败仍可入库并显示警告。
- 同步按文件夹名称精确合并、按「文件夹 + 完整文件名」匹配歌曲；同名覆盖，云端独有歌曲保留。上传音频、歌词、封面和本地歌曲元数据，不提交本地数据库 ID、绝对路径、`scanError` 或整个 SQLite 文件。
- 分别计算音频、歌词、封面的 SHA-256；创建上传时由服务端返回 `requiredFiles` 和 `unchanged`。只传变化、hash 缺失或云端缺失的文件；仅元数据变化时复用对象，完全一致时跳过。R2 校验实际上传内容。
- 同步逐首执行并显示成功、跳过及失败数量；普通文件失败继续，鉴权失败停止。同一文件夹同步期间禁用重复同步和刷新。索引声明有歌词却读取失败时，该歌曲同步失败；无歌词或封面时覆盖会清除旧关联。
- 网络播放携带 Bearer 密钥下载完整音频，再转为 Blob 播放；封面按需加载，歌词或封面失败不阻止音频。音频上限 50 MiB、歌词 1 MiB、封面 10 MiB。
- 本地和网络共用暂停、上一首/下一首、顺序/随机/单曲循环、进度、音量及歌词。保留请求序号防竞态、来源隔离、缓存失效和 Blob URL 回收；覆盖当前歌曲后同步更新当前条目及队列版本。
- 地址和密钥保存在 localStorage 的 `ying-audio-player-network`；音量和模式保存在 `ying-audio-player-settings`。修改连接配置时终止旧网络请求、停止网络播放并释放网络缓存，本地播放不受影响。

## 服务端数据与接口

- API 基础路径为 `/api`：`GET/POST /folders`、`GET /folders/:id/audios`、`POST /folders/:id/uploads`、`PUT /uploads/:id/{audio,lyrics,cover}`、`POST /uploads/:id/commit`、`GET /audios/:id/{audio,lyrics,cover}`。
- D1/R2 绑定名为 `D1`、`R2`；schema 位于 `apps/server/src/db/schema/audio.ts`，歌曲按 `folderId + filename` 唯一匹配。
- `folders` 保存文件夹；`audios` 保存已发布的元数据、R2 引用和文件 hash。`version` 是发布时的上传 ID，用于 URL 缓存区分和拒绝旧版本请求。
- `audioUploads` 保存待发布元数据、hash 和复用/新上传的对象引用；其 hash 用于本次上传校验，`audios` 的 hash 用于下次比较。两者分别代表待发布和已发布状态，避免失败上传污染旧版本。
- D1 与 R2 不共享事务：文件齐全后通过 Drizzle `db.batch` 原子更新歌曲、旧文件清理队列及提交标记。保留幂等、过期和并发检查；失败保持旧版本可用。
- `audioGarbage` 仅保存待删除 R2 key。每小时清理替换的旧文件及超过 24 小时的上传记录/暂存对象；删除前检查当前歌曲和未过期待提交上传的引用，删除失败保留队列重试。R2 桶保持私有。
- 数据库访问由 `src/db/middleware.ts` 配置的 Drizzle 实例提供；接口通过 `c.get('db')` 获取，定时任务通过 `createDb` 初始化。
- `business/base.validator.ts` 提供路由参数校验，数值 ID 为正安全整数，上传 ID 为 UUID；`app.error.handler.ts` 统一处理 HTTP 异常。
- 服务端通过 `API_TOKEN` 校验 Bearer 密钥，本地配置位于 `.env`，示例为 `.env.example`。鉴权与 CORS 在 `main.ts`，放行开发浏览器/Tauri 来源的预检；实际密钥不写入文档、日志或提交。

## 验证与维护

| 目的 | 工作目录 | 命令 |
| --- | --- | --- |
| workspace 类型检查 / lint / 构建 | 根目录 | `bun run check` / `bun run lint` / `bun run build` |
| 播放队列、网络同步及播放测试 | 根目录 | `bun test apps/app/tests` |
| 前端测试类型检查 | 根目录 | `bunx tsc --noEmit -p apps/app/tests/tsconfig.json` |
| 服务端测试及其类型检查 | `apps/server` | `bun run test` / `bun run test:check` |
| Rust 扫描/索引测试 | `apps/app/src-tauri` | `cargo test` |
| 桌面安装包 | `apps/app` | `bun run tauri build` |

普通前端 `check` 不含测试；Rust 检查不由 Turbo 执行；根目录 `build` 不打桌面包或部署 Worker。缺少 `.git` 导致 Turbo 失败时，可用 `bun run --filter '*' check`（或 `lint` / `build`）。

- 桌面回归：导入、刷新及重启恢复；本地/网络播放控制、三种播放模式和歌词；重复同步跳过、只改歌词、仅元数据变化、覆盖正在播放的歌曲、缺失文件、断网及错误密钥。
- Worker 联调使用独立本地库：在 `apps/server` 执行 `bunx wrangler d1 migrations apply D1 --local --persist-to .wrangler/music-smoke`，再运行 `bunx wrangler dev --ip 127.0.0.1 --port 8788 --persist-to .wrangler/music-smoke --var API_TOKEN:local-smoke-key --test-scheduled`；另开终端在同目录执行 `bun run test:worker`。脚本默认本机 8788 和上述测试密钥，覆盖 hash 去重、校验、发布及清理；本地定时任务需 `--test-scheduled` 后调用 `/__scheduled` 触发。
- 在 `apps/server` 执行 `bunx drizzle-kit generate` 生成迁移、`bunx wrangler types` 更新绑定类型；修改 schema 时检查 `src/db/relations.ts`。已有数据库结构演进使用显式迁移并保留歌曲与文件引用，本地 SQLite 也不能仅改建表语句。
- 线上变更单独执行：确认 D1/R2 资源和绑定正确，再运行 `bunx wrangler d1 migrations apply D1 --remote`、`bunx wrangler secret put API_TOKEN`、`bunx wrangler deploy`。客户端配置 Worker HTTPS 根地址及同一密钥；这些操作不属于本地启动步骤。
- IPC 字段变化同步检查 Rust、`local-audio.ts` 与 `AudioInfo`；新增命令/文件能力检查 `src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`。扫描成功不保证 WebView 能解码音频。
- 文件路由由 Vite/TanStack Router 更新 `routeTree.gen.ts`；Tauri schemas 和 `worker-configuration.d.ts` 按生成流程维护。两个 workspace 的 `@/*` 各指向自己的 `src/*`。
- 格式以根 `.oxfmtrc.json` 为准，局部修改仅格式化目标文件。`.husky/pre-commit` 运行 `bun lint-staged`，不能代替类型检查、测试和桌面行为验证。
