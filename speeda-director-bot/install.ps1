Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot
py -3 -m pip install -r requirements.txt
py -3 -m playwright install chromium
Write-Host "Install complete."

