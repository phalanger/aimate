# Starts only the lip-sync service, through the supervisor.
#
# Runs on its own interpreter, which is the reason it is a separate
# process at all: FlashHead needs torch 2.7.1, the voice pipeline needs 2.9.1,
# and MuseTalk - still selectable - pins 2.0.1. No interpreter satisfies all
# three. Which backend runs is decided by scripts\services.json, not here.
#
# Only needed for characters whose display mode is "real lip sync".

. "$PSScriptRoot\config.ps1"

& $Global:MatePython "$PSScriptRoot\supervisor.py" --only lipsync @args
exit $LASTEXITCODE
