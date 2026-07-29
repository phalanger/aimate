# Builds the desktop shell and puts the exe at the project root.
#
# The root is where it belongs in a packaged release - the shell looks for
# scripts\services.json by walking up from its own location, so it works both
# from here and from app\target\release during development.

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\config.ps1"

$app = Join-Path $Global:MateRoot "app"
$target = Join-Path $Global:MateRoot "mate.exe"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: cargo not found. Install Rust from https://rustup.rs/" -ForegroundColor Red
    exit 1
}

Write-Host "Building the shell (release) ..."
Push-Location $app
try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

$built = Join-Path $app "target\release\mate.exe"
if (-not (Test-Path $built)) {
    Write-Host "ERROR: build reported success but $built is missing." -ForegroundColor Red
    exit 1
}

# The shell may be running from the root copy; replacing a locked file fails
# with a permission error that reads like something worse.
$running = Get-Process mate -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Closing the running shell first ..."
    $running | ForEach-Object { $null = $_.CloseMainWindow() }
    Start-Sleep -Seconds 2
    Get-Process mate -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
}

Copy-Item $built $target -Force
$size = [math]::Round((Get-Item $target).Length / 1KB, 0)

Write-Host ""
Write-Host "Built $target ($size KB)" -ForegroundColor Green
Write-Host "Double-click it, or run it with supervisor arguments:"
Write-Host "  .\mate.exe --skip lipsync        leave the lip-sync service out"
Write-Host "  .\mate.exe --skip lipsync,voice  panel only, no GPU"
