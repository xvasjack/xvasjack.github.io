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

# Discover Claude Code CLI (check 4 locations)
$claudeFound = $false

# 1. CLAUDE_CODE_PATH env var
if ($env:CLAUDE_CODE_PATH -and (Test-Path $env:CLAUDE_CODE_PATH)) {
    Write-Host "Claude CLI found via CLAUDE_CODE_PATH: $env:CLAUDE_CODE_PATH"
    $claudeFound = $true
}
# 2. Already on PATH
elseif (Get-Command claude -ErrorAction SilentlyContinue) {
    $env:CLAUDE_CODE_PATH = (Get-Command claude).Source
    Write-Host "Claude CLI found on PATH: $env:CLAUDE_CODE_PATH"
    $claudeFound = $true
}
# 3. npm global install location (%APPDATA%\npm\claude.cmd)
elseif ($env:APPDATA -and (Test-Path "$env:APPDATA\npm\claude.cmd")) {
    $env:CLAUDE_CODE_PATH = "$env:APPDATA\npm\claude.cmd"
    Write-Host "Claude CLI found at npm global: $env:CLAUDE_CODE_PATH"
    $claudeFound = $true
}
# 4. Ask npm for global root
else {
    try {
        $npmRoot = (npm root -g 2>$null)
        if ($npmRoot) {
            $npmBin = Split-Path $npmRoot -Parent
            $candidate = Join-Path $npmBin "claude.cmd"
            if (Test-Path $candidate) {
                $env:CLAUDE_CODE_PATH = $candidate
                Write-Host "Claude CLI found via npm root: $env:CLAUDE_CODE_PATH"
                $claudeFound = $true
            }
        }
    } catch {}
}

if (-not $claudeFound) {
    Write-Warning "Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
    Write-Warning "Searched: PATH, %APPDATA%\npm\claude.cmd, npm root -g"
}

# Install dependencies if needed
if (-not (Test-Path "__pycache__")) {
    Write-Host "Installing Python dependencies..."
    pip install -r requirements.txt
}

# Set defaults
if (-not $env:HOST_WS_URL) { $env:HOST_WS_URL = "ws://localhost:3000/agent" }
if (-not $env:REPO_PATH) { $env:REPO_PATH = "$env:USERPROFILE\xvasjack.github.io" }
if (-not $env:USER_EMAIL) { $env:USER_EMAIL = "xvasjack@gmail.com" }  # F4: Actual user email

# Check if host server is running on port 3000
$hostRunning = $false
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("localhost", 3000)
    $tcp.Close()
    $hostRunning = $true
    Write-Host "Host server already running on port 3000"
} catch {
    Write-Host "Host server not running on port 3000, attempting auto-start..."
    $hostServerPath = Join-Path (Split-Path $ScriptDir -Parent) "host" "server.js"
    if (-not (Test-Path $hostServerPath)) {
        Write-Error "ERROR: Host server not found at $hostServerPath"
        exit 1
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Error "ERROR: node not found. Install Node.js to auto-start host server"
        exit 1
    }
    $hostDir = Split-Path $hostServerPath -Parent
    Start-Process node -ArgumentList "server.js" -WorkingDirectory $hostDir -WindowStyle Hidden
    # Wait up to 10 seconds for port 3000
    $waited = 0
    while ($waited -lt 10) {
        Start-Sleep -Seconds 1
        $waited++
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $tcp.Connect("localhost", 3000)
            $tcp.Close()
            $hostRunning = $true
            Write-Host "Host server started after ${waited}s"
            break
        } catch {}
    }
    if (-not $hostRunning) {
        Write-Error "ERROR: Host server failed to start within 10 seconds"
        exit 1
    }
}

Write-Host "Starting AI Computer Agent..."
Write-Host "  Host: $env:HOST_WS_URL"
Write-Host "  Repo: $env:REPO_PATH"

python agent.py
