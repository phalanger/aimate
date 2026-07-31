# One-shot setup for a fresh clone.
#
# Everything this project needs beyond the source lives outside git: three
# Python environments whose torch versions conflict with each other, about
# 27 GB of model weights, a static ffmpeg, and one proprietary JavaScript file
# that cannot be redistributed here. This script fetches all of it.
#
# Safe to re-run. Every step checks whether its result already exists and skips
# it, so an interrupted download is fixed by running the script again.
#
# The language model is deliberately not one of them. Any OpenAI-compatible
# endpoint works, cloud or local, and it is chosen in the panel at runtime -
# so picking one is the user's call, and Ollama can install its own models
# better than a script here could. See the README.
#
#   .\install.ps1                 minimum that works, ~27 GB
#   .\install.ps1 -WithMuseTalk   add the old lip-sync backend, ~41 GB
#   .\install.ps1 -Mirror         route HuggingFace through hf-mirror.com
#   .\install.ps1 -SkipBuild      do not compile mate.exe (no Rust needed)

[CmdletBinding()]
param(
    # The lip-sync backend FlashHead replaced. Measured slower, hungrier and
    # blurrier around the mouth - see docs/05-lipsync-spike.md. Here so those
    # measurements can be reproduced, not because you are likely to want it.
    [switch]$WithMuseTalk,
    # For networks where huggingface.co is unreachable.
    [switch]$Mirror,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$PythonRoot = Join-Path $Root "runtime\python"

if ($Mirror) { $env:HF_ENDPOINT = "https://hf-mirror.com" }

# ---------------------------------------------------------------- output ----

$script:StepNumber = 0
# Prerequisites, environments, FlashHead, TTS, ffmpeg, Live2D, first-run
# config, build. The optional steps adjust it below.
$script:StepTotal = 8
if ($WithMuseTalk) { $script:StepTotal += 1 }
if ($SkipBuild) { $script:StepTotal -= 1 }

function Write-Step($text) {
    $script:StepNumber += 1
    Write-Host ""
    Write-Host ("[{0}/{1}] {2}" -f $script:StepNumber, $script:StepTotal, $text) -ForegroundColor Cyan
}

function Write-Skip($text) { Write-Host "      $text" -ForegroundColor DarkGray }
function Write-Note($text) { Write-Host "      $text" }
function Write-Warn($text) { Write-Host "      $text" -ForegroundColor Yellow }

function Fail($text) {
    Write-Host ""
    Write-Host "ERROR: $text" -ForegroundColor Red
    exit 1
}

# Native commands do not set $ErrorActionPreference, so every external call has
# to be checked by hand or a failed download looks like a successful one.
function Invoke-Checked($what, [scriptblock]$action) {
    & $action
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit $LASTEXITCODE)." }
}

# --------------------------------------------------------- prerequisites ----

Write-Step "Checking what is already on this machine"

if ($PSVersionTable.PSVersion.Major -lt 5) { Fail "PowerShell 5.1 or newer is required." }

# py.exe is how Windows keeps several Python versions side by side, and this
# project needs two of them at once. A single python.exe on PATH cannot answer
# for both, so the launcher is required rather than merely convenient.
if (-not (Get-Command py.exe -ErrorAction SilentlyContinue)) {
    Fail @"
The Python launcher (py.exe) was not found.
Install Python from https://www.python.org/downloads/windows/ and tick
"Install launcher for all users". You need BOTH:
    Python 3.11  - the voice pipeline
    Python 3.10  - the lip-sync service
They cannot share one interpreter: their torch builds conflict.
"@
}

$available = (& py.exe -0p) 2>&1 | Out-String
foreach ($version in @("3.11", "3.10")) {
    if ($available -notmatch [regex]::Escape("-V:$version")) {
        Fail "Python $version was not found by py.exe. Installed versions:`n$available"
    }
    Write-Skip "Python $version found"
}

if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    Fail "git was not found. Install it from https://git-scm.com/download/win"
}
Write-Skip "git found"

if (-not $SkipBuild) {
    if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
        Fail @"
cargo was not found, and the desktop shell is built from Rust source.
Install Rust from https://rustup.rs/, or re-run with -SkipBuild and start the
app with scripts\start-all.ps1 instead of mate.exe.
"@
    }
    Write-Skip "cargo found"
}

# A GPU is not checked for here because the failure is clearer later: torch
# reports exactly what it found. But a missing driver is worth saying early.
if (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) {
    $driver = (& nvidia-smi.exe --query-gpu=driver_version --format=csv,noheader) 2>&1 | Select-Object -First 1
    Write-Skip "NVIDIA driver $driver"
} else {
    Write-Warn "nvidia-smi not found. This project needs an NVIDIA GPU with CUDA 12.8 support;"
    Write-Warn "everything will install but nothing will run on the GPU."
}

# ---------------------------------------------------- python environments ----

# name -> python version, CUDA build, torch packages to install from the
# PyTorch index. The rest of each environment comes from requirements\<name>.txt.
$Environments = @(
    @{ Name = "s2s";       Python = "3.11"; Cuda = "cu128"; Torch = @("torch==2.9.1+cu128", "torchaudio==2.9.1+cu128"); Always = $true },
    @{ Name = "flashhead"; Python = "3.10"; Cuda = "cu128"; Torch = @("torch==2.7.1+cu128", "torchvision==0.22.1+cu128"); Always = $true },
    @{ Name = "musetalk";  Python = "3.10"; Cuda = "cu118"; Torch = @("torch==2.0.1+cu118", "torchvision==0.15.2+cu118", "torchaudio==2.0.2+cu118"); Always = $false }
)

function Install-Environment($spec) {
    $target = Join-Path $PythonRoot $spec.Name
    $python = Join-Path $target "python.exe"
    $stamp = Join-Path $target ".mate-installed"

    if (Test-Path $stamp) {
        Write-Skip ("{0}: already installed" -f $spec.Name)
        return
    }

    if (-not (Test-Path $python)) {
        Write-Note ("{0}: creating a Python {1} environment" -f $spec.Name, $spec.Python)
        Invoke-Checked "creating the $($spec.Name) environment" {
            & py.exe ("-{0}" -f $spec.Python) -m venv $target
        }
    }

    Write-Note ("{0}: installing torch ({1})" -f $spec.Name, $spec.Cuda)
    # PyTorch's CUDA builds are not on PyPI, so they come from PyTorch's own
    # index. Installed before the requirements file, which deliberately does
    # not list them - pip would otherwise resolve the CPU build from PyPI.
    Invoke-Checked "installing torch for $($spec.Name)" {
        & $python -m pip install --disable-pip-version-check --quiet `
            --index-url ("https://download.pytorch.org/whl/{0}" -f $spec.Cuda) @($spec.Torch)
    }

    $requirements = Join-Path $Root ("requirements\{0}.txt" -f $spec.Name)
    Write-Note ("{0}: installing the rest" -f $spec.Name)
    Invoke-Checked "installing requirements for $($spec.Name)" {
        & $python -m pip install --disable-pip-version-check --quiet -r $requirements
    }

    New-Item -ItemType File -Path $stamp -Force | Out-Null
}

Write-Step "Building the Python environments (this is the slow part)"
Write-Note "Three interpreters, because their torch versions cannot coexist:"
Write-Note "  s2s        torch 2.9.1+cu128   voice pipeline"
Write-Note "  flashhead  torch 2.7.1+cu128   lip sync"
if ($WithMuseTalk) { Write-Note "  musetalk   torch 2.0.1+cu118   lip sync, old backend" }
New-Item -ItemType Directory -Force -Path $PythonRoot | Out-Null
foreach ($spec in $Environments) {
    if ($spec.Always -or ($WithMuseTalk -and $spec.Name -eq "musetalk")) {
        Install-Environment $spec
    }
}

$S2S = Join-Path $PythonRoot "s2s\python.exe"
$FlashPy = Join-Path $PythonRoot "flashhead\python.exe"

# --------------------------------------------------------------- helpers ----

function Get-Repository($url, $target, $label) {
    if (Test-Path (Join-Path $target ".git")) {
        Write-Skip "$label already cloned"
        return
    }
    Write-Note "Cloning $label"
    Invoke-Checked "cloning $label" { & git.exe clone --depth 1 $url $target }
}

# huggingface_hub comes with transformers, so the downloader is already in the
# environments and there is nothing extra to install for it.
function Get-HuggingFaceModel($repo, $target, $label) {
    if (Test-Path (Join-Path $target "config.json")) {
        Write-Skip "$label already downloaded"
        return
    }
    Write-Note "Downloading $label from HuggingFace"
    Invoke-Checked "downloading $label" {
        & $FlashPy -m huggingface_hub.commands.huggingface_cli download $repo --local-dir $target
    }
}

function Get-File($url, $target, $label) {
    if (Test-Path $target) {
        Write-Skip "$label already downloaded"
        return
    }
    Write-Note "Downloading $label"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    # Invoke-WebRequest with a progress bar is dramatically slower on large
    # files in PowerShell 5.1; the bar itself is the bottleneck.
    $previous = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
    } finally {
        $ProgressPreference = $previous
    }
}

# ---------------------------------------------------------------- models ----

Write-Step "Lip-sync model (FlashHead, ~8.3 GB)"
$FlashRoot = Join-Path $Root "runtime\flashhead"
Get-Repository "https://github.com/Soul-AILab/SoulX-FlashHead.git" $FlashRoot "SoulX-FlashHead"
Get-HuggingFaceModel "Soul-AILab/SoulX-FlashHead-1_3B" (Join-Path $FlashRoot "models\SoulX-FlashHead-1_3B") "FlashHead weights"
# The audio encoder the lip-sync model reads speech features from. Not a
# recogniser - transcription is Whisper's job, in the other environment.
Get-HuggingFaceModel "facebook/wav2vec2-base-960h" (Join-Path $FlashRoot "models\wav2vec2-base-960h") "wav2vec2"

Write-Step "Speech synthesis model (Qwen3-TTS-Base, ~4.2 GB)"
$TtsDir = Join-Path $Root "runtime\models\qwen3-tts-base"
if (Test-Path (Join-Path $TtsDir "model.safetensors")) {
    Write-Skip "Qwen3-TTS already downloaded"
} else {
    # From ModelScope rather than HuggingFace: that is where this model is
    # published, and the layout on disk includes ModelScope's configuration.json
    # which the loader expects.
    Write-Note "Installing the ModelScope client"
    Invoke-Checked "installing modelscope" {
        & $S2S -m pip install --disable-pip-version-check --quiet modelscope
    }
    Write-Note "Downloading Qwen3-TTS-Base"
    Invoke-Checked "downloading Qwen3-TTS-Base" {
        & $S2S -m modelscope.cli.cli download --model "Qwen/Qwen3-TTS-12Hz-1.7B-Base" --local_dir $TtsDir
    }
}

if ($WithMuseTalk) {
    Write-Step "Lip-sync model, old backend (MuseTalk, ~7.7 GB)"
    $MuseRoot = Join-Path $Root "runtime\musetalk"
    Get-Repository "https://github.com/TMElyralab/MuseTalk.git" $MuseRoot "MuseTalk"
    if (Test-Path (Join-Path $MuseRoot "models\musetalkV15")) {
        Write-Skip "MuseTalk weights already downloaded"
    } else {
        Write-Note "Running MuseTalk's own weight downloader"
        Push-Location $MuseRoot
        try { & cmd.exe /c "download_weights.bat" } finally { Pop-Location }
    }
}

# Whisper and silero-vad are deliberately absent: the voice pipeline fetches
# them on its first run, into the shared caches where other tools can reuse
# them. Together they are about 1.7 GB, so the first launch is slow once.

# ------------------------------------------------------------ binaries -----

Write-Step "ffmpeg (GPL static build, ~0.3 GB)"
$BinDir = Join-Path $Root "runtime\bin"
if (Test-Path (Join-Path $BinDir "ffmpeg.exe")) {
    Write-Skip "ffmpeg already present"
} else {
    # Must be a GPL build: saving a reply encodes with libx264, which the LGPL
    # builds leave out, and the failure message never mentions x264. Must also
    # be static: shared builds need their DLLs beside them and fail with
    # STATUS_DLL_NOT_FOUND anywhere else.
    $zip = Join-Path $env:TEMP "mate-ffmpeg.zip"
    Get-File "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" $zip "ffmpeg"
    Write-Note "Extracting"
    $unpacked = Join-Path $env:TEMP "mate-ffmpeg"
    if (Test-Path $unpacked) { Remove-Item $unpacked -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $unpacked -Force
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Get-ChildItem $unpacked -Recurse -Include "ffmpeg.exe", "ffprobe.exe" | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $BinDir $_.Name) -Force
    }
    Remove-Item $zip, $unpacked -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $BinDir "ffmpeg.exe"))) { Fail "ffmpeg was downloaded but not found in the archive." }
}

Write-Step "Live2D Cubism Core"
$CubismCore = Join-Path $Root "web\vendor\live2d\live2dcubismcore.min.js"
if (Test-Path $CubismCore) {
    Write-Skip "already present"
} else {
    # Not vendored in this repository: it is proprietary, and redistributing it
    # is governed by an agreement between you and Live2D, not by this project's
    # licence. Only the 2D display mode needs it.
    try {
        Get-File "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js" $CubismCore "Live2D Cubism Core"
    } catch {
        Write-Warn "Could not download it automatically."
        Write-Warn "Get the Cubism SDK for Web from https://www.live2d.com/en/sdk/download/web/,"
        Write-Warn "and copy Core/live2dcubismcore.min.js to web\vendor\live2d\."
        Write-Warn "Everything except the Live2D display mode works without it."
    }
}

# ------------------------------------------------------- first-run config ----

Write-Step "First-run configuration"

# The reference clip cloning starts from. Copied out of the installed package
# rather than shipped in this repository: a clip used for voice cloning is
# someone's voice, and republishing one is not this project's to do.
$DefaultVoice = Join-Path $Root "assets\voices\default.wav"
if (Test-Path $DefaultVoice) {
    Write-Skip "reference clip already present"
} else {
    $bundled = Join-Path $PythonRoot "s2s\Lib\site-packages\speech_to_speech\TTS\ref_audio.wav"
    if (Test-Path $bundled) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DefaultVoice) | Out-Null
        Copy-Item $bundled $DefaultVoice
        Write-Note "Took the sample clip from the speech_to_speech package"
    } else {
        Write-Warn "No reference clip found. Record one in the panel: Settings -> Voice library."
    }
}

# Copied, never overwritten: these are yours once they exist, and none of them
# is tracked by git.
foreach ($name in @("characters", "voices", "providers")) {
    $live = Join-Path $Root ("config\{0}.json" -f $name)
    $template = Join-Path $Root ("config\{0}.example.json" -f $name)
    if (Test-Path $live) {
        Write-Skip "config\$name.json already exists, left alone"
    } elseif (Test-Path $template) {
        Copy-Item $template $live
        Write-Note "Created config\$name.json"
    }
}

# ----------------------------------------------------------------- build ----

if (-not $SkipBuild) {
    Write-Step "Building the desktop shell"
    & (Join-Path $Root "scripts\build-shell.ps1")
    if ($LASTEXITCODE -ne 0) { Fail "the shell build failed." }
}

# ------------------------------------------------------------------ done ----

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
Write-Host "  Start it:      .\mate.exe        (or scripts\start-all.ps1)"
Write-Host "  First launch downloads Whisper and silero-vad, about 1.7 GB."
Write-Host ""
Write-Host "  No language model is configured yet. Open Settings -> Model and either"
Write-Host "  paste an API key for a cloud provider, or install Ollama and pull one:"
Write-Host ""
Write-Host "      ollama pull qwen3:14b"
Write-Host ""
Write-Host "  Every character starts on the bundled English sample voice, which is"
Write-Host "  male. Settings -> Voice library to record or upload your own."
Write-Host ""
