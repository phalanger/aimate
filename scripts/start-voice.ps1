# Starts the voice pipeline (VAD -> STT -> LLM -> TTS), through the supervisor.
#
# All four stages live in this one process, connected by queues - they are not
# separate services. The panel comes along automatically because the pipeline
# routes its LLM calls through the panel's proxy and makes a warm-up call while
# starting.
#
# Nothing here is character-specific: the browser drives persona and voice per
# session over the realtime socket.

. "$PSScriptRoot\config.ps1"

& $Global:MatePython "$PSScriptRoot\supervisor.py" --only voice @args
exit $LASTEXITCODE
