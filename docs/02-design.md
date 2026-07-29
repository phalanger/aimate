# 设计文档：本地离线语音对话伴侣

本文档定义组件选型、目录结构、运行流程与自研模块设计。前置结论见
[01-analysis.md](./01-analysis.md)。

## 一、总体架构

四级流水线，每级独立线程，用队列串联：

```text
麦克风输入
   |
   v
[1] VAD   Silero VAD v5        判断说话起止与打断    CPU
   |
   v
[2] STT   Whisper large-v3-turbo   语音转文字        CUDA
   |
   v
[3] LLM   Qwen3-14B GGUF via llama.cpp   生成回复    CUDA
   |
   v
[4] TTS   Qwen3-TTS-1.7B-Base   文字转语音（克隆音色）  CUDA
   |
   v
扬声器输出
```

理解这四层是排错的基础：出问题时按层定位，见用户指南的排错表。

LLM 单独跑在一个 llama.cpp 进程里，通过 OpenAI 兼容协议连接。这样做的好处是
LLM 的显存占用与生命周期同主流水线解耦，换模型不必重启整个管线。

## 二、组件选型

| 层 | 选型 | 理由 |
| --- | --- | --- |
| VAD | Silero VAD v5 | 上游内置，2 MB，跑 CPU 不占显存 |
| STT | Whisper large-v3-turbo | 中文识别准确率高；默认的 Parakeet TDT 只支持 25 种欧洲语言，**不支持中文** |
| LLM | Qwen3-14B-Q6_K GGUF | 中文能力强；Q6_K 约 12 GB，24 GB 显存下留足 KV cache |
| LLM 引擎 | Ollama（端口 11700） | 同样提供 OpenAI 兼容接口；见下方说明 |
| TTS | Qwen3-TTS-12Hz-1.7B-Base | 支持 3 秒音色克隆，Apache 2.0，首包延迟低 |

STT 的选择是本项目区别于上游默认配置的关键一点：上游默认 `parakeet-tdt` 完全不认中文，
直接用默认值会得到空转录，而且日志上不会明确报错——这是最容易误判为「麦克风坏了」的陷阱。

### 为什么用 Ollama 而不是 llama.cpp

设计初稿用的是文章推荐的 `llama-server`，实测发现本机上**所有预编译的 llama.cpp
二进制都无法运行**：`--version` 即触发访问违例（`0xC0000005`），CUDA 版和 CPU 版
表现一致，用户此前已有的 `I:\ai\code\llamapp` 那份同样如此。

根因是火绒主动防御破坏了基于 ggml 的进程。同一根因也影响 Ollama——它的 GPU 探测
子进程崩溃后会误判显存为 `0 B` 并回退到 CPU。把相关目录加入火绒信任区后，Ollama
可正常工作。

选 Ollama 而非继续排查 llama.cpp 的理由：用户机器上本就装有 Ollama 并存有十余个
模型，且它对外提供的同样是 `/v1/chat/completions`，对流水线而言两者可以互换，
换掉引擎不影响架构。已下载的 GGUF 通过 `models/Modelfile` 直接导入，无需重新下载。

TTS 模型分两档使用：

- **CustomVoice**（`Qwen3-TTS-12Hz-1.7B-CustomVoice`）：预设音色，无需参考音频。
  用于跑通全链路、验证环境。
- **Base**（`Qwen3-TTS-12Hz-1.7B-Base`）：声音克隆，需参考音频 + 参考文本。
  用于最终形态。

## 三、目录结构

```text
I:\ai\code\mate\
├── docs\
│   ├── 01-analysis.md          分析文档
│   ├── 02-design.md            本文档
│   └── 03-user-guide.md        用户指南与排错表
├── models\
│   ├── qwen3-tts-base\         Qwen3-TTS 克隆模型
│   ├── qwen3-tts-custom\       Qwen3-TTS 预设音色模型
│   └── *.gguf                  LLM 权重
├── voices\
│   └── *.wav                   参考音频（5-10 秒，单声道，24 kHz）
├── panel\
│   ├── characters.json         人格与音色配置
│   ├── registry.py             热切换服务
│   └── index.html              面板前端
├── scripts\
│   ├── start-llm.ps1           启动 llama-server
│   ├── start-mate.ps1          启动主流水线
│   └── start-all.ps1           一键启动
├── logs\
└── llama.cpp\                  llama-server 可执行文件
```

Python 运行环境为独立的 conda 环境 `s2s`（Python 3.11），不污染 Anaconda base。

## 四、运行流程

启动分三个进程，顺序不可颠倒：

1. **llama-server**（端口 8080）——先启动。加载 GGUF 模型需 10–30 秒。
   必须先用 `curl` 验证 `/v1/chat/completions` 有 JSON 返回，再进行下一步。
   这一步不通就往下走，会把 LLM 的问题误判成 TTS 的问题。
2. **热切换面板**（端口 8900）——提供人格与音色配置。
3. **speech-to-speech 主流水线**——加载 Whisper 与 Qwen3-TTS 并占用麦克风。

主流水线的关键参数（Windows 专用项已标注）：

```text
--mode local                                    直接用本机麦克风与扬声器
--stt whisper                                   中文必须，不能用默认 parakeet-tdt
--stt_model_name openai/whisper-large-v3-turbo
--language zh
--llm_backend chat-completions                  指向 llama.cpp
--responses_api_base_url http://127.0.0.1:8080/v1
--responses_api_api_key ""                      llama-server 不校验，留空即可
--tts qwen3
--qwen3_tts_backend torch                       Windows 必须，ggml 后端在 Windows 不可用
--qwen3_tts_ref_audio voices\xxx.wav            声音克隆
--qwen3_tts_ref_text "参考音频的逐字转录"
--qwen3_tts_xvec_only                           起音更干净，语言切换更稳
--thresh 0.4                                    VAD 灵敏度，需按自己麦克风实测微调
```

## 五、热切换面板设计

这是上游唯一没有、需要自研的模块。

### 5.1 要解决的问题

上游的人格（system prompt）和音色（参考音频）都是启动参数，改一次要重启整个管线，
而重启意味着重新加载 Whisper 与 TTS 模型，等十几秒。面板的目的是让这两项在运行中即时生效。

### 5.2 切换代价分层

不同切换项的代价差异很大，设计上要区别对待：

| 切换项 | 实现方式 | 代价 |
| --- | --- | --- |
| 人格 | 替换 system prompt | 即时生效 |
| 音色 | 替换参考音频，TTS 模型常驻显存 | 即时生效 |
| LLM 模型 | llama.cpp 卸载重载 | 数十秒 |

### 5.3 配置格式

`panel/characters.json` 定义角色，每个角色绑定音色、参考文本、LLM 与人格：

```json
{
  "characters": {
    "example": {
      "label": "示例角色",
      "ref_audio": "voices/example.wav",
      "ref_text": "参考音频的逐字转录文本",
      "llm_model": "qwen3-14b",
      "system_prompt": "..."
    }
  }
}
```

### 5.4 system prompt 的硬性约束

这不是可选的润色项，而是决定体验成败的必需项。大模型默认会输出 Markdown、
编号列表、emoji 和括号动作描写，而 TTS 会把这些**逐字读出来**，
听感上是「一、点、我很开心、括号、轻轻笑了笑、括号」。

因此每个角色的 system prompt 必须包含以下规则：

1. 每次回复不超过两句话，总共不超过 40 字。
2. 用日常口语，不用书面语。禁止 Markdown、列表、编号。
3. 禁止输出任何 emoji、颜文字、括号内的动作描写。
4. 不要复述问题，直接回应。
5. 数字用中文写（说「三点」不说「3点」），否则语音合成会读错。

第 1 条最关键。不限长度时模型会输出整段文字，TTS 一读就是三十秒，
这是语音对话体验崩掉的首要原因——用户无法插话，交互退化成单向播报。

### 5.5 编码约束

按 CLAUDE.md 第 3 条，`panel/registry.py` 等 Python 源码文件只含 ASCII 字符，
中文内容一律放在 `characters.json` 数据文件与文档中。

## 六、画中画、字幕与录制

### 6.1 画中画的位置由人定，不由代码猜

头部特写该放哪，取决于模型的构图、当前的取景和用户在干什么，这三样代码都不知道。
所以不做自动避让，改成可拖动、可缩放，位置存 localStorage。

唯一的自动行为是**载入时把窗口拉回可见区域**：上次的位置是按当时的窗口尺寸存的，
窗口变小后可能落到画面外，而落到画面外就再也拖不回来了。同样的钳制也挂在 resize 上。

尺寸限制 120–520 像素，且不超过画面短边的 60%。下限是「还能看清口型」，上限是
「还算画中画，而不是盖住主画面的第二个舞台」。

### 6.2 字幕时长按字数分摊

流水线里没有任何一层提供词级时间戳——TTS 返回的是音频，不是对齐结果。要做逐字
高亮就得再引入一个强制对齐模型，代价与收益不成比例。

折中方案：按标点断句，每句按字数占比分摊总时长。按字数而不是平均分，是因为
一个语气词和一个完整从句读起来不一样长，平均分会让短句干等、长句赶场。

总时长有两个来源：

| 时机 | 总时长 | 精度 |
| --- | --- | --- |
| 直播中，回复刚生成出文字 | 按语速估算 | 近似 |
| 该条 `response.done` 之后 | 音频字节数换算 | 准确，会重排一次 |
| 重播 | 缓存音频的字节数 | 从第一帧就准确 |

推进字幕用的是**已播放的采样数**，和生成画面用的是同一个时钟。用自己的定时器会
和两者都漂开。

### 6.3 高亮复用动作关键词

字幕高亮和动作选择用同一份 `panel/motions.json`。能挑出一个动作的词，就是值得
强调的词；分成两份列表只会各自漂移。

两条过滤规则：标了 `"emphasis": false` 的规则不参与高亮（「可能」「嗯」这类是语气词），
单字关键词不参与高亮（中文里太容易夹在别的词中间）。

### 6.4 录制走屏幕捕获，不走各渲染器自己导出

五种显示方式产生画面的方式完全不同：WebGL、pixi、解码视频帧、生成的 JPEG 序列。
让每种自己实现导出就是五份实现。改成统一把**它已经画好的东西**逐帧拷进一张录制
canvas，是一份实现，而且顺带让本来「做不到」的圆环、2D、3D 也能保存。

代价是录制必须实时进行：画面只在被画出来的那一刻存在。所以保存 = 重播一遍 + 录下来，
耗时等于回复本身的长度，但不消耗任何模型时间。

音频从 `MediaStreamAudioDestinationNode` 取，只含她的声音，不含麦克风，也不含
机器上别的动静——录系统输出会把通知音和别的标签页一起录进去。

### 6.5 为什么还要过一遍 ffmpeg

浏览器只能录出 WebM，而 MediaRecorder 根本不能写字幕轨。要带字幕就必须再封装一次。
这一步顺带做两件事：VP9 转 H.264（很多桌面播放器不认 WebM 里的 VP9），以及把
可变帧率钉成 25 fps（MediaRecorder 输出的是变帧率且起始时间任意）。

字幕用 ASS 而不是 SRT：SRT 完全不携带样式，字体、字号和关键词颜色会全部丢失，
而和画面上看到的一致正是保存字幕的意义所在。

ffmpeg 的工作目录设成任务目录，字幕脚本用裸文件名传给 `ass=` 滤镜。滤镜参数里
冒号和反斜杠都是语法，Windows 绝对路径（`C:\...`）会被当成语法解析而不是路径。

### 6.6 录制的字幕在开始时就取快照

回合结束会清掉字幕（否则文字会留在画面上），而上传发生在那之后。所以字幕轨在
**开始录制时**就取好快照，不在上传时去读。

## 七、实施顺序

先跑通、再增强，每步都有独立的验证点：

1. 环境与依赖安装，验证 `torch.cuda.is_available()`。
2. llama-server 启动，`curl` 验证接口。
3. 用 CustomVoice 预设音色跑通全链路——**这是排错基准线**，
   跳过这步，后面出问题分不清是硬件、依赖还是配置。
4. 接入参考音频，切到 Base 模型做声音克隆。
5. 接入热切换面板。
6. 封装启动脚本，补齐用户指南。
