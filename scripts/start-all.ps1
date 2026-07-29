# Starts everything through the supervisor.
#
# The process table lives in services.json, not here. This script only picks an
# interpreter and hands over - so the launch arguments have one home, which the
# desktop shell will be able to read as well.

. "$PSScriptRoot\config.ps1"

& $Global:MatePython "$PSScriptRoot\supervisor.py" @args
exit $LASTEXITCODE
