# Start the AI Computer Agent (Windows VM side)
# Run this from PowerShell in the Windows VM

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

# Check Python
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "ERROR: python not found. Install Python 3.11+"
    exit 1
}

# Check Claude Code CLI
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Warning "claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
}

# Install dependencies if needed
if (-not (Test-Path "__pycache__")) {
    Write-Host "Installing Python dependencies..."
    pip install -r requirements.txt
}

# Set defaults
if (-not $env:HOST_WS_URL) { $env:HOST_WS_URL = "ws://localhost:3000/agent" }
if (-not $env:REPO_PATH) { $env:REPO_PATH = "$env:USERPROFILE\xvasjack.github.io" }

Write-Host "Starting AI Computer Agent..."
Write-Host "  Host: $env:HOST_WS_URL"
Write-Host "  Repo: $env:REPO_PATH"

python agent.py
