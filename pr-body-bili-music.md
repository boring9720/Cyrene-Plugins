## 插件功能与使用方式

bili-music 把 B 站视频分 P 当音乐音源：对话/语音里说「搜一下 XX」「播放第一首」，LLM 调用插件工具完成 搜索 → 选分 P → 拉 DASH 音频流 → ffmpeg 转 M4A → 内置隐藏播放器直接出声。支持播放队列（播放中再点播自动入队、播完自动下一首）与暂停/继续/下一首/音量控制；支持 B 站扫码登录（可选，解锁高码率音源），匿名也可用。

面板 UI（ui.html）：账号卡片（扫码登录/退出）、搜索试听、已下载管理、设置卡片（ffmpeg 路径 + 下载目录 + 一键安装 ffmpeg）。

## 申明的宿主能力（deps）及用途

- **无 deps 申明**：插件只使用插件系统基础 API（`registerTool` / `registerIpc` / `storage` / `events`）与 Electron 公开模块（`app` / `shell` / `BrowserWindow` / `ipcMain` / `dialog`），不申请 speech-input 等宿主能力。

## 网络访问（逐域名）

| 域名 | 用途 | 传输内容 |
|---|---|---|
| passport.bilibili.com | B 站扫码登录二维码生成/轮询（qrcode generate/poll） | 登录态 Cookie（用户主动扫码后） |
| www.bilibili.com | 登录态校验（nav）、Cookie 官方刷新链（correspond/refresh）、视频页解析、DASH 播放地址（playurl） | Cookie + 视频 BV 号 |
| api.bilibili.com | 关键词搜索（WBI 签名）、视频分 P 信息 | 搜索关键词、BV 号 |
| *.bilivideo.com（playurl 返回的 CDN） | 下载 DASH 音频流（m4s） | 仅文件下载 |
| registry.npmmirror.com | 「一键安装 ffmpeg」时下载 ffmpeg 静态二进制（77.4MB，npmmirror 镜像） | 仅文件下载 |

所有请求直连 B 站官方域名，不经过任何中间服务器；搜索已实现 WBI 签名（v0.3.1 起）。

## 文件读写

- 插件私有数据目录（`plugin-data/bili-music/`）：下载的音频（默认 `audio/`，用户可在设置改为任意目录）、`bili-cookies.json`（登录凭据）、`settings.json`（ffmpeg 路径/下载目录）、`bin/ffmpeg.exe`（一键安装产物）
- 不读写插件目录之外的任何系统位置（除用户主动在设置里选择的下载目录）

## 子进程启动

- `ffmpeg`：下载完成后 DASH m4s → m4a 转码用完即退（非常驻）。查找顺序：用户设置路径 → PATH → 常见安装目录 → 面板「一键下载并安装」的内置副本；全部候选经存在性+版本验证
- ffmpeg 参数完全由插件内部构造（输入输出路径 + 编解码参数），不来自用户自由文本输入

## 密钥处理

- B 站登录凭据（SESSDATA/bili_jct/DedeUserID/refresh_token/buvid）存于插件私有目录 `bili-cookies.json`（本机明文，与浏览器本地 Cookie 存储同级），**不发送到任何第三方、不打日志**；「退出登录」一键删除
- 凭据自动续期走 B 站官方 Web 端机制（RSA-OAEP correspondPath → cookie/refresh），公钥与流程来自社区公开文档 [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)
- 不处理任何其他 API 密钥

## 产物自包含与冒烟

- 目录内 `qrcode.js` 为内嵌第三方库 [qrcode-generator 1.4.4](https://www.npmjs.com/package/qrcode-generator)（MIT, Kazuhiko Arase），用于扫码登录的二维码渲染；`player.html` 为播放器窗口页面（隐藏 BrowserWindow 加载，本地 `<audio>` 播放）；`ui.html` 为插件面板
- 入口 index.cjs 顶层仅 `require("electron")` 与 Node 内置模块，**不 require 宿主内部模块、无动态 require、无 eval**
- 注册 6 个工具：`bili-music_search` / `bili-music_video_info` / `bili-music_playback` / `bili-music_probe_ffmpeg` / `bili-music_login_status`（safe）与 `bili-music_play`（mutation），id 均以插件 id 为前缀
- IPC 通道均为 `plugin:bili-music:*` 形式（合法字符，≤64 字符）
- `unregister` 幂等可重复调用（播放器窗口销毁 + 队列清理 + 下载中止）
- 已知限制如实披露：付费/试听/地区受限视频无音频流（`E_DASH_AUDIO_MISSING`）；单分 P 体积门禁匿名 50MiB / 登录 200MiB；无本地缓存（每次重新下载转码）

## 宿主能力依赖说明（如实披露）

聊天/工作模式点歌开箱可用（Harness 原生带工具调用）。**语音通话中点歌**需要宿主在通话期间向 LLM 传递工具列表——上游 v1.2.x 通话为"直接调 LLM 不带工具"，故该场景暂不可用；插件对此零依赖、零变更，上游未来支持后即开箱可用。README 兼容性矩阵已如实标注。

## 移植来源与协议

- 移植自 [astrbot_plugin_bili_player](https://github.com/57Darling02/astrbot_plugin_bili_player) (MIT)，保留 LLM 工具集与听歌链路，适配 Cyrene 插件 SDK
- B 站 API 调用遵循其公开接口规范，遵守 B 站用户协议；二维码渲染库 qrcode-generator (MIT)
