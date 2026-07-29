# One-shot launcher: LLM, then panel, then the voice pipeline.
#
# Order matters. The voice pipeline is started last and in the foreground so
# its logs stay visible in this window - it is the component that fails in the
# most interesting ways.

. "$PSScriptRoot\config.ps1"

# The panel goes first now: it proxies the pipeline's LLM calls, and the
# pipeline makes a warm-up call while starting.
Write-Host "=== 1/4  Panel ===" -ForegroundColor Cyan
if (Test-MatePort -TargetHost "127.0.0.1" -Port $Global:PanelPort) {
    Write-Host "Panel already listening on port $Global:PanelPort"
} else {
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$PSScriptRoot\start-panel.ps1" `
        -WindowStyle Minimized
    Start-Sleep -Seconds 3
    Write-Host "Panel started."
}

Write-Host ""
Write-Host "=== 2/4  LLM ===" -ForegroundColor Cyan
# Only checks the local Ollama. If the panel is pointed at a cloud provider
# instead, this failing is not fatal - use "Test connection" in the UI.
& "$PSScriptRoot\check-llm.ps1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Local Ollama is unavailable. That is fine if you selected a cloud provider." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== 3/4  Lip-sync service ===" -ForegroundColor Cyan
# Only used by characters set to "real lip sync"; the other renderers ignore it.
if (Test-MatePort -TargetHost "127.0.0.1" -Port 8930) {
    Write-Host "Lip-sync service already listening on port 8930"
} else {
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$PSScriptRoot\start-musetalk.ps1" `
        -WindowStyle Minimized
    Write-Host "Lip-sync service starting (model load takes about 20s)."
}

Write-Host ""
Write-Host "=== 4/4  Voice pipeline ===" -ForegroundColor Cyan
Write-Host "Once you see 'OpenAI Realtime API starting', open:" -ForegroundColor Green
Write-Host "  http://127.0.0.1`:$Global:PanelPort/" -ForegroundColor Green
if ($Global:LanAccess) {
    $lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
        Select-Object -First 1).IPAddress
    if ($lanIp) {
        Write-Host "  http://$lanIp`:$Global:PanelPort/   (from other devices)" -ForegroundColor Green
    }
    Write-Host "LAN access is on: anyone who can reach this machine can use it." -ForegroundColor Yellow
}
Write-Host ""

& "$PSScriptRoot\start-voice.ps1"
