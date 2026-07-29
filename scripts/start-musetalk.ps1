# Starts only the lip-sync service, through the supervisor.
#
# Runs in its own conda environment: MuseTalk pins torch 2.0.1 with CUDA 11.8,
# while the voice pipeline needs torch 2.9 with CUDA 12.8. The two cannot share
# an interpreter, which is why this is a separate process at all.
#
# Only needed for characters whose display mode is "real lip sync".

. "$PSScriptRoot\config.ps1"

& $Global:MatePython "$PSScriptRoot\supervisor.py" --only lipsync @args
exit $LASTEXITCODE
