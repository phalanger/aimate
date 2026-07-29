# 用户指南

本地离线运行的 3D 数字人语音伴侣。四个模型串成一条流水线，全程不联网、不需要
API Key，对话内容不出本机。

## 一、快速启动

**双击 `mate.exe`**（在项目根目录）。它会启动全部服务、等面板就绪、然后显示界面；
**关掉窗口就停掉一切**。窗口里 **F5 刷新**、**F12 开检查器**。

第一次要先编译一下外壳（需要 Rust）：

```powershell
I:\ai\code\mate\scripts\build-shell.ps1
```

给 `mate.exe` 的参数会原样转给 supervisor，例如 `.\mate.exe --skip lipsync,voice`
只起面板、完全不碰显卡。

### 或者用命令行启动

想看实时日志、或者不想编译外壳，就直接跑：

```powershell
I:\ai\code\mate\scripts\start-all.ps1
```

一个窗口、一份合并日志，看到 `Open http://127.0.0.1:8900/` 就可以开了。
**Ctrl+C 会把所有服务一起停掉**，包括子进程。

点「开始对话」，允许麦克风权限，就可以直接说话了。

首次启动会自动下载 Whisper large-v3-turbo（约 1.6 GB），需要等几分钟。

### supervisor

启动由 `scripts\supervisor.py` 统一管理，进程表在 `scripts\services.json` 里——
那是唯一的事实来源，`start-*.ps1` 现在都只是它的薄封装，不再各自持有一份启动参数。

它做这几件事：

- 按依赖顺序启动（语音流水线要等面板起来，因为它启动时会做一次预热的 LLM 调用）
- **探活而不是 sleep**：探到端口/接口真的响应了才继续
- 日志按服务加前缀、上色，合并到一个窗口，同时分别落到 `var\logs\<服务>.log`
- 崩溃自动重启，退避 2/5/15 秒，两分钟内超过三次就放弃并告诉你去看哪个日志
- 端口已经被占用时**接管而不是报错**——面板已经在跑就不重复启动
- Ctrl+C 按依赖倒序停止，用 `taskkill /T` 连孙进程一起收掉（torch 会起 worker，
  漏掉的话下次启动会撞上「端口被占用」）

常用参数：

```powershell
scripts\start-all.ps1 --list          # 只看进程表，不启动
scripts\start-all.ps1 --skip lipsync  # 不要口型服务
scripts\start-all.ps1 --no-restart    # 崩了就崩了，方便看现场
scripts\start-panel.ps1               # 等价于 --only panel
```

`--only` 会自动把依赖捎上：`--only voice` 实际启动的是 panel + voice。

## 二、系统组成

四层流水线，出问题时按这个顺序定位：

| 层 | 组件 | 跑在哪 | 作用 |
| --- | --- | --- | --- |
| 1 VAD | Silero VAD v5 | CPU | 判断你什么时候说完 |
| 2 STT | Whisper large-v3-turbo | GPU | 语音转文字 |
| 3 LLM | Qwen3-14B-Q6（Ollama） | GPU | 生成回复 |
| 4 TTS | Qwen3-TTS-1.7B-Base | GPU | 文字转语音（克隆音色） |

前端是浏览器里的 three.js + three-vrm，渲染 VRM 3D 角色，用实际播放的音频包络
驱动口型。

**注意 VAD、STT、TTS 是同一个进程里的三个线程，不是三个服务。**下面这张表才是
实际在跑的进程：

| 进程 | 端口 | 谁管 | 为什么单独一个进程 |
| --- | --- | --- | --- |
| 面板服务器 | 8900 | supervisor | 界面是网页，总得有东西可连 |
| speech-to-speech | 8765 | supervisor | 同上（四层流水线都在它里面） |
| MuseTalk 口型 | 8930 | supervisor（可选） | torch 2.0.1+cu118 vs 2.9.1+cu128，连 Python 版本都不同，没法共用解释器 |
| Ollama | 11700 | **它自己的托盘** | 外部程序；supervisor 只探活不接管 |

Ollama 不由 supervisor 启动是有原因的：它必须从自己的安装目录启动，从本项目目录
启动会让它加载到冲突的 ggml 库并崩溃。

Ollama 用 11700 而不是默认的 11434，因为本机 11428–11527 落在 Windows 保留端口
区间里，用默认端口会报 `socket access forbidden`。`OLLAMA_HOST` 已持久化为用户
环境变量，托盘程序会自动绑定这个端口。

**Ollama 必须从它自己的安装目录启动**（托盘程序即可）。从本项目目录启动会让它
加载到冲突的 ggml 库并崩溃，日志表现为显存 `0 B`、回退 CPU——看起来像显卡故障，
其实不是。详见 README 的坑之一。

## 三、换角色与换人格

编辑 `config\characters.json`，照着已有的复制一份即可。每个角色包含：

| 字段 | 说明 |
| --- | --- |
| `label` / `subtitle` | 面板上显示的名字与副标题 |
| `vrm` | VRM 模型路径，相对于 `assets\` 目录 |
| `voice` | 参考音频的**绝对路径**，由服务端读取 |
| `ref_text` | 参考音频的逐字转录，必须和音频内容一致 |
| `emotion` | 待机表情：`neutral` / `happy` / `sad` / `angry` / `relaxed` |
| `system_prompt` | 人格设定 |

在面板上点角色即可切换，**人格和音色都是即时生效的，不用重启**——TTS 模型常驻显存，
切换只是下发一条 `session.update`。换 VRM 模型需要重新加载几秒。

### system_prompt 里那五条规则不能删

每个角色的 prompt 末尾都有五条说话规则。这不是啰嗦，是必需的：

大模型默认会输出 Markdown、编号列表、emoji 和「（轻轻笑了笑）」这类动作描写，
而 TTS 会把这些**逐字读出来**。你会听到她一本正经地念「一、点、我很开心、括号、
轻轻笑了笑、括号」。

五条规则里第一条最关键——不限制长度的话，模型会输出一大段，TTS 一读就是三十秒，
这期间你插不上话，对话就退化成了单向播报。

## 四、换成你自己的音色

Qwen3-TTS 靠一段参考音频克隆音色。音频质量直接决定听起来像真人还是像机器人。

参考音频要求：

- 5–10 秒（超过 15 秒效果反而变差）
- 纯净人声，无背景音乐、无混响、无杂音
- 单声道，24 kHz 以上，wav 格式
- 语气要接近你想要的效果——参考音频平淡，克隆出来就平淡

用 ffmpeg 从任意音频裁一段：

```powershell
ffmpeg -i 原始音频.mp3 -ss 00:00:12 -t 8 -ac 1 -ar 24000 I:\ai\code\mate\assets\voices\xiaoman.wav
```

参数含义：`-ss 00:00:12` 从第 12 秒开始，`-t 8` 截取 8 秒，`-ac 1` 转单声道，
`-ar 24000` 采样率 24 kHz。

然后改两个地方，**必须成对修改**：

1. `config\characters.json` 里该角色的 `voice` 指向新 wav，`ref_text` 改成这段音频的
   逐字转录。
2. 如果要改默认音色，同时更新 `scripts\config.ps1` 里的 `$Global:RefAudio` 和
   `$Global:RefText`。

`ref_text` 和音频对不上会明显影响克隆质量，这是最容易忽略的一步。

> **授权提醒**：三秒克隆音色这个能力很强，也很容易被滥用。不要未经同意克隆真人的
> 声音，尤其是明星、主播或身边的人——这在很多地区已涉及法律风险。建议用自己录的
> 音频，或公开数据集的样本。

## 五、换 3D 形象

当前用的是 three-vrm 官方示例模型 `assets\models\sample.vrm`，只是个测试用的素模。

换成你想要的角色：

1. 从 [VRoid Hub](https://hub.vroid.com/) 下载 VRM 模型，或用
   [VRoid Studio](https://vroid.com/studio) 自己捏一个（免费，导出 VRM）。
2. 放进 `assets\models\`。
3. 改 `characters.json` 里该角色的 `vrm` 字段。

VRM 0.x 和 1.0 两种规范都支持，代码里已经做了朝向归一化处理。

口型同步靠的是 VRM 的 `aa`/`ih`/`ou`/`ee`/`oh` 五个表情通道，眨眼靠 `blink`。
如果你的模型没有定义这些表情，嘴就不会动——这是模型本身的问题，不是代码问题。

## 六、界面：画中画、字幕与保存视频

主画面右上角有四个图标，它们不在右侧栏里，因为右侧栏可以整个收起来：

| 图标 | 作用 |
| --- | --- |
| ↻ | 重播上一条回复（用缓存的音频和画面，不重新生成） |
| ⤓ | 把上一条回复保存成视频 |
| ⚙ | 打开设置 |
| ☰ | 显示/隐藏右侧栏 |

右侧栏的显示状态记在浏览器里，下次打开保持不变。

### 画中画（头部特写）

左上角那个小窗口显示头部特写，主画面看全身动作，特写看口型。

- **拖动窗口本身**可以移到任意位置
- **拖右下角**可以缩放，范围 120–520 像素，且不会超过画面短边的 60%
- **双击**恢复默认位置和大小

位置和大小记在浏览器里，下次打开复位。窗口缩小后如果特写跑到画面外，下次打开
会自动拉回可见区域——否则就再也拖不回来了。

开关和放大倍数在「设置 → 口型同步」里。真人素材默认不显示特写：一张悬浮的人脸
裁剪看着像故障，而且逐帧裁剪会和视频解码抢主线程。

### 字幕

在「设置 → 字幕」里调字体、字号、颜色、描边、位置。字号按画面高度的百分比算，
换窗口大小或分辨率都不用重调。

**关键词高亮**用的是 `web\motions.json` 里那份情绪关键词——和动作选择同一份规则，
改一处两处都变。加了 `"emphasis": false` 的规则只参与动作选择，不参与高亮（像
「可能」「嗯」这种语气词，标出来反而乱）。单个字的关键词也不参与高亮，因为在中文里
太容易夹在别的词中间。

断句时长是**按字数分摊**的，不是真的逐字对齐——流水线里任何一层都没有词级时间戳，
TTS 只返回音频。回复只有一两句时这个近似足够准。直播时她还在生成，总时长未知，
先按语速估算，等这一条生成完再按真实长度重排一次；重播因为长度已知，从第一帧就是
准的。

### 保存视频

点 ⤓ 会**把上一条回复重播一遍并录下来**，所以耗时和这条回复本身一样长。录制中图标
变成 ■，再点一次取消。文件写到 `var\recordings\`。

五种显示方式**都能保存**，包括圆环、2D 和 3D——录的是画面本身，谁画的不重要。

「设置 → 保存视频」里选字幕保存方式：

| 方式 | 容器 | 说明 |
| --- | --- | --- |
| 字幕轨 | MKV | ASS 格式，保留字体和颜色，播放器里可开关。有的播放器默认不打开字幕 |
| 烧进画面 | MP4 | 字幕成为画面的一部分，发到哪都能看见 |
| 不要字幕 | MP4 | |

字幕总开关关掉时，保存出来一律不带字幕——界面上藏起来的东西不应该留在文件里。

浏览器只能录出 WebM，而且 MediaRecorder 根本不能写字幕轨，所以服务端会用 ffmpeg
重新封装一次。这一步同时把 VP9 转成 H.264，否则很多桌面播放器打不开。

## 七、排错

按流水线的四层顺序排查，一查一个准。

| 现象 | 大概率原因 | 怎么修 |
| --- | --- | --- |
| `does not have a file named speech_tokenizer/config.json` | TTS 模型目录不完整 | 见下方「TTS 模型目录结构」 |
| 面板打不开 | 面板服务器没启动 | 跑 `scripts\start-panel.ps1` |
| 点「开始对话」报麦克风错误 | 浏览器没给权限 | 地址栏左侧允许麦克风，刷新页面 |
| 报连不上语音服务 | 语音流水线没起来 | 跑 `scripts\start-voice.ps1`，看有没有报错 |
| 说话完全没反应 | VAD 阈值太高 | `start-voice.ps1` 里 `--thresh` 从 0.4 降到 0.3 |
| 环境噪音也能触发 | VAD 阈值太低 | `--thresh` 升到 0.5 |
| 识别出文字但没有回复 | Ollama 没通 | 跑 `scripts\start-llm.ps1`，它会自检并打印回复 |
| 有回复文字但没声音 | 参考音频路径错 | 检查 `characters.json` 里 `voice` 的绝对路径是否存在 |
| 中文识别成英文或空白 | STT 用了 parakeet | 确认 `--stt whisper`，默认的 parakeet 不支持中文 |
| 她把 markdown 和括号念出来 | system_prompt 规则被删了 | 补回那五条规则 |
| 她一口气说三十秒 | 没限制回复长度 | 检查规则第一条还在不在 |
| `CUDA out of memory` | 显存不够 | 关掉其他占显存的程序，或换更小的模型 |
| 嘴不动但有声音 | VRM 模型没有口型表情 | 换一个定义了 `aa`/`ih`/`ou`/`ee`/`oh` 的模型 |
| 她自己打断自己 | 回声消除失效 | 戴耳机；或确认浏览器允许了回声消除 |
| 第一句话卡几秒 | 模型预热 | 正常现象，第二句起就快了 |
| 保存视频的图标不见了 | 浏览器不支持 canvas 录制 | 用 Chrome 或 Edge |
| 保存报 ffmpeg failed | `bin\ffmpeg.exe` 是 LGPL 版，没有 libx264 | 换 GPL 静态版，见 README |
| 保存出来的 MKV 看不到字幕 | 播放器默认没打开字幕轨 | 播放器里手动打开，或改用「烧进画面」 |
| 烧进画面的字幕是方块 | 系统里没装所选字体 | 换个已装的字体，或装上思源黑体 |
| 字幕和语音对不上 | 断句时长是按字数估的 | 回复越长偏差越明显，属已知近似 |
| 画中画拖没了 | 拖到了画面外 | 刷新页面会自动拉回；或双击恢复默认 |

### TTS 模型目录结构

Qwen3-TTS 不只需要根目录的权重，还需要一个 `speech_tokenizer/` 子目录。
只下载根目录文件会在加载时报 `does not have a file named
speech_tokenizer/config.json`。完整结构：

```text
runtime\models\qwen3-tts-base\
├── config.json
├── configuration.json
├── generation_config.json
├── preprocessor_config.json
├── tokenizer_config.json
├── merges.txt
├── vocab.json
├── model.safetensors            3.86 GB
└── speech_tokenizer\
    ├── config.json
    ├── configuration.json
    ├── preprocessor_config.json
    └── model.safetensors         682 MB
```

补下载缺失的子目录：

```powershell
$ms = "https://www.modelscope.cn/models/Qwen/Qwen3-TTS-12Hz-1.7B-Base/resolve/master/speech_tokenizer"
$dst = "I:\ai\code\mate\runtime\models\qwen3-tts-base\speech_tokenizer"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($f in "config.json","configuration.json","preprocessor_config.json","model.safetensors") {
    curl.exe -L -o "$dst\$f" "$ms/$f"
}
```

### 调 VAD 的建议

`--thresh` 在 0.35–0.45 之间试。这个一定要在你自己的麦克风上实测调整，
每个人的收音环境差别很大。

### 关于显存

四个模型同时驻留显存约需 18 GB。24 GB 的卡跑得下，但如果同时开着别的
AI 程序（比如 DFL、Stable Diffusion）就会不够。用 `nvidia-smi` 查当前占用：

```powershell
nvidia-smi --query-gpu=memory.used,memory.free --format=csv
```

## 八、已知限制

- **实时字幕**：上游的 live transcription 是为 parakeet-tdt 设计的，中文用
  Whisper 时可能没有流式partial 字幕，但最终字幕正常。
- **打断**：靠浏览器的回声消除工作。用外放且音量很大时，可能出现她把自己的
  声音当成你在说话。戴耳机可彻底避免。
- **llama.cpp**：本机上预编译的 llama-server 二进制无法运行（`--version`
  即崩溃，CUDA 版和 CPU 版都一样），所以 LLM 走 Ollama。这不影响功能，
  两者提供的都是 OpenAI 兼容接口。那两份二进制已从项目里删除。
- **保存视频是实时录制**：没有更快的路径——画面只在被画出来的那一刻存在，而真人
  和真人口型两种方式下它是解码出来的视频帧，从来没有以帧的形式留在我们手里。
- **字幕时长是估算的**：按标点断句、按字数分摊时长。流水线里没有任何一层提供词级
  时间戳，要做到逐字对齐得再引入一个强制对齐模型。
- **字幕轨里的字体**：ASS 只能指定一个字体名，播放时由播放器在本机字体里找。设置里
  那几个选项是 CSS 字体族（有回退链），保存时只取第一个名字。
