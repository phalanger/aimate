# Starts the speech-to-speech realtime server (VAD -> STT -> LLM -> TTS).
#
# The browser panel connects to ws://127.0.0.1:8765/v1/realtime and drives the
# persona and voice per session, so nothing here is character-specific.

. "$PSScriptRoot\config.ps1"

# The pipeline's LLM calls go through the panel's proxy, and it makes a
# warm-up call during startup, so the panel must already be listening.
if (-not (Test-MatePort -TargetHost "127.0.0.1" -Port $Global:PanelPort)) {
    Write-Host "ERROR: the panel is not running on port $Global:PanelPort." -ForegroundColor Red
    Write-Host "It proxies the LLM calls, so start it first: scripts\start-panel.ps1"
    exit 1
}

$env:HF_HUB_ENABLE_HF_TRANSFER = "0"

$argumentList = @(
    "-m", "speech_to_speech.s2s_pipeline",

    "--mode", "realtime",
    "--ws_host", $Global:VoiceHost,
    "--ws_port", "$Global:VoicePort",

    # Whisper, not the default parakeet-tdt: parakeet only covers 25 European
    # languages and returns empty transcripts for Chinese without erroring,
    # which is easy to misread as a broken microphone.
    "--stt", "whisper",
    "--stt_model_name", "openai/whisper-large-v3-turbo",
    "--language", "zh",

    # Points at the panel proxy, not at a provider. The proxy substitutes the
    # real endpoint, credential and model name per request, so the text model
    # can be changed from the UI without restarting anything here.
    "--llm_backend", "chat-completions",
    "--model_name", "from-panel",
    "--responses_api_base_url", $Global:LlmProxyUrl,
    "--responses_api_api_key", "local",
    "--responses_api_stream",
    # Default is 3: the pipeline waits for three sentences before handing
    # anything to the TTS. Personas here are capped at two sentences, so that
    # default means waiting for the entire reply before a sound comes out.
    "--stream_batch_sentences", "1",

    "--tts", "qwen3",
    # torch, not the default ggml: on Windows the dependency resolves to
    # faster-qwen3-tts without the [ggml] extra, so the ggml backend is absent.
    "--qwen3_tts_backend", "torch",
    "--qwen3_tts_model_name", $Global:TtsModel,
    "--qwen3_tts_device", "cuda",
    "--qwen3_tts_ref_audio", $Global:RefAudio,
    "--qwen3_tts_ref_text", $Global:RefText,
    "--qwen3_tts_xvec_only",

    # Tune --thresh on your own microphone: too low and room noise triggers a
    # turn, too high and quiet speech is never detected.
    "--thresh", "0.4"
)

Write-Host "Starting voice pipeline on ws://$Global:VoiceHost`:$Global:VoicePort/v1/realtime"
Write-Host "First run downloads Whisper large-v3-turbo (about 1.6 GB)."
Write-Host ""

& $Global:MatePython @argumentList
