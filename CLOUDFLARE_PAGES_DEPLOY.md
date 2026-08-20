# 秘密的树洞：Cloudflare Pages 部署步骤

这个版本已经支持 Cloudflare Pages：

- `public/`：静态网页。
- `functions/api/[[path]].js`：Cloudflare Pages Functions 后端接口。
- `wrangler.toml`：Cloudflare Pages 配置，输出目录是 `public`。
- Supabase：继续保存聊天记录、日记、每日目标、视频图片和视频通话信令。

## 1. 先更新 Supabase

打开 Supabase Dashboard，进入 SQL Editor，重新运行 `supabase-setup.sql`。

这一步会确保这些表存在：

```text
treehole_messages
treehole_diary
treehole_sesame
treehole_goals
treehole_call_signals
```

也会把 `treehole-media` bucket 的 `file_size_limit` 设置为 2GB。

如果上传大视频仍然提示 `EntityTooLarge`，说明 Supabase 项目自己的全局上传限制还没放开。需要去 Supabase 的 Storage Settings 调高 Global file size limit；免费版可能无法稳定上传 1GB 以上视频。

## 2. 上传代码到 GitHub

仓库根目录需要包含：

```text
package.json
public/
functions/
supabase-setup.sql
wrangler.toml
```

`server.js` 可以保留，它是 Render/本地 Node 版本用的，Cloudflare Pages 不会用它。

## 3. 创建 Cloudflare Pages 项目

1. 登录 Cloudflare。
2. 进入 `Workers & Pages`。
3. 点 `Create`。
4. 选择 `Pages`。
5. 选择 `Connect to Git`。
6. 选择你的 GitHub 仓库。

构建设置这样填：

```text
Framework preset: None
Build command: 留空
Build output directory: public
Root directory: 留空
```

如果你的文件放在仓库子目录里，比如 `secret-tree-hole/`，那 `Root directory` 就填这个子目录名。

## 4. 添加环境变量和密钥

在 Cloudflare Pages 项目里进入：

```text
Settings -> Variables and Secrets
```

添加这些变量：

```text
CHAT_PASSWORD=liu123
MAX_UPLOAD_MB=2048
SUPABASE_URL=你的 Supabase Project URL
SUPABASE_BUCKET=treehole-media
SESSION_SECRET=随便生成一串很长的随机字符
```

下面这个必须作为 Secret/Encrypted 保存：

```text
SUPABASE_SERVICE_ROLE_KEY=你的 Supabase service_role key 或 sb_secret key
```

不要把 `SUPABASE_SERVICE_ROLE_KEY` 写进前端代码或公开文件。

## 5. 重新部署

环境变量保存后，进入：

```text
Deployments -> Retry deployment
```

或者推送一次新 commit，让 Cloudflare 自动部署。

部署成功后，你会得到一个地址，类似：

```text
https://secret-tree-hole.pages.dev
```

两个人都打开这个地址，输入密码 `liu123` 就可以使用。

## 6. 和 Render 的区别

Cloudflare Pages 没有 Render Free 那种长时间休眠后的 502，一般访问更快。

但 Pages 不是常驻 Node 服务器，所以这个版本在 Cloudflare 上使用轮询同步消息、日记、每日目标和视频通话信令。聊天记录、日记、目标和媒体仍然保存在 Supabase。

大视频上传仍然受 Supabase 限制，不受 Cloudflare Pages 流量限制直接控制。
