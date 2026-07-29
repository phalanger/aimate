# mate

本地离线运行的 3D 数字人语音伴侣。对着麦克风说话，屏幕上的 VRM 角色用克隆的音色
回应，口型跟着声音动，可以随时插话打断。全程不联网、不需要 API Key。

## 组成

```text
麦克风 -> Silero VAD -> Whisper large-v3-turbo -> Qwen3-14B -> Qwen3-TTS -> 扬声器
                                                                    |
                                                          浏览器 three-vrm 口型同步
```

## 快速开始

```powershell
I:\ai\code\mate\scripts\start-all.ps1
```

然后浏览器打开 <http://127.0.0.1:8900/>。

详细说明见 [docs/03-user-guide.md](docs/03-user-guide.md)。

## 目录

按「更新时该怎么处理它」分层：

| 路径 | 内容 | 更新时 |
| --- | --- | --- |
| `web/` | 浏览器前端（渲染、音频、字幕、录制） | 整个替换 |
| `server/` | 面板服务端：静态服务、配置 API、LLM 代理 | 整个替换 |
| `services/lipsync/` | MuseTalk 口型服务（独立 conda 环境） | 整个替换 |
| `scripts/` | supervisor 与进程表 `services.json` | 整个替换 |
| `config/` | 角色、设置、供应商、API key | **绝不能碰** |
| `assets/` | VRM、Live2D、动作、视频、参考音频 | **绝不能碰** |
| `runtime/` | 模型权重、MuseTalk 仓库、ffmpeg | 单独下载 |
| `var/` | 日志、录像、形象缓存 | 随时可删 |
| `docs/` | 分析、设计、用户指南、打包 | |
| `spike/` | 一次性验证程序（如 WebView2 麦克风探针） | |

## 文档

| 文档 | 内容 |
| --- | --- |
| [01-analysis.md](docs/01-analysis.md) | 事实核查：参考文章的方案为何已过时，硬件预算核算 |
| [02-design.md](docs/02-design.md) | 组件选型、架构、热切换设计 |
| [03-user-guide.md](docs/03-user-guide.md) | 使用、换角色、换音色、换模型、排错表 |
| [04-packaging.md](docs/04-packaging.md) | 桌面程序打包：WebView2 麦克风验证、体积实测、目录分层 |

## 本机环境的六个坑

这几条是在本机部署时实际踩到的，换机器不一定有，但都排查了很久，值得记下来。

### 1. Ollama 的工作目录决定它能否用上显卡

**这是最隐蔽的一个。** 如果从一个含有其他 ggml 二进制的目录启动 Ollama，
它的 runner 会加载到不匹配的 ggml 库，然后崩溃：

```text
GGML_ASSERT(prev != ggml_uncaught_exception) failed
llama runner terminated  error="exit status 0xc0000409"
```

对外表现具有极强的误导性——日志里显示 `total_vram="0 B"`、
`inference compute id=cpu library=cpu`，看起来像是**显卡驱动有问题**，
实际上和显卡毫无关系。

解决：从 Ollama 自己的安装目录启动它，或直接用托盘程序启动。
本项目把 `OLLAMA_HOST` 持久化为用户环境变量，让托盘程序自动绑定正确端口，
supervisor 也只对 Ollama 探活、不代为启动（`scripts\services.json` 里
`"managed": false`）。

触发这个坑的 `llama.cpp\` 目录当时就在项目根目录下，现已删除（见下一条：那些
二进制在本机根本跑不起来）。但这条仍然值得记住——任何含 ggml 二进制的目录都会
复现它。

正常时日志应该是：

```text
inference compute id=GPU-... library=CUDA compute=8.9 name=CUDA0
description="NVIDIA GeForce RTX 4090" total="24.0 GiB"
```

### 2. 导入裸 GGUF 必须自己写聊天模板

`ollama create` 一个只有 `FROM xxx.gguf` 的 Modelfile，模板会是
`TEMPLATE {{ .Prompt }}`——纯文本透传。后果是**角色和 system prompt 全部失效**，
模型开始自问自答编造整段对话，而且不报任何错。

`models\Modelfile` 里写死了 Qwen3 的 ChatML 模板。其中 assistant 标签后那个空的
think 块是 Qwen3 官方关闭思考模式的方式——不加的话模型会把推理过程当正文输出，
TTS 会一字不落地念出来。

用 `ollama show <model> --template` 可以确认模板是否正确。

### 3. 火绒会删除启动隐藏进程的脚本

火绒（`HipsDaemon`）会**直接删除**含有 `Start-Process -WindowStyle Hidden` 的
`.ps1` 文件，无提示。本项目的脚本因此不使用 `Hidden`，也不代为启动 Ollama。

注意：火绒**不是**上面 ggml 崩溃的原因——那个是工作目录问题，
在火绒全程运行的情况下改掉工作目录就恢复正常了。

### 4. Windows 保留端口占用了 11434

Ollama 默认端口 11434 落在本机的 Windows 保留端口区间 `11428-11527` 内，
直接绑定会报 `socket access forbidden`。本项目统一改用 **11700**。

查看保留区间：

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
```

### 5. ffmpeg 必须用 GPL 静态构建

`bin\ffmpeg.exe` 要用 **GPL** 版而不是 LGPL 版。LGPL 版不含 `libx264`，
MuseTalk 合成视频时用的正是 `-vcodec libx264`，会失败在：

```text
Error selecting an encoder ... Encoder not found
```

这个报错完全不提 x264，很容易误以为是路径或参数问题。验证方法：

```powershell
I:\ai\code\mate\bin\ffmpeg.exe -hide_banner -encoders | Select-String libx264
```

同时**不要**用 Anaconda 自带的那个 ffmpeg：它是 shared build，只有 0.3 MB，
依赖 `avcodec-58.dll` 等一堆同目录 DLL，脱离 Anaconda 环境就报
`0xC0000135`（找不到 DLL）。项目里放的是单文件静态构建，干净 PATH 下可独立运行。

### 6. 系统代理会拦截本地调用

本机设了 `HTTP_PROXY=http://127.0.0.1:2333` 且 `NO_PROXY` 为空，会导致流水线
访问本地 Ollama 时被绕进代理。`scripts/config.ps1` 里已经强制设置了
`NO_PROXY=127.0.0.1,localhost,::1`。

## 与参考文章的差异

本项目源于零度博客的一篇部署教程，但没有照搬它的步骤——核查后发现文章的核心前提
（"上游不支持 Qwen3-TTS 和 llama.cpp，需要自己改造"）已经不成立，上游
`huggingface/speech-to-speech` 现在原生支持这两者，文章里要手工修改的文件路径
在当前版本中都已不存在。详见 [01-analysis.md](docs/01-analysis.md)。

另外文章是纯语音方案，本项目增加了 3D 数字人形象。

## 授权提醒

声音克隆请在获得授权的前提下进行。不要未经同意克隆真人的声音，尤其是公众人物——
这在很多地区已涉及法律风险。建议使用自己的录音或公开数据集样本。
