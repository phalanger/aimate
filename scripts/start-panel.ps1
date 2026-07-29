# Serves the 3D panel over HTTP.
#
# Opening panel\index.html directly will not work: ES modules, fetch() and
# AudioWorklet.addModule all fail under the file:// origin, and getUserMedia
# needs a secure context. http://127.0.0.1 satisfies both.

. "$PSScriptRoot\config.ps1"

$panelDir = Join-Path $Global:MateRoot "panel"

Write-Host "Panel: http://$Global:PanelHost`:$Global:PanelPort/"
Write-Host ""

# Stdlib-only, so the base interpreter works just as well as the s2s env.
& $Global:MatePython (Join-Path $panelDir "server.py") `
    --host $Global:PanelHost `
    --port $Global:PanelPort `
    --root $panelDir
