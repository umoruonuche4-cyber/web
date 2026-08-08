# 秘密的树洞

这是一个密码保护的双人远距离聊天网站。默认密码是 `liu123`，进入后可以发送文字、照片和视频。

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

Render Free 的本地文件会在重启、重新部署或休眠后丢失，所以不要用本地 `data/` 保存正式聊天内容。部署到 Render Free 时，请使用 Supabase 保存聊天记录和照片/视频。

### 1. 在 Supabase 创建项目

1. 打开 Supabase。
2. 创建一个新项目。
3. 进入左侧 `SQL Editor`。
4. 新建 SQL，把 `supabase-setup.sql` 里的内容粘贴进去并运行。

这会创建：

- `treehole_messages` 表，用来保存最近聊天记录。
- `treehole-media` bucket，用来保存照片和视频。

### 2. 在 Supabase 找到连接信息

进入 `Project Settings` -> `API`，复制：

- `Project URL`
- `service_role` key

`service_role` key 只能放在 Render 的环境变量里，不能写进前端代码，也不要发给别人。

### 3. 在 Render 设置环境变量

在 Render 的服务页面，进入 `Environment`，添加：

```text
CHAT_PASSWORD=liu123
MAX_UPLOAD_MB=50
SUPABASE_URL=你的 Supabase Project URL
SUPABASE_SERVICE_ROLE_KEY=你的 Supabase service_role key
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

部署成功后，两个人打开 Render 给你的公网网址，输入密码 `liu123` 就可以聊天、发照片和视频。

## 注意

- Render Free 休眠后，再次打开可能需要等约一分钟。
- Render 服务重启后，可能需要重新输入一次密码。
- 聊天记录和媒体文件保存在 Supabase，不会因为 Render Free 休眠而丢。
- 公开使用前建议把 `CHAT_PASSWORD` 改成更强的密码。
