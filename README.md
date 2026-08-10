# 秘密的树洞

这是一个密码保护的双人远距离聊天网站。默认密码是 `liu123`。进入后可以聊天、发照片、发较大的视频、视频通话，也可以写日记并在日记里上传图片和视频。

这个版本支持两种保存方式：

- 本地保存：适合在自己电脑上测试。
- Supabase 保存：适合部署到 Render Free，不需要 Render Disk。

## 本地运行

```powershell
node server.js
```

打开：

```text
http://localhost:3000
```

## Render Free + Supabase 部署

Render Free 的本地文件会在重启、重新部署或休眠后丢失，所以部署到 Render Free 时，请使用 Supabase 保存聊天记录、日记、照片和视频。

### 1. 在 Supabase 创建或更新数据表

1. 打开 Supabase。
2. 进入你的项目。
3. 进入左侧 `SQL Editor`。
4. 新建 SQL，把 `supabase-setup.sql` 里的内容粘贴进去并运行。

这会创建或更新：

- `treehole_messages` 表，用来保存聊天记录。
- `treehole_diary` 表，用来保存日记。
- `treehole-media` bucket，用来保存照片和视频。

如果你之前已经运行过旧版 SQL，这次也要再运行一次新版 `supabase-setup.sql`，因为日记功能需要新增 `treehole_diary` 表。

### 2. 在 Supabase 找到连接信息

进入 `Project Settings` -> `API`，复制：

- `Project URL`
- `service_role` key 或新版的 `sb_secret` key

密钥只能放在 Render 的环境变量里，不能写进前端代码，也不要发给别人。

### 3. 在 Render 设置环境变量

在 Render 的服务页面，进入 `Environment`，添加：

```text
CHAT_PASSWORD=liu123
MAX_UPLOAD_MB=500
SUPABASE_URL=你的 Supabase Project URL
SUPABASE_SERVICE_ROLE_KEY=你的 Supabase service_role key 或 sb_secret key
SUPABASE_BUCKET=treehole-media
```

不用设置 `DATA_DIR`，也不用添加 Disk。

### 4. Render 构建设置

确保仓库根目录直接包含：

```text
package.json
server.js
public/
supabase-setup.sql
README.md
```

Render 设置：

```text
Build Command: npm install
Start Command: npm start
Health Check Path: /api/health
```

如果你把文件放在了子文件夹里，就在 Render 的 `Settings` 里把 `Root Directory` 设置为那个子文件夹名。

### 5. 重新部署

点 Render 右上角：

```text
Manual Deploy -> Deploy latest commit
```

部署成功后，两个人打开 Render 给你的公网网址，输入密码 `liu123` 就可以使用聊天、视频、视频通话和日记功能。

## 注意

- Render Free 休眠后，再次打开可能需要等约一分钟。
- 如果经常看到 Render 的 `502 Bad Gateway`，可以用 UptimeRobot、cron-job.org 等免费监控工具，每 10 分钟访问一次 `https://你的网址.onrender.com/api/health`，减少免费服务休眠带来的不可用。
- Render 服务重启后，可能需要重新输入一次密码；如果勾选了记住密码，浏览器会自动进入。
- 聊天记录、日记和媒体文件保存在 Supabase，不会因为 Render Free 休眠而丢。
- 视频通话需要浏览器允许摄像头和麦克风权限。Render 的 `https://...onrender.com` 地址满足浏览器的 HTTPS 要求。
- WebRTC 视频通话使用公开 STUN 服务。大多数网络可以直接连通；如果两边网络都很严格，可能以后要加 TURN 服务。
- 登录页会在当前浏览器保存昵称和密码，下次打开会自动进入。不要在公共电脑上勾选“记住密码”。
- 公开使用前建议把 `CHAT_PASSWORD` 改成更强的密码。
