### 生成 wrangler 类型

```bash
bunx wrangler types
```

### 生成迁移

```bash
bunx drizzle-kit generate
```

### 执行本地迁移

```bash
bunx wrangler d1 migrations apply D1 --local
```

### 本地启动

```bash
bun dev
```

访问 `http://localhost:8787/cdn-cgi/local/explorer` 查看本地 `D1` 和 `R2`

### 执行远程迁移

```bash
bunx wrangler login
```

```bash
bunx wrangler d1 migrations apply D1 --remote
```

### 部署

```bash
bunx wrangler deploy
```
