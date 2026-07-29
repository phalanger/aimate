# Shared configuration for all start scripts.
# Dot-source this file: . "$PSScriptRoot\config.ps1"

$Global:MateRoot = Split-Path -Parent $PSScriptRoot

# Python interpreter of the dedicated conda environment. Using the interpreter
# path directly avoids needing "conda activate" inside every script.
$Global:MatePython = "D:\Apps\anaconda3\envs\s2s\python.exe"

# Ollama serves the LLM over an OpenAI-compatible API.
# Port 11700 rather than the default 11434: on this machine the range
# 11428-11527 sits in the Windows excluded port list, so the default bind
# fails with "socket access forbidden".
$Global:OllamaExe = "C:\Users\Cytal\AppData\Local\Programs\Ollama\ollama.exe"
$Global:OllamaHost = "127.0.0.1:11700"
$Global:LlmModel = "mate-qwen3-14b"

# Realtime voice server. The browser panel connects to
# ws://127.0.0.1:8765/v1/realtime
# Bind address follows the lan_access setting in config\settings.json, so the
# three services agree. If the panel were reachable from the network but the
# voice server was not, the page would load on another device and then fail to
# connect with nothing obvious to point at.
$Global:LanAccess = $false
try {
    $settingsPath = Join-Path $Global:MateRoot "config\settings.json"
    if (Test-Path $settingsPath) {
        $settings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($group in $settings.groups) {
            foreach ($item in $group.items) {
                if ($item.key -eq "lan_access") { $Global:LanAccess = [bool]$item.value }
            }
        }
    }
} catch {
    $Global:LanAccess = $false
}

$Global:BindHost = if ($Global:LanAccess) { "0.0.0.0" } else { "127.0.0.1" }

$Global:VoiceHost = $Global:BindHost
$Global:VoicePort = 8765

# Panel server. Besides serving the UI it proxies the pipeline's LLM calls,
# which is what makes the text model switchable at runtime: speech-to-speech
# binds its endpoint once at startup, so it points here and the panel forwards
# to whichever provider is selected in providers.json.
#
# Consequence: the panel has to be running before the voice pipeline starts,
# because the pipeline makes a warm-up LLM call while it boots.
$Global:PanelHost = $Global:BindHost
$Global:PanelPort = 8900
$Global:LlmProxyUrl = "http://127.0.0.1:8900/v1"

# Models and assets. The live values for the services come from
# scripts\services.json; these remain for check-llm.ps1 and manual use.
$Global:TtsModel = Join-Path $Global:MateRoot "runtime\models\qwen3-tts-base"
$Global:RefAudio = Join-Path $Global:MateRoot "assets\voices\default.wav"
$Global:LogDir = Join-Path $Global:MateRoot "var\logs"

# Transcript of assets\voices\default.wav. Qwen3-TTS clones from the pair of
# reference audio plus its transcript, so this has to match the wav file.
# Replace both together when you swap in your own voice.
$Global:RefText = "I'm confused why some people have super short timelines, yet at the same time are bullish on scaling up reinforcement learning atop LLMs. If we're actually close to a human-like learner, then this whole approach of training on verifiable outcomes."

if (-not (Test-Path $Global:LogDir)) {
    New-Item -ItemType Directory -Force -Path $Global:LogDir | Out-Null
}

# This machine has HTTP_PROXY/HTTPS_PROXY pointing at 127.0.0.1:2333 with an
# empty NO_PROXY. Without this, the OpenAI client inside the pipeline routes
# its calls to the local Ollama server through that proxy, which fails in
# confusing ways. Exempt loopback explicitly.
$Global:NoProxyHosts = "127.0.0.1,localhost,::1"
$env:NO_PROXY = $Global:NoProxyHosts
$env:no_proxy = $Global:NoProxyHosts

function Test-MatePort {
    param([string]$TargetHost, [int]$Port, [int]$TimeoutSec = 2)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne([TimeSpan]::FromSeconds($TimeoutSec))
        if ($ok -and $client.Connected) { $client.Close(); return $true }
        $client.Close()
        return $false
    } catch {
        return $false
    }
}
