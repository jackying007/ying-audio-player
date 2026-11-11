<h1 align="center">Ying Audio player</h1>

嘤嘤播放器是一款面向个人音乐收藏的播放器，支持 Windows、macOS、Android 和 iOS。导入音乐文件夹后就能离线播放，也可以把音乐同步到自己部署的服务，在其他设备上听。

## 主要功能

- 导入本地 MP3 文件夹，显示音频内嵌封面和同名 LRC 歌词。添加或修改文件后，可手动刷新列表。
- 支持顺序播放、随机播放和单曲循环，也可以通过系统媒体控件暂停或切歌。
- 按文件夹同步歌曲，重复同步时只上传有变化或缺失的文件。

## 技术栈

- 播放器（`apps/app`）使用 Tauri 2、Rust、React 和 TypeScript，本地歌曲索引保存在 SQLite 中。
- 服务端（`apps/server`）使用 Cloudflare Workers、Hono 和 Drizzle。D1 保存歌曲和文件夹信息，私有 R2 存储桶保存音频、歌词和封面。
- 仓库使用 Bun 管理依赖，使用 Turborepo 运行项目任务。

## 部署服务端

使用跨设备同步时，需要在自己的 Cloudflare 账号下部署服务端。

1. 在 Cloudflare 创建一个 D1 数据库和一个私有 R2 存储桶。修改 [服务端配置](apps/server/wrangler.jsonc) 中的 `database_name`、`database_id` 和 `bucket_name`，将它们指向自己创建的资源。绑定名沿用 `D1` 和 `R2`。
2. 仓库默认关闭 `workers.dev`。如果使用 Cloudflare 提供的默认地址，把配置中的 `workers_dev` 改为 `true`。如果使用自己的域名，部署后在 Cloudflare 控制台为 Worker 添加自定义域名。[Cloudflare 域名配置说明](https://developers.cloudflare.com/workers/configuration/routing/)
3. 安装 Bun 后，在仓库根目录执行以下命令。最后一条命令会提示输入自设的 App 连接密钥。[Cloudflare 密钥配置说明](https://developers.cloudflare.com/workers/configuration/secrets/)

   ```sh
   bun install
   cd apps/server
   bunx wrangler login
   bunx wrangler d1 migrations apply D1 --remote
   bunx wrangler deploy
   bunx wrangler secret put API_TOKEN
   ```

部署完成后，在「App 设置」填写 Worker 的 HTTPS 根地址（省略 `/api`）和刚设置的密钥。导入本地音乐文件夹并点击「同步」，其他设备使用同一地址和密钥即可从「网络」中播放。

本地开发和各平台打包步骤见 [项目指引](AGENTS.md)。
