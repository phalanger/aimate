# Starts the MuseTalk lip-sync service.
#
# Runs in its own conda environment: MuseTalk pins torch 2.0.1 with CUDA 11.8,
# while the voice pipeline needs torch 2.9 with CUDA 12.8. The two cannot share
# an interpreter, so this is a separate process on port 8930.
#
# Prepared avatars are restored from the cache on startup, so a restart does
# not mean waiting through preparation again.
#
# Only needed for characters whose display mode is "real lip sync". The orb,
# VRM and Live2D renderers do not touch this service.

. "$PSScriptRoot\config.ps1"

$env:PATH = "$Global:MateRoot\bin;$env:PATH"

$service = Join-Path $Global:MateRoot "musetalk_service\service.py"
$python = "D:\Apps\anaconda3\envs\musetalk\python.exe"

if (-not (Test-Path $python)) {
    Write-Host "ERROR: the musetalk conda environment is missing." -ForegroundColor Red
    Write-Host "Expected interpreter at $python"
    exit 1
}

if (Test-MatePort -TargetHost "127.0.0.1" -Port 8930) {
    Write-Host "Lip-sync service already listening on 127.0.0.1:8930"
    exit 0
}

Write-Host "Starting lip-sync service on 127.0.0.1:8930 ..."
Write-Host "Loading the models takes about 20 seconds."
Write-Host ""

& $python $service
