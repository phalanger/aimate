# 打包成桌面程序

目标：一个绿色包，解压后双击 exe 就是一个桌面程序，不用手动开三个窗口、不用记
启动顺序。

本文记录已经验证的结论、还没验证的部分，以及为此需要的目录调整。

## 一、麦克风验证（已完成）

**结论：Tauri 方案可行。嵌入式 WebView2 在我们关心的每一项上都和 Chrome 表现完全
一致。**

这是打包路线上唯一可能推翻整个方案的未知数，所以先验了它。Tauri 在 Windows 上用
WebView2，而 [tauri#5042](https://github.com/tauri-apps/tauri/issues/5042)、
[#10898](https://github.com/tauri-apps/tauri/issues/10898) 这些 issue 说明媒体权限
在这一层是有坑的。

### 怎么验的

`spike\webview-mic\` 是一个最小的 Rust 程序，用 **wry**（Tauri 用来创建 WebView2
的那个 crate）开一个窗口，指向 `spike\mic-probe\` 提供的探针页面。用 wry 而不是
完整 Tauri，是因为 WebView2 实例就是在这一层创建的，权限行为走的是同一条代码路径，
而这样不需要 Tauri CLI、前端打包器和 node 工具链。

探针页面逐项上报，服务端打印并落盘。**关键设计是同一个页面也用普通 Chrome 跑一遍
做对照**——没有对照组的话，任何失败都分不清是 WebView2 的限制还是这台机器的状况。

### 结果

| 检查项 | WebView2（wry/Tauri） | Chrome（对照） |
| --- | --- | --- |
| isSecureContext | true | true |
| navigator.mediaDevices | 存在 | 存在 |
| AudioWorklet | 支持 | 支持 |
| MediaRecorder | 支持 | 支持 |
| canvas.captureStream | 支持 | 支持 |
| 音频输入设备数 | 0 | 0 |
| getUserMedia | NotFoundError | NotFoundError |

**两边逐项相同。**

三个直接可用的结论：

1. **`http://127.0.0.1` 在嵌入式 WebView2 里确实是安全上下文。**这一条不是理所当然
   的——不满足的话 `navigator.mediaDevices` 会直接是 `undefined`，麦克风根本无从谈起。
2. **AudioWorklet、MediaRecorder、canvas.captureStream 全都支持**，也就是说面板的
   全部功能，包括新做的字幕和保存视频，在桌面壳里都能用。
3. **报的是 `NotFoundError`（没有设备）而不是 `NotAllowedError`（权限被拒）。**
   这是最关键的一条：WebView2 没有拦这个请求，它是走到设备枚举才失败的。

### 还没验证的部分

这台机器**没有可用的采集设备**（Chromium 枚举到 0 个，Chrome 也是 0 个），所以
**权限授权弹窗那一步没有被触发到**，严格说还没被证明。

但这不是 Tauri 的风险，因为 Chrome 在同一台机器上表现一模一样。既然两个引擎行为
一致，判断是：**以后插上麦克风，只要在 Chrome 里能用，在 Tauri 里就能用。**

拿到麦克风后重跑一遍即可，spike 留在仓库里：

```powershell
# 一个窗口开探针服务，另一个窗口开 WebView2
D:\Apps\anaconda3\envs\s2s\python.exe spike\mic-probe\probe_server.py
cargo run --manifest-path spike\webview-mic\Cargo.toml
```

真到了需要处理权限的那天，做法是在 Rust 侧接管 WebView2 的
`PermissionRequested` 事件，对自己的 origin 直接 Allow。

### 一个必须记住的架构约束

**Tauri 的 webview 要直接指向 `http://127.0.0.1:8900`，不要把前端打进 Tauri 的
asset 协议。**

- 前端本来就要访问 `/api/*`，同源就不用配 CORS
- `http://127.0.0.1` 是安全上下文，麦克风和 AudioWorklet 都满足
- **最关键**：`ws://127.0.0.1:8765` 和页面同为 http 方案。如果走 Tauri 默认的
  `https://tauri.localhost`，这个 ws 连接会被当成混合内容**直接阻断**，语音链路
  当场就断了

## 二、体积

完全自包含要多大，实测：

| 组成 | 大小 |
| --- | --- |
| s2s conda 环境 | 5.4 GB |
| musetalk conda 环境 | 5.8 GB |
| models\（Qwen3-14B GGUF 约 11 GB + TTS 4.5 GB） | 15.5 GB |
| musetalk\ 权重 | 7.7 GB |
| ffmpeg | 0.3 GB |
| **合计** | **约 35 GB** |

所以"解压双击"能做到，但不是几十 MB 那种绿色包。

**分层方案**（本地大模型设为可选，默认用云端）：

| 档位 | 含什么 | 大小 |
| --- | --- | --- |
| 基础 | 壳 + 前端 + 服务端 + s2s 环境 + TTS + Whisper + ffmpeg | 约 12 GB |
| 加本地大模型 | 再加 Qwen3-14B GGUF + Ollama | 约 23 GB |
| 加真人口型 | 再加 musetalk 环境和权重 | 约 35 GB |

代码本身（壳 + 前端 + 服务端）大约 10 MB，其余全是运行时和权重，首次启动时按用户
选的档位下载。

## 三、目录调整

现在最要命的一点：**用户数据和代码混在一起**。

`panel\characters.json`、`settings.json`、`llm.json`（存着 API key）就躺在
`panel\js\` 旁边，`panel\models\` 和 `panel\media\` 里是用户自己放的 VRM、立绘和
视频。**更新程序 = 覆盖 panel 目录 = 角色、设置、素材全丢。**

这个问题现在就存在，和打不打包无关。

按"更新时怎么处理"来分层：

```text
mate/
├─ web/          前端（html/css/js/worklets/vendor）   更新时整个替换
├─ server/       面板服务端（server.py 等）            更新时整个替换
├─ services/     lipsync 等自研服务                    更新时整个替换
├─ supervisor/   进程表和 supervisor.py                更新时整个替换
├─ config/       角色、设置、供应商、API key           ← 绝不能碰
├─ assets/       VRM、立绘、视频、音色                  ← 绝不能碰
├─ runtime/      python 环境、ffmpeg、模型权重          ← 单独下载
├─ var/          logs、recordings、cache                ← 随便删
├─ spike/        验证用的一次性程序
└─ docs/
```

配套要改的：

1. `server.py` 把 `web\` 作为文档根，把 `assets\` 挂到 `/assets/` 路径下（现在是
   靠把素材放进被服务的目录里才能被浏览器取到）。
2. `characters.json` 里的路径迁移一次：`models/x.vrm` → `assets/models/x.vrm`。
3. `services.json`、启动脚本、文档里的路径同步更新。
