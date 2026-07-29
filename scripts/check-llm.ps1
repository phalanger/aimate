# Health check for the LLM stage. Does not launch anything.
#
# Ollama runs as its own tray application. OLLAMA_HOST is persisted as a user
# environment variable (127.0.0.1:11700), so the tray app binds the right port
# on its own and its working directory is its install folder.
#
# That working directory matters more than it looks: started from a folder
# containing other ggml binaries, Ollama's runner loads mismatched libraries
# and dies with GGML_ASSERT(prev != ggml_uncaught_exception). The visible
# symptoms are "model failed to load" and GPU discovery reporting 0 B of VRAM
# while falling back to CPU.

. "$PSScriptRoot\config.ps1"

if (-not (Test-MatePort -TargetHost "127.0.0.1" -Port 11700)) {
    Write-Host "Ollama is not listening on $Global:OllamaHost." -ForegroundColor Red
    Write-Host ""
    Write-Host "Start it from the Start menu (Ollama), or in a separate window run:"
    Write-Host "  cd `"$(Split-Path -Parent $Global:OllamaExe)`""
    Write-Host "  .\ollama.exe serve"
    Write-Host ""
    Write-Host "Run it from that directory, not from the project folder."
    exit 1
}

Write-Host "Ollama is listening on $Global:OllamaHost"

# Confirm the GPU was actually picked up. Falling back to CPU still answers,
# just far too slowly for voice, so catch it here rather than blaming latency
# on the pipeline later.
try {
    $ps = Invoke-RestMethod -Uri "http://$Global:OllamaHost/api/ps" -TimeoutSec 10
    if ($ps.models) {
        foreach ($m in $ps.models) {
            $pct = if ($m.size -gt 0) { [math]::Round(100 * $m.size_vram / $m.size) } else { 0 }
            Write-Host ("  loaded: {0}  ({1}% on GPU)" -f $m.name, $pct)
        }
    }
} catch {
    Write-Host "  (could not query /api/ps)" -ForegroundColor Yellow
}

Write-Host "Checking model '$Global:LlmModel' (first call loads weights, may take 30s) ..."
$body = @{
    model    = $Global:LlmModel
    messages = @(
        @{ role = "system"; content = "Reply with one short sentence." },
        @{ role = "user"; content = "hello" }
    )
    stream   = $false
} | ConvertTo-Json -Depth 5

try {
    $reply = Invoke-RestMethod -Uri "http://$Global:OllamaHost/v1/chat/completions" `
        -Method Post -ContentType "application/json" -Body $body -TimeoutSec 300
    Write-Host ("LLM OK. Reply: {0}" -f $reply.choices[0].message.content) -ForegroundColor Green
} catch {
    Write-Host "ERROR: model did not respond: $_" -ForegroundColor Red
    Write-Host "If the model is missing:  ollama create $Global:LlmModel -f runtime\models\Modelfile"
    exit 1
}
