# 粵語（实验性）

> 对应 issue #5。整套粵語能力是**实验性**的——ASR 那半稳，TTS 那半没在 app 里验证过，
> 本文把已知和未知都摊开。本机是 GPU-less 的 WSL（见 [08](08-wsl-deployment.md)），跑
> 不了语音流水线，所以文末的「验证」是给 GPU 主机的清单，不是已经做过的事。

## 一、粵語怎么接上来的

现有流水线是 `麦克风 → Silero VAD → Whisper large-v3-turbo → 大模型 → Qwen3-TTS →
扬声器`。粵語没有换任何一个模型，只动了「认哪种话」「说什么话」「拿谁的音色」三件事。

### ASR：认粵語

Whisper large-v3-turbo 带 `yue` 这个语言码。原来 `scripts/services.json` 里写死
`--language zh`，现在改成命名变量：

```jsonc
"vars":       { ..., "asr_language": "zh" },
"vars_posix": { ..., "asr_language": "zh" }
// voice 服务的命令数组：
"--language", "{asr_language}"
```

粵語就把 `asr_language` 改成 `yue`。`launcher.py` 那个「识别别跑两遍」的补丁（见
[四点六](07-voice-library.md#四点六launcher-里搭车的第二个补丁识别别跑两遍)）只在语言
被钉死时接管，`yue` 也是钉死的，所以照样省掉那次重跑。

### TTS：让粵語的字变成粵語的音

这是实验里最不确定的一块，先把机制讲清楚。

Qwen3-TTS **base** 模型的官方模型卡列 10 种语言，「中文」指的是普通话，没有粵語。社区
在 QwenLM/Qwen3-TTS#141 里给过一个实用技巧：**喂繁体字，读出来偏粵語；喂简体字，偏普
通话**。（issue #5 把 #141 描述成「含可下载的粵語 WAV」——查证下来 #141 已关闭、没有
可下载样本；有用的就是这句繁体技巧。这里如实记下。）

更重要的一层：当前克隆走的是 `--qwen3_tts_xvec_only`（见
[四点七](07-voice-library.md#四点七开关又拨回去了以及界面为此变成跟着模式走)）。这个
模式下，参考音频**只提供说话人向量（音色），参考文本在合成前被整个丢弃**。也就是说：

> **参考音频决定「谁在说」，不决定「说什么话、哪种话」。**粵語发音不是靠那段粵語参考
> 音频逼出来的，是靠**大模型用繁体粵語口语回复**带出来的。

所以粵語角色的 `system_prompt` 才是真正的开关。`ahyue` 的人设写成繁体粵語口语：

```
你叫阿粵。你用粵語（廣東話）同人傾偈……
二、用粵語口語，用繁體字寫。唔好用書面語……
```

繁体 + 口语 + 粵語用词，三样合起来才让 base 模型读出粵語味。参考音频（`v-cantonese`
音色包）只负责音色像不像那个录粵語的人。

## 二、一个关键事实：音色 ≠ 语言

把上面两点合起来，粵語这件事的杠杆分布是：

| 环节 | 杠杆在哪 | 粵語靠它什么 |
| --- | --- | --- |
| ASR | `{asr_language}` | 设成 `yue`，识别粵語而不是普通话 |
| LLM | 角色 `system_prompt` | 让它回繁体粵語口语（粵語发音的真正来源） |
| TTS | 参考音频 | 只换音色，**不**影响说的是不是粵語 |

这也是为什么「加个粵語参考音频」单独做没用——音频再粵語，大模型回的是普通话，合成出
来还是普通话味。三件事必须一起改。

## 三、怎么开启（服务级，需重启）

1. 录一段十秒以内的干净粵語，放到 `assets/voices/cantonese.wav`，把 `config/voices.json`
   里 `v-cantonese` 的 `ref_text` 改成你实际念的字（逐字对应）。
2. 把 `scripts/services.json` 里 `asr_language` 从 `zh` 改成 `yue`。
3. 重启语音服务。
4. 切到「阿粵」角色，讲粵語。

**这是服务级的开关**：整个语音服务一次只认一种话。切到 `yue` 之后，普通话 ASR 就不灵
了，直到你切回 `zh` 再重启。所以这不是「按角色切语言」，是「整台机器切语言」。要做按
角色运行时切换，得改 Realtime 协议——`session.update` 现在只带 `voice` 和
`instructions`，没有语言的槽（见 [07](07-voice-library.md) 一、里的 bug 描述）——超出
了这次实验的范围。

## 四、给后续语种留的路

这次故意没把粵語写成特例，机制是通用的。加一个新语种（比如日语、韩语）照这三步：

1. **ASR**：把 `asr_language` 改成对应的 Whisper 语言码（`ja` / `ko` / ……，Whisper 覆
   盖约 99 种），重启。
2. **音色包**：在 `config/voices.json` 加一条，带 `language` 字段，参考音频放
   `assets/voices/`。`language` 让「重新识别」用对语言转写——这是这次顺手修的一个隐藏
   bug：原来参考音频识别处处写死 `"zh"`（`server/server.py` 的 `_retranscribe_voicepack`
   和 `_post_transcribe`），粵語音频会被当普通话转写。现在音色包带 `language`，按包自己
   的语言转。
3. **角色**：加一个角色，`system_prompt` 用目标语言的口语写。

边界要讲清楚：

- **ASR** 基本随便扩——Whisper 支持的都能接。
- **TTS** 受 Qwen3-TTS 限制：官方 10 种语言（中＝普通话、英、日、韩、德、法、俄、葡、
  西、意）之外的，靠「换字符集读出方言」这种社区技巧，不保证。粵語就属于这一类。真要
  高质量粵語，得换 Qwen3-TTS-Flash 方言版，或上社区的粵語 finetune——那是**换模型**，
  issue #5 明确不让做，留作未来工作。

## 五、验证（给 GPU 主机；本机跑不了）

本机是 GPU-less WSL，语音流水线起不来，下面是交接清单，不是已完成的验证。

1. `asr_language=yue`、放好 `cantonese.wav`、切「阿粵」、重启语音服务。
2. 讲粵語，看 `var/logs/voice.log`：
   - ASR 转出的是粵語文本（不是被普通话硬套）；
   - 大模型回的是繁体粵語口语；
   - TTS 合成听起来是粵語发音，不是普通话。
3. 确认单次识别补丁还在生效：日志里**不**再出现
   `Whisper detected unsupported language:`（见 [07](07-voice-library.md) 五）。
4. 听感不像粵語：这就是「实验性」的待解项，记下现象；候选解法（Flash 方言版 / 粵語
   finetune）见上面第四节，属换模型、超范围。

本机能做的核对（已做）：四个改过的 JSON 都能解析；面板 `:8900/api/characters` 含「阿
粵」、`/api/voicepacks` 含 `v-cantonese` 且 `language=yue`；`supervisor.py` 的
`expand()` 能把 `{asr_language}` 替换掉（`vars` 和 `vars_posix` 都定义了它）。
