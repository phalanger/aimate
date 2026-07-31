# WSL / Debian 部署记录

这篇记录 2026-07-31 在 WSL Debian 上部署本项目的实际过程。目标机器：

- WSL -> Debian
- NVIDIA GeForce RTX 4090 24 GB
- NVIDIA driver 610.62
- CUDA 设备在 WSL 内可见，`nvidia-smi` 正常
- `uv`、`git`、`cargo` 已安装
- 系统 `ffmpeg` 已安装，并且 encoder 列表里有 `libx264`

Windows 已走通的安装入口是 `install.ps1`。WSL 不能复用 Windows 里的
`runtime/python/*/python.exe`，需要重新创建 Linux venv 和 Linux CUDA wheel。

## 安装入口

WSL 下使用：

```bash
./install.sh
```

可选参数：

```bash
./install.sh --mirror          # HuggingFace 使用 hf-mirror.com
./install.sh --with-musetalk   # 额外安装旧 MuseTalk 环境
./install.sh --skip-lipsync    # 先跳过 FlashHead 权重，走通面板和语音
```

脚本做这些事：

1. 检查 `uv`、`git`、`curl`、`ffmpeg`、`nvidia-smi`。
2. 用 `uv venv --seed` 创建两个环境：
   - `runtime/python/s2s`，Python 3.11，torch 2.9.1+cu128
   - `runtime/python/flashhead`，Python 3.10，torch 2.7.1+cu128
3. 安装 `requirements/s2s.txt` 和 `requirements/flashhead.txt`。
4. 下载 FlashHead 仓库、FlashHead 权重和 wav2vec2。
5. 用 ModelScope 下载 Qwen3-TTS-Base。
6. 预取语音服务首启资源：NLTK 数据、silero-vad torch hub 缓存、Whisper。
7. 把系统 `ffmpeg`/`ffprobe` 链接到 `runtime/bin/`。
8. 初始化 `config/characters.json`、`config/voices.json`、`config/providers.json`。

`--skip-lipsync` 会跳过 FlashHead Python 环境和权重下载。这样可以先跑：

```bash
runtime/python/s2s/bin/python scripts/supervisor.py --skip lipsync
```

FlashHead 权重补齐前，不要启动完整服务表，否则口型服务会加载失败或一直等权重。

## 这次遇到的问题

### services.json 只有 Windows 路径

`scripts/services.json` 原本把解释器写成：

```json
"python_s2s": "{root}\\runtime\\python\\s2s\\python.exe"
```

在 WSL 下 supervisor 会尝试启动不存在的 `.exe`。修复方式：

- `services.json` 保留 Windows 默认变量。
- 增加 `vars_posix`，覆盖解释器、模型和默认音频路径。
- `supervisor.py` 在 `os.name != "nt"` 时加载 `vars_posix`。
- POSIX 下变量展开后把 `\` 转成 `/`，复用同一张服务表。

### uv venv 默认没有 pip

本机 `uv venv` 创建出的环境没有 pip，导致：

```text
No module named pip
```

修复方式：

- 创建环境时使用 `uv venv --seed`。
- 对已经半创建的环境，脚本会用 `uv pip install --python ... pip setuptools wheel`
  补齐 pip。

### ffmpeg 检测受 pipefail 影响

最初脚本用：

```bash
ffmpeg -hide_banner -encoders | grep -q libx264
```

在 `set -o pipefail` 下，`grep -q` 提前退出会让 `ffmpeg` 收到 broken pipe，整条检测
被误判失败。修复为把 encoder 输出放进 shell 字符串匹配。

### Windows-only Python 包

`requirements/flashhead.txt` 里有 Windows-only 依赖：

- `triton-windows`
- `win32_setctime`

Linux 安装时由 `install.sh` 临时过滤，不改冻结依赖文件，避免影响 Windows 安装。

### HuggingFace 下载完成判断不能只看 config.json

FlashHead 权重目录很早就会出现根目录 `config.json`，但几个大 checkpoint 还没下载：

- `Model_Lite/diffusion_pytorch_model.safetensors`
- `Model_Pro/diffusion_pytorch_model.safetensors`
- `VAE_LTX/diffusion_pytorch_model.safetensors`
- `VAE_Wan/Wan2.1_VAE.pth`

所以 `install.sh` 的 HuggingFace 下载函数支持传入 marker 文件。FlashHead 用
`Model_Lite/diffusion_pytorch_model.safetensors` 作为完成标记，wav2vec2 用
`pytorch_model.bin`。

### hf-mirror 的默认 HEAD 超时偏短

`huggingface_hub` 对 metadata HEAD 请求的默认超时是 10 秒。镜像站能拿到仓库清单和
小文件，但大 checkpoint 的 HEAD 请求可能超过 10 秒，报：

```text
FileMetadataError: Distant resource does not seem to be on huggingface.co
LocalEntryNotFoundError: ... cannot find the requested files in the local cache
```

`install.sh` 默认设置：

```bash
HF_HUB_ETAG_TIMEOUT=60
HF_HUB_DOWNLOAD_TIMEOUT=60
```

如果网络仍然波动，直接重跑 `./install.sh --mirror`。

本次实测：hf-mirror 对 SoulX-FlashHead 的大文件仍会跳转到 HuggingFace/Xet CDN，
速度没有稳定改善；WSL 首轮部署建议先用 `--skip-lipsync` 跑通语音链路。

### speech-to-speech 首启会在线拉 NLTK、silero-vad 和 Whisper

语音服务 import `speech_to_speech.s2s_pipeline` 时会检查并下载：

- `punkt_tab`
- `averaged_perceptron_tagger_eng`

本次 WSL 上 NLTK 官方下载超时。继续往后还会由 `torch.hub.load("snakers4/silero-vad")`
访问 GitHub。为了避免服务启动阶段卡在外网下载，`install.sh` 现在预取：

- NLTK zip 直链，解压到 `runtime/python/s2s/nltk_data`
- `silero-vad` GitHub zip，解压到 `~/.cache/torch/hub/snakers4_silero-vad_master`
- `openai/whisper-large-v3-turbo` 到 HuggingFace cache

注意：上游代码把 `averaged_perceptron_tagger_eng` 检查在 `tokenizers/` 下，但 NLTK
标准路径是 `taggers/`。脚本把真实目录放在 `taggers/`，再从 `tokenizers/` 建相对
符号链接，兼容两边。

Whisper 本次用默认 HuggingFace endpoint 成功，`hf-mirror` 对该模型也出现 metadata
校验失败，所以脚本对 Whisper 预取显式不继承 `HF_ENDPOINT`。

只预取 silero-vad 还不够：`torch.hub.load("snakers4/silero-vad", ...)` 会先访问
GitHub 判断默认分支，再检查缓存。`services/voice/launcher.py` 会把这一次调用改成
本地 `source="local"`，直接读 `~/.cache/torch/hub/snakers4_silero-vad_master`。

### 8765 不是本次启动失败原因

复核命令：

```bash
ss -ltnp 'sport = :8765'
runtime/python/s2s/bin/python - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 8765))
print("bind-ok")
s.close()
PY
```

本次 WSL 环境下 `ss` 没有 8765 监听项，Python 实际 bind 也成功。语音服务没有监听
8765，是因为启动流程还没走到 uvicorn bind 阶段就退出了。

实际阻塞点在 LLM 预热：

```text
openai.BadRequestError: Error code: 400 - {'error': "provider 'grok' has no API key set"}
```

`config/providers.json` 来自示例配置，当前 `active` 是 `grok`，但 `api_key` 为空。
要继续跑完整语音链路，需要先填一个可用 provider key，或者改成可用的本地 Ollama
配置并确认对应服务已在 `11700` 监听。

本次已改为智谱 GLM Coding Plan：

```json
{
  "active": "glm",
  "providers": {
    "glm": {
      "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
      "model": "glm-5.2"
    }
  }
}
```

注意不要把这个 Base URL 改成按量示例里的
`https://open.bigmodel.cn/api/paas/v4`。用户给到的 `"glm-5.2[1m]"` 中 `[1m]`
是终端 ANSI 残留；按原样请求会返回：

```text
模型不存在，请检查模型代码。
```

### 云端代理端口也会让 LLM 预热卡住

本机 shell 里的可用代理是 `127.0.0.1:6478`，但 `config/settings.json` 里旧值是：

```json
"llm_proxy": "http://127.0.0.1:2333"
```

supervisor 会把该设置覆盖到 panel/voice 子进程环境，因此 panel 子进程实际用 2333
访问 BigModel，表现为本地 `/v1/chat/completions` 一直不返回，voice 每 20 秒重试，
最后看起来像语音服务没起来。

修复方式：本机 `config/settings.json` 把 `llm_proxy` 清空，让 WSL 进程沿用当前 shell
里的可用 `HTTP_PROXY/HTTPS_PROXY`。修复后：

```text
POST http://127.0.0.1:8900/v1/chat/completions -> 200
ChatCompletionsApiModelHandler warmed up
Uvicorn running on http://127.0.0.1:8765
```

## 启动命令

只启动面板：

```bash
runtime/python/s2s/bin/python scripts/supervisor.py --only panel
```

启动面板和语音，不启动 FlashHead：

```bash
runtime/python/s2s/bin/python scripts/supervisor.py --skip lipsync
```

启动全部服务：

```bash
runtime/python/s2s/bin/python scripts/supervisor.py
```

打开：

```text
http://127.0.0.1:8900/
```

## 验证项

环境安装完成后至少检查：

```bash
runtime/python/s2s/bin/python - <<'PY'
import torch
print(torch.__version__, torch.cuda.is_available())
print(torch.cuda.get_device_name(0))
PY

runtime/python/flashhead/bin/python - <<'PY'
import torch
print(torch.__version__, torch.cuda.is_available())
print(torch.cuda.get_device_name(0))
PY
```

服务启动后检查：

```bash
curl -fsS http://127.0.0.1:8900/ >/dev/null
curl -fsS http://127.0.0.1:8930/health
```

`install.sh` 已经预取 Whisper large-v3-turbo 和 silero-vad；如果手动删除缓存，下一
次语音服务启动还会尝试联网获取。

## PR 范围建议

这次 WSL 支持适合拆成一个小 PR：

- 新增 `install.sh`
- `scripts/supervisor.py` 支持按平台覆盖变量
- `scripts/services.json` 增加 `vars_posix`
- 新增这篇部署记录
- `config/settings.json` 不再默认写死 `127.0.0.1:2333` 代理
- 安装入口支持 `--skip-lipsync`，避免 FlashHead 大权重下载阻塞基础语音链路验证
- 安装阶段预取 NLTK、silero-vad 和 Whisper，避免语音服务首启卡在线下载

这组改动不改变 Windows 默认变量和 `install.ps1`，对已走通的 Windows 部署影响很小。
