# AI Computer Agent - Quick Setup

## Architecture (No VM!)

```
Windows 11 Machine
├── WSL (Ubuntu)
│   ├── host/server.js    ← Node server on :3000
│   ├── Claude Code CLI   ← Generates fixes (Max plan)
│   └── ppt_analyzer.py   ← Vision analysis
│
└── Windows (PowerShell)
    ├── windows/agent.py  ← PyAutoGUI automation
    ├── Screenshots       ← Screen capture
    └── Brave browser     ← Gmail, frontend
```

---

## Step 1: WSL Setup (Already Done)

```bash
# Start host server
bash ~/start-host.sh
```

Or manually:
```bash
cd /home/xvasjack/xvasjack.github.io/ai-computer-agent/host
node server.js
```

---

## Step 2: Windows Setup

### 2.1 Create folder structure
```powershell
New-Item -ItemType Directory -Force -Path "C:\agent\logs"
New-Item -ItemType Directory -Force -Path "C:\agent\windows"
New-Item -ItemType Directory -Force -Path "C:\agent-shared\templates\target-v6"
```

### 2.2 Create startup script
Save this as `C:\agent\start.ps1`:

```powershell
# AI Computer Agent - Windows Startup
$env:HOST_WS_URL = "ws://localhost:3000/agent"
$env:AGENT_DOWNLOAD_PATH = "$env:USERPROFILE\Downloads"

$logFolder = "C:\agent\logs"
New-Item -ItemType Directory -Force -Path $logFolder | Out-Null

# Copy files from WSL if needed
$wslPath = "\\wsl$\Ubuntu\home\xvasjack\xvasjack.github.io\ai-computer-agent\windows"
$agentPath = "C:\agent\windows"

if (-not (Test-Path "$agentPath\agent.py")) {
    Write-Host "Copying agent files from WSL..."
    Copy-Item -Recurse "$wslPath\*" $agentPath -Force
}

# Install dependencies if needed
if (-not (Test-Path "$agentPath\venv")) {
    Write-Host "Creating virtual environment..."
    cd $agentPath
    python -m venv venv
    .\venv\Scripts\Activate.ps1
    pip install -r requirements.txt
}

# Start agent
$logFile = "$logFolder\$(Get-Date -Format 'yyyy-MM-dd-HHmm').log"
Write-Host "Starting agent... Log: $logFile"
Write-Host "ABORT: Move mouse to TOP-LEFT corner"
Write-Host ""

cd $agentPath
.\venv\Scripts\Activate.ps1
python agent.py 2>&1 | Tee-Object -FilePath $logFile
```

### 2.3 Run it
```powershell
C:\agent\start.ps1
```

---

## Step 3: Template Screenshots (REQUIRED for PPT Analysis)

The agent compares output PPTs against template screenshots. You must create these manually.

### 3.1 Create folder structure
```powershell
New-Item -ItemType Directory -Force -Path "C:\agent-shared\templates\target-v6"
```

### 3.2 Capture template slides

**Option A: Using Snipping Tool (Recommended)**
1. Open `YCP Target List Slide Template.pptx`
2. Go to slideshow mode (F5)
3. Press `Win+Shift+S` to open Snipping Tool
4. Select full screen
5. Save as `C:\agent-shared\templates\target-v6\slide_01.png`
6. Press Right Arrow → repeat for each slide
7. Press Escape when done

**Option B: Using PowerShell Script**
```powershell
# Requires PowerPoint to be open in slideshow mode
$outputPath = "C:\agent-shared\templates\target-v6"
$slideNum = 1
while ($true) {
    $filename = "$outputPath\slide_$($slideNum.ToString('00')).png"
    # Use Add-Type for screenshot (or Snipping Tool manually)
    Write-Host "Save screenshot as: $filename"
    Read-Host "Press Enter after saving slide $slideNum (or 'q' to quit)"
    $slideNum++
}
```

### 3.3 Verify from WSL
```bash
ls -la /mnt/c/agent-shared/templates/target-v6/
# Should show: slide_01.png, slide_02.png, etc.
```

### 3.4 Template naming by service

| Service | Template Folder |
|---------|-----------------|
| target-v6 | `C:\agent-shared\templates\target-v6\` |
| target-v5 | `C:\agent-shared\templates\target-v5\` |
| profile-slides | `C:\agent-shared\templates\profile-slides\` |
| market-research | `C:\agent-shared\templates\market-research\` |

**IMPORTANT:** Without template screenshots, the agent cannot compare outputs!

---

## Step 4: Test

### Terminal 1 (WSL)
```bash
bash ~/start-host.sh
```

### Terminal 2 (Windows PowerShell)
```powershell
C:\agent\start.ps1
```

### Browser
Open http://localhost:3000
- Green dot = agent connected
- Type task and click Send

### Test API
```bash
curl -X POST http://localhost:3000/api/task \
  -H "Content-Type: application/json" \
  -d '{"description":"Test target-v6","context":{"type":"feedback_loop","service_name":"target-v6","business":"packaging","country":"Thailand","email":"your@email.com"}}'
```

---

## Before Bed Checklist

| Step | Action |
|------|--------|
| 1 | Close unnecessary apps |
| 2 | Open Brave, sign into Gmail (stay logged in) |
| 3 | Disable notifications: Focus Assist → Alarms Only |
| 4 | Disable screen lock: Settings → Accounts → Sign-in → Never |
| 5 | Disable sleep: Settings → System → Power → Never |
| 6 | WSL: `bash ~/start-host.sh` |
| 7 | PowerShell: `C:\agent\start.ps1` |
| 8 | Browser: http://localhost:3000 → Submit task |

---

## Abort Methods

| Method | How |
|--------|-----|
| **Fastest** | Move mouse to TOP-LEFT corner |
| **Kill agent** | Ctrl+C in PowerShell |
| **Kill all** | Close both terminals |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Agent disconnects | Restart both terminals |
| No green dot | Check WSL server is running |
| Gmail not found | Make sure Brave is open with Gmail |
| Import errors | Run `pip install -r requirements.txt` |

---

## File Locations

| What | Where |
|------|-------|
| Host server | `/home/xvasjack/xvasjack.github.io/ai-computer-agent/host/` |
| Windows agent | `C:\agent\windows\` (copied from WSL) |
| Templates | `C:\agent-shared\templates\{service}/` |
| Logs | `C:\agent\logs\` |
| Downloads | `C:\Users\{you}\Downloads\` |
