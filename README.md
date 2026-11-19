# 五子棋联机（多人联机验证 第 1 步）

架构：**Node.js 服务器 + WebSocket**，服务器做裁判（判轮次、判胜负），浏览器只负责显示和点击。
这和以后做 VRChat 式联机是同一套骨架，只是同步的内容从"棋盘"变成"位置/动作"。

## 本地运行
```
npm install
node server.js          # 默认端口 5218，密码 123
```
- 同一台电脑：开两个浏览器标签页，输入同一个房间号 + 密码 123
- 同一 Wi-Fi 的另一台电脑/手机：用启动时打印的 `局域网: http://192.168.x.x:5218`
  （第一次 Windows 会弹防火墙提示，选"允许"）
- 测试：`node dev/test.js`（无头模拟两个玩家 + 观众 + 断线重连）

## 功能
- 房间号随便填，两人进同一房间即对战，第三人起为观战
- 密码统一 123（环境变量 `ROOM_PASSWORD` 可改）
- 邀请链接 `?room=房间号`；大厅列出正在进行的房间
- 断线自动重连，座位保留 2 分钟；刷新页面会回到原座位
- 再来一局需双方同意，自动交换黑白；房间内聊天；延迟显示

## 部署到 Render（免费）

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ssttmkkw-hue/c-c-10-gomoku)

1. 登录 Render（用 GitHub 账号登录最省事）
2. 点上面的按钮，或在 Render 里选 **New → Blueprint**，选仓库 `c-c-10-gomoku`
3. 它会读取仓库里的 `render.yaml`，直接点 **Apply / Deploy**，等 2–3 分钟
4. 得到网址 `https://c-c-10-gomoku-xxxx.onrender.com`，发给朋友，密码 123

免费版须知：
- 15 分钟没人访问会休眠，下次打开要等 30–60 秒（页面会一直转圈，等就行）
- 休眠/重新部署会清空所有房间（房间本来就只存在内存里，不影响使用）
- 以后改代码推到 GitHub `main`，Render 会自动重新部署

## 其他公网方案
| 方案 | 费用 | 适合 |
|---|---|---|
| Cloudflare 临时隧道：`cloudflared tunnel --url http://localhost:5218` | 免费，无需账号 | 马上测，你电脑开着就能玩，网址每次变 |
| 香港/海外轻量云服务器（腾讯云/阿里云轻量） | 约每月几十元 | 长期稳定；以后 VRChat 式联机也用它 |
| Render / Railway / Fly.io 托管 Node | 免费档会休眠，付费约 $5–7/月 | 不想管服务器；国内访问可能慢 |

服务器读 `PORT` 环境变量，以上平台都可直接 `npm start`。
