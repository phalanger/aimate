# Starts only the panel server, through the supervisor.
#
# Useful when the voice pipeline is already running and only the panel needs a
# restart: editing panel code should not cost a reload of Whisper and the TTS.
#
# Opening web\index.html directly will not work in any case. ES modules,
# fetch() and AudioWorklet.addModule all fail under the file:// origin, and
# getUserMedia needs a secure context. http://127.0.0.1 satisfies both.

. "$PSScriptRoot\config.ps1"

& $Global:MatePython "$PSScriptRoot\supervisor.py" --only panel @args
exit $LASTEXITCODE
