# AI Computer Agent

An autonomous agent that controls a Windows VM to complete development feedback loops. It can:

- Merge GitHub PRs from Claude Code
- Check output files (PPT, Excel) from email attachments
- Compare outputs against requirements
- Request fixes from Claude Code
- Run your frontend to test services
- Read Railway logs for debugging

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Your PC (Host)                                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Host Controller (localhost:3000)                      │ │
│  │  - Web UI for task input                               │ │
│  │  - WebSocket server for VM communication               │ │
│  └────────────────────────────────────────────────────────┘ │
│         │                                                   │
│         │ WebSocket                                         │
│         ▼                                                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Windows VM (Hyper-V)                                  │ │
│  │  ┌──────────────────────────────────────────────────┐  │ │
│  │  │  Agent Daemon                                    │  │ │
│  │  │  - Takes screenshots → Claude Opus               │  │ │
│  │  │  - Executes actions (click, type, etc.)          │  │ │
│  │  │  - Checks guardrails before every action         │  │ │
│  │  ├──────────────────────────────────────────────────┤  │ │
│  │  │  Chrome | Outlook | Claude Code | File Explorer  │  │ │
│  │  └──────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Strict Guardrails

The agent CANNOT:
- Access Microsoft Teams (strictly blocked)
- Compose, reply, forward, or send any emails
- Access billing or payment pages
- Access Slack, Discord, WhatsApp, or other chat apps
- Read emails not from authorized automation senders

The agent CAN ONLY:
- Read emails from GitHub and your automation sender
- Download attachments from those emails
- Access GitHub (your repos only)
- Access your frontend
- Access Railway logs
- Use Claude Code CLI
- Access Downloads folder and shared folder

## Setup

### Step 1: Enable Hyper-V (Windows Pro/Enterprise)

```powershell
# Run PowerShell as Admin
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All
# Restart when prompted
```

### Step 2: Create Windows VM

1. Open Hyper-V Manager
2. Create new VM:
   - Name: `AI-Agent`
   - Generation: 2
   - RAM: 8192 MB (minimum 4096)
   - CPU: 4 cores
   - Disk: 60 GB
   - Network: Default Switch
3. Install Windows 11
4. Enable Enhanced Session Mode for clipboard sharing

### Step 3: Install Software in VM

```powershell
# Install Chocolatey (package manager)
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Install required software
choco install -y python311 nodejs git googlechrome vscode

# Install Claude Code
npm install -g @anthropic-ai/claude-code
```

### Step 4: Setup Shared Folder

On your host PC:
```powershell
mkdir C:\agent-shared
mkdir C:\agent-shared\downloads
mkdir C:\agent-shared\uploads
mkdir C:\agent-shared\logs
```

In Hyper-V, share this folder with the VM.

### Step 5: Install Agent in VM

```powershell
# Clone repo (or copy from shared folder)
git clone https://github.com/xvasjack/xvasjack.github.io.git
cd xvasjack.github.io/ai-computer-agent/vm

# Create virtual environment
python -m venv venv
.\venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt
```

### Step 6: Configure Agent

Create `vm/config_local.py`:

```python
from config import AgentConfig, GuardrailConfig, PathConfig

agent_config = AgentConfig(
    anthropic_api_key="sk-ant-...",  # Your API key
    host_ws_url="ws://192.168.1.100:3000/agent",  # Your host PC IP
)

guardrail_config = GuardrailConfig(
    allowed_email_senders=[
        "noreply@github.com",
        "your-automation@yourdomain.com",  # Your SendGrid sender
    ],
    github_allowed_repos=[
        "xvasjack",
    ],
    frontend_url="https://xvasjack.github.io",
)

path_config = PathConfig(
    repo_path=r"C:\Users\Agent\Projects\xvasjack.github.io",
    shared_folder=r"Z:\",  # Mapped shared folder
    download_folder=r"Z:\downloads",
)
```

### Step 7: Setup Host Controller

On your main PC:

```bash
cd ai-computer-agent/host
npm install
npm start
```

Open http://localhost:3000 in your browser.

### Step 8: Start Agent in VM

```powershell
cd ai-computer-agent/vm
.\venv\Scripts\Activate.ps1
python agent.py
```

## Usage

1. Open the Chat UI at http://localhost:3000
2. Enter a task description:
   ```
   Run target-v6 search for "logistics companies in Vietnam".
   Check the PPT output has at least 20 companies with valid logos.
   Fix any issues found.
   ```
3. Set the max duration (default: 2 hours)
4. Click "Start Task"
5. Review and approve the plan
6. Watch the agent work in the VM preview
7. Agent will iterate until satisfied or time runs out

## Task Examples

### Run a Search and Validate Output
```
Run target-v6 search for "packaging companies in Thailand".
Wait for the email with results.
Download the PPT and check:
- At least 20 companies
- All companies have logos
- All website links are valid
If issues found, tell Claude Code to fix and repeat.
```

### Check a Specific PR
```
Check PR #432 on xvasjack/xvasjack.github.io.
If CI passes, merge it.
If CI fails, copy the error logs and ask Claude Code to fix.
```

### Monitor Railway Logs
```
Open Railway dashboard for target-v6 service.
Check for any errors in the last hour.
If errors found, create a summary and ask Claude Code to investigate.
```

## File Structure

```
ai-computer-agent/
├── host/                    # Runs on your main PC
│   ├── server.js            # Express + WebSocket server
│   ├── public/
│   │   └── index.html       # Chat UI
│   └── package.json
│
├── vm/                      # Runs inside the VM
│   ├── agent.py             # Main agent loop
│   ├── computer_use.py      # Screenshot + input control
│   ├── guardrails.py        # Security guardrails
│   ├── config.py            # Configuration
│   ├── actions/
│   │   ├── github.py        # GitHub operations
│   │   ├── outlook.py       # Email operations
│   │   ├── frontend.py      # Your frontend
│   │   └── claude_code.py   # Claude Code CLI
│   ├── file_readers/
│   │   ├── pptx_reader.py   # PowerPoint analysis
│   │   └── xlsx_reader.py   # Excel analysis
│   └── requirements.txt
│
└── shared/
    └── protocol.py          # Message format
```

## Troubleshooting

### VM can't connect to host
- Check your host PC's IP address
- Ensure Windows Firewall allows port 3000
- Verify the VM is on the same network (Default Switch)

### Agent clicks wrong things
- Increase `screenshot_scale` for higher resolution
- Add wait times between actions
- Check if UI has changed

### Guardrail blocks legitimate action
- Update `allowed_email_senders` in config
- Check `guardrails.py` patterns

### Claude Code not found
- Ensure Claude Code is installed: `npm install -g @anthropic-ai/claude-code`
- Add to PATH or update `claude_code_path` in config

## Security Notes

- API keys are stored only in `config_local.py` (gitignored)
- All actions are logged in `guardrail_audit.log`
- The agent runs in an isolated VM
- Guardrails are enforced before every action
- Teams and email composition are hard-blocked in code
