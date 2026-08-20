# 秘密的树洞：Cloudflare Pages 当前部署清单

你现在的 Cloudflare Pages 项目名是 `web`，网站地址是：

```text
https://web-1bc.pages.dev
```

网页能打开登录页，说明 `public/` 静态页面已经成功部署。现在登录时报 `请求失败：500`，重点检查 Pages Functions、环境变量和 Supabase 表。

## 1. GitHub 仓库必须有这些文件

仓库根目录需要包含：

```text
package.json
wrangler.toml
public/
functions/
supabase-setup.sql
```

Cloudflare Pages 用：

```text
public/
functions/api/[[path]].js
wrangler.toml
```

`server.js` 是以前 Render/本地 Node 版本用的，Cloudflare Pages 不使用它，可以保留。

## 2. Cloudflare 构建配置

进入：

```text
Workers & Pages -> web -> Settings -> Build
```

推荐这样填：

```text
Framework preset: None
Build command: 留空
Deploy command: 留空
Build output directory: public
Root directory: 留空 或 /
```

如果页面不允许留空，就填：

```text
Build command: exit 0
Deploy command: exit 0
Build output directory: public
```

不要再填：

```text
npx wrangler deploy
npx wrangler pages deploy public --project-name web
```

这些命令适合本地手动部署，不适合 Cloudflare Pages 连接 GitHub 后的自动构建。

## 3. Cloudflare 环境变量

进入：

```text
Workers & Pages -> web -> Settings -> Variables and secrets
```

当前应该保留这些：

```text
CHAT_PASSWORD=liu123
MAX_UPLOAD_MB=2048
SESSION_SECRET=一串随机字符，越长越好
SUPABASE_BUCKET=treehole-media
SUPABASE_URL=https://seqkwcbpaiytbrmpdvsq.supabase.co
```

这个必须是 Secret/Encrypted：

```text
SUPABASE_SERVICE_ROLE_KEY=你复制的 sb_secret 或 service_role key
```

注意：

- `SUPABASE_URL` 只填到 `.co` 结尾。
- 不要加 `/rest/v1/`。
- 不要填 publishable key。
- `SUPABASE_SERVICE_ROLE_KEY` 是服务端密钥，不能放到网页代码里。

## 4. Supabase SQL 必须运行一次

打开 Supabase：

```text
SQL Editor -> 新建查询 -> 粘贴 supabase-setup.sql -> Run
```

它会创建这些表：

```text
treehole_messages
treehole_diary
treehole_sesame
treehole_goals
treehole_call_signals
treehole_presence
```

也会创建/更新存视频图片的 bucket：

```text
treehole-media
```

## 5. 修改后重新部署

每次改了环境变量或代码后，进入：

```text
Workers & Pages -> web -> Deployments
```

点：

```text
Retry deployment
```

或者推送一次新的 GitHub commit，让它自动部署。

## 6. 现在这个 500 怎么判断

先打开：

```text
https://web-1bc.pages.dev/api/health
```

如果显示：

```json
{"ok":true,"cloudflare":true}
```

说明 Functions 正常，登录 500 多半是 Supabase 变量、密钥或 SQL 表有问题。

如果 `/api/health` 也报错，说明 Functions 没部署成功，回到 Cloudflare 的 `Deployments -> View build logs` 看错误。

## 7. 大视频说明

网页已经把上传上限配置成 `2048MB`，但 1GB 以上视频最终还受 Supabase Storage 限制。出现：

```text
EntityTooLarge
```

说明 Supabase 拒绝了，不是 Cloudflare Pages 页面代码拒绝。
