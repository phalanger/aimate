# 粵語（实验性）

> 对应 issue #5。两条路：**GPU 流水线**（issue 原本的 whisper-large-v3-turbo + Qwen3-TTS
> 方案）和 **CPU 桥**（`services/voice_cpu/`，GPU-less 机器的实时语音桥，本机实测跑通）。
> ASR 两边都稳；TTS 的关键结论：**Qwen3-TTS base 实测不出粵語**（繁體被读成普通话），
> **CPU 桥用 sherpa-onnx VITS 出真粵語**。本文把已知/未知都摊开。

## 一、粵語怎么接上来的

两条路都只动「认哪种话 / 说什么话 / 出什么音」，没换模型族。

### ASR：认粵語（两边通用）

Whisper 带 `yue` 这个语言码。

- GPU 流水线：`scripts/services.json` 的 `--language` 现在是命名变量 `{asr_language}`
  （默认 `zh`，粵語改 `yue`）。`launcher.py` 的单次识别补丁（[07 四点六](07-voice-library.md)）
  只在语言被钉死时接管，`yue` 一样吃红利。
- CPU 桥：`services/voice_cpu/asr.py` 读 `MATE_ASR_LANGUAGE`（默认 `zh`），粵語设 `yue`。

### TTS：粵語的字 → 粵語的音

**GPU 流水线（Qwen3-TTS）——实测不出粵語。** issue #5 设想「base Qwen3-TTS + 繁體字 →
粵語」，依据是 QwenLM/Qwen3-TTS#141 的社区技巧。实测下来 base 模型把繁體读成**普通话**
（听了合成样本确认）。而且克隆走 `--qwen3_tts_xvec_only`：参考音频只提供说话人向量
（音色），参考文本在合成前被丢弃——所以**参考音频决定「谁在说」，不决定「说什么话、
哪种话」**，换个粵語参考音频也救不了。会做粵語的 Flash 方言版 / 社区粵語 finetune 都
gated（401），开放权重拿不到。结论：issue 的 TTS 前设在开放 base 上**不成立**；GPU 那
半仍待主机验证，且据本机实验预期 base 还是普通话。

**CPU 桥（sherpa-onnx VITS）——出真粵語。** `services/voice_cpu/tts.py` 在
`MATE_ASR_LANGUAGE=yue` 时走 sherpa-onnx 的粵語 VITS（`vits-cantonese-hf-xiaomaiiwn`）。
非自回归，~1.5s/句，离线，实测粵語发音正确。代价：lexicon 有 OOV，偶吞字（补 lexicon /
换分词可调）；单音色。

## 二、怎么开启

### CPU 桥（本机已验证粵語）

1. voice_cpu venv 装依赖（含 sherpa-onnx）：
   `pip install -r services/voice_cpu/requirements.txt`
2. 下粵語 VITS 模型（`runtime/` 已 gitignore，模型自备，约 108MB）：
   ```bash
   curl -L -o /tmp/c.tar.bz2 \
     https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-cantonese-hf-xiaomaiiwn.tar.bz2
   (cd runtime/models && tar xjf /tmp/c.tar.bz2)   # -> runtime/models/vits-cantonese-hf-xiaomaiiwn/
   ```
3. 启桥（粵語 ASR + 粵語 TTS；`MATE_ASR_MODEL` 用 turbo 更准）：
   ```bash
   MATE_ASR_LANGUAGE=yue MATE_ASR_MODEL=runtime/models/faster-whisper-large-v3-turbo \
     bash scripts/start-voice-cpu.sh
   ```
4. 面板（:8900）切「阿粵」，讲粵語 → 听到粵語回复。

服务级：整个桥一次只认一种话。切 `yue` 后普通话 ASR 失效，直到切回 `zh`。要做按角色运行
时切语言得改 Realtime 协议（`session.update` 没有 language 槽），超本次范围。

### GPU 流水线（待验证）

设 `asr_language=yue`、放 `assets/voices/cantonese.wav`、切阿粵、重启语音服务。但据本机
实验，Qwen3-TTS base 预期读成普通话——要真粵語得换 Flash / gated 的粵語模型。

## 三、给后续语种留的路

机制是通用的，没把粵語写成特例。加新语种（日 / 韩 / ……）三步：

1. **ASR**：`asr_language`（GPU）或 `MATE_ASR_LANGUAGE`（CPU 桥）改成对应 Whisper 码
   （Whisper 覆盖约 99 种）。
2. **TTS**：
   - CPU 桥：换 sherpa-onnx 对应语种的 VITS（覆盖广，粵語已验证）；`tts.py` 按语言分支。
   - GPU 流水线：Qwen3-TTS 官方 10 语言内的可直接用；之外的（含粵語）实测靠不住。
   - GPU 音色包：`config/voices.json` 带 `language` 字段（顺手修了 `server/server.py`
     里 `_retranscribe_voicepack`/`_post_transcribe` 写死 `zh` 的转写 bug），按包语言转写。
3. **角色**：加角色，`system_prompt` 用目标语言的口语写。

## 四、验证

- **CPU 桥（本机，已验证）**：turbo + `yue` ASR 转粵語、阿粵 LLM 回繁體粵語、sherpa VITS
  出粵語发音；端到端粵語，基本实时。
- **GPU 流水线（待验证）**：whisper-large-v3-turbo + Qwen3-TTS，本机无 GPU 跑不了；据 CPU
  实验预期 base 读普通话，真粵語需 Flash / gated 模型。
- 本机已核对：改过的 JSON 都解析；面板 `/api/characters` 含阿粵、`/api/voicepacks` 含
  `v-cantonese`（`language=yue`）；voice_cpu 五个 .py 编译通过。

---

（issue #5 把 Qwen3-TTS#141 描述成「含可下载粵語 WAV」——查证下来 #141 已关闭、无样本；
有用的只是那句繁體技巧，而它在 base 上经实测无效。）
