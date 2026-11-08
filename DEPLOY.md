# 部署指南（Moe Memos + Cloudflare 版）

本仓库是 [Allhuo/memos-cloudflare](https://github.com/Allhuo/memos-cloudflare) 的一个分支，在上游基础上补充了
**第三方安卓客户端（Moe Memos）兼容层**和若干修复，详见文末「相对上游的改动」。

## 需要准备

- Node.js 20+、pnpm 9+（`npm i -g pnpm`）
- 一个 Cloudflare 账号（免费版够用）
- 本地登录 Cloudflare：`npx wrangler login`

## 部署步骤（约 5 分钟）

```bash
# 1. 克隆你自己的 fork
git clone https://github.com/<你的用户名>/memos-cloudflare.git
cd memos-cloudflare

# 2. 构建前端（产物 frontend/dist 会被 Worker 当作静态资源托管）
cd frontend
pnpm install
pnpm build
cd ..

# 3. 创建 D1 数据库（记下输出的 database_id）
cd backend
npx wrangler d1 create memos

# 4. 把上一步的 database_id 填进 backend/wrangler.toml
#    仓库里默认是 REPLACE_WITH_YOUR_D1_ID 占位符，必须替换

# 5. 创建 R2 存储桶（图片/附件用）
npx wrangler r2 bucket create memos-assets

# 6. 初始化数据库表结构
npx wrangler d1 execute memos --remote --file schema-v2.sql

# 7. 设置 JWT 密钥（自己生成一个随机值）
openssl rand -base64 32 | npx wrangler secret put JWT_SECRET

# 8. 部署
npx wrangler deploy
```

部署完成会得到 `https://memos-cloudflare.<你的子域>.workers.dev`。

> 建议在 Cloudflare 控制台给它绑一个自定义域名（Pages/Workers → 自定义域），
> 手机 App 里填这个域名更稳定。

## 首次登录

- 默认账号：`admin` / `123456` —— **登录后立刻在「设置 → 我的账号 → 修改密码」里改掉**
- 建议同时关闭注册（设置 → 系统）

## 手机 App（Moe Memos）配置

1. 打开 App，服务器地址填你部署的域名，例如 `https://memo.example.com`（不要带 `/api`）
2. 访问令牌：在网页端「设置 → 访问令牌 → 创建」，复制 `memos_pat_...`
3. 粘贴令牌登录

> 本仓库已实现 `/api/v1/*`（Memos 0.21 风格 REST）兼容层，因此 Moe Memos 2.0.x 可以直接连；
> 同时保留 Connect API（`/memos.api.v1.*`），官方 Web 前端功能不受影响。

## 可选：push 自动部署

在 Cloudflare 控制台的 Workers 页面选择本仓库连接 Git（Workers Builds），
设置构建命令 `pnpm --dir frontend install && pnpm --dir frontend build`，
之后每次 push 到 `main` 会自动重新部署。

注意：D1 的 `database_id` 和 `JWT_SECRET` 与账号绑定，**不会**因为 push 而同步，只配置一次即可。

## 相对上游的改动

- `backend/src/v2/router.ts`：导出 `invokeRpc()`，供 REST 兼容层复用已注册的 Connect RPC
- `backend/src/v2/services/user.ts`：`UpdateUser` / `UpdateUserSetting` 支持缺省 `update_mask`
- `backend/src/v2/services/memo.ts`：`UpdateMemo` 支持缺省 `update_mask`
- `backend/src/v2/auth.ts`：新增 cookie 鉴权（`memos_refresh`）与附件外链签名
- `backend/src/v2/fileserver.ts`：附件支持 cookie 鉴权与 `?sig=` 签名访问
- `backend/src/routes/rest_v1.ts`：新增 REST 网关，`/api/v1/*` 映射到 Connect RPC（供 Moe Memos）
- `backend/src/routes/memo.ts` / `resource.ts` / `tag.ts` / `user.ts` / `workspace.ts`：
  0.21 风格接口的完整实现（数字 id、`createdTs`、`resourceList`、附件上传、公开过滤等）
- `backend/src/middleware/auth.ts`：旧版路由支持 `memos_pat_` 访问令牌
- `backend/src/index.ts`：挂载 REST 网关与旧版路由到 `/api` 与 `/api/v1`

## 已知限制

- 附件外链带 HMAC 签名（`?sig=`），签名不过期；若想收紧可改为带过期时间
- 缩略图未实现（`?thumbnail=true` 直接返回原图）

### Upgrade from an older deploy (existing database)

```bash
cd backend
npx wrangler d1 execute memos --remote --command "ALTER TABLE memo ADD COLUMN pinned_ts INTEGER"
npx wrangler d1 execute memos --remote --command "UPDATE memo SET pinned_ts = updated_ts WHERE pinned = 1 AND pinned_ts IS NULL"
```n