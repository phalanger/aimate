# 分析文档：本地离线语音对话伴侣

本文档记录部署前的事实核查结论。所有结论均来自对上游仓库源码和包索引的实际查询，而非推测。

核查日期：2026-07-27。

## 一、需求来源

参考文章：零度博客《完全本地运行的「赛博 AI 女友」保姆级部署教程》（2026-07-26）。

文章描述的目标形态：

- 对着麦克风说话，无需打字
- 用指定音色回应，3 秒音频即可克隆音色
- 可随时打断，接近真人对话节奏
- 完全离线，断网可用，无数据外传
- 可热切换人格与音色，无需重启

这些目标本身有效，本项目照此实现。

## 二、关键发现：文章方案已过时

文章的核心工作量建立在一个前提上：

> 底座项目是 HuggingFace 官方的开源项目 speech-to-speech。但要注意：原版不支持
> Qwen3-TTS，也不支持 llama.cpp，这两块需要我们自己改造。

**这个前提已不成立。** 实际核查结果：

| 文章的说法 | 上游 `huggingface/speech-to-speech` 实际状态 |
| --- | --- |
| 原版不支持 Qwen3-TTS | Qwen3-TTS 已是**默认** TTS 后端（`--tts qwen3`） |
| 原版不支持 llama.cpp | 原生支持 `--llm_backend chat-completions` 指向 llama.cpp |
| 需自行编写 `TTS/qwen3_tts_handler.py` | 上游已存在 `src/speech_to_speech/TTS/qwen3_tts_handler.py`（903 行） |
| 需手工修改 `s2s_pipeline.py` 三处 | 该文件已移至 `src/speech_to_speech/`，无需修改 |
| `pip install -r requirements.txt` | 仓库已无 `requirements.txt`，改用 `pyproject.toml` |
| `python s2s_pipeline.py --mode local ...` | 改为 `speech-to-speech --mode local ...` 命令行入口 |
| `--llm open_api --open_api_base_url` | 参数已更名为 `--llm_backend` / `--responses_api_base_url` |
| 用 `--tts melo` 先跑通原版 | MeloTTS 已移入 `archive/`，不再接入 CLI |

仓库当前版本 `0.2.11`，包结构为 `src/speech_to_speech/`，通过 `pip install speech-to-speech`
安装即可，`melo_handler.py` 与 `parler_handler.py` 均已归档。

**结论**：按文章步骤逐字操作会在第 2 步（`pip install -r requirements.txt`）就失败，
后续所有改造步骤针对的文件路径均不存在。本项目改为直接使用上游原生能力。

## 三、文章功能到上游参数的映射

文章要求自行编写的改造代码，绝大部分对应上游已有参数：

| 文章的改造目标 | 上游对应参数 |
| --- | --- |
| Qwen3-TTS 接入 | `--tts qwen3`（默认） |
| 3 秒音色克隆 | `--qwen3_tts_ref_audio` + `--qwen3_tts_ref_text` |
| 克隆起音干净、支持语言切换 | `--qwen3_tts_xvec_only` |
| 接 llama.cpp 本地大模型 | `--llm_backend chat-completions` + `--responses_api_base_url` |
| 不校验 API Key | `--responses_api_api_key ""` |
| 中文语音识别 | `--stt whisper --stt_model_name openai/whisper-large-v3-turbo` |
| VAD 灵敏度调节 | `--thresh` / `--min_speech_ms` / `--min_silence_ms` |
| 随时打断 | realtime 模式内置，`interrupt_response` |

唯一上游确实没有的是**人格与音色热切换面板**（文章的 `voice_registry.py` +
`characters.json` + 8900 端口面板）。这部分需要自行实现，见设计文档。

## 四、Windows 平台的关键差异

上游 `pyproject.toml` 第 50–51 行对 Windows 有专门处理：

```toml
"faster-qwen3-tts[ggml]>=0.3.2; platform_system != 'Darwin' and platform_system != 'Windows'",
"faster-qwen3-tts>=0.3.2; platform_system == 'Windows'",
```

即 **Windows 上不安装 `[ggml]` 额外依赖**，GGML 后端不可用。而上游默认
`--qwen3_tts_backend ggml`，因此在 Windows 上**必须显式传 `--qwen3_tts_backend torch`**，
否则 TTS 初始化会失败。文章与上游 README 均未覆盖这一点（README 的 CUDA 说明只针对 Linux）。

其余依赖的 Windows 可用性已逐一核实：

| 包 | 版本 | Windows / Python 3.11 可用性 |
| --- | --- | --- |
| `speech-to-speech` | 0.2.11 | 纯 Python wheel，可用 |
| `faster-qwen3-tts` | 0.3.2 | 纯 Python wheel，可用 |
| `nano-parakeet` | 0.2.1 | 纯 Python wheel，可用 |
| `lingua-language-detector` | 2.1.1 | 有 `cp311-win_amd64` wheel |

`lingua-language-detector` 需注意：最新的 2.2.0 要求 Python ≥ 3.12，无 cp311 轮子。
在 Python 3.11 环境下 pip 会自动回退到 2.1.1，该版本有预编译 Windows 轮子，
不会触发 Rust 源码编译。这是选择 Python 3.11 而非 3.12 之外的又一个可行性确认点。

PyTorch 在 Windows 上从 PyPI 安装默认是 CPU-only 版本，必须指定
`--index-url https://download.pytorch.org/whl/cu128` 才能拿到 CUDA 版本。

## 五、硬件预算核算

本机实测配置：

- GPU：NVIDIA GeForce RTX 4090，24564 MiB 显存，驱动 610.62
- 内存：63.7 GB
- 磁盘：I 盘剩余 992.6 GB
- 已有工具链：Python 3.11.5 (Anaconda)、Node 24.14.0、Git 2.52.0、Docker、Ollama、ffmpeg

驱动 610.62 远高于 CUDA 12.8 所需的 525，也满足 CUDA 13 的要求，无需升级驱动。

显存分配估算：

| 组件 | 显存占用 |
| --- | --- |
| Silero VAD v5 | ~0（跑 CPU，模型仅 2 MB） |
| Whisper large-v3-turbo (fp16) | ~1.6 GB |
| Qwen3-TTS 1.7B (fp16) | ~2.2–3.5 GB |
| CUDA 上下文与缓存 | ~1 GB |
| **可留给 LLM** | **约 18–19 GB** |

文章给 24 GB 档位的建议是「14B Q6 或 20B+」。按上表，18 GB 余量足以跑
14B 的 Q6_K（约 12 GB）并留出充裕的 KV cache 空间，或上到 32B 的 Q4_K_M（约 20 GB，
需压缩上下文长度）。本项目默认选 14B Q6_K，在质量与响应延迟之间取平衡——
语音对话场景下 LLM 延迟直接决定体验，不宜盲目堆参数量。

## 六、风险与待确认项

1. **参考音频需用户提供。** 声音克隆必须有一段 5–10 秒的干净人声。项目会先用
   CustomVoice 预设音色跑通全链路作为排错基准线，再接入克隆音色。
2. **声音克隆的授权边界。** 未经同意克隆真人（尤其是公众人物）声音在多地已涉及
   法律风险。参考音频应使用本人录音、公开数据集样本，或已获授权的素材。
3. **Windows 上 realtime 模式的打断表现未经实测。** 若表现不佳，回退到
   `--mode local` 仍可满足基本对话需求。
