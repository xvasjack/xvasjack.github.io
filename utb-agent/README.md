# AI Computer Agent

An autonomous agent that controls your Windows desktop to complete development feedback loops. It can:

- Submit test inputs via your frontend (GitHub Pages)
- Wait for email results (Gmail, browser-based)
- Download and analyze output files (PPTX, Excel)
- Compare outputs against template requirements
- Request code fixes from Claude Code CLI
- Merge PRs via `gh` CLI
- Verify deployments via health checks
- Repeat until output matches template

## Architecture (No VM Required)

The agent runs natively on your Windows desktop + WSL. No Hyper-V VM needed.

```
Windows 11 Machine
├── WSL (Ubuntu)
│   ├── host/server.js    ← Node server on :3000 (web UI + WebSocket)
│   ├── Claude Code CLI   ← Generates fixes (Max plan, no API key)
│   └── ppt_analyzer.py   ← Vision analysis
│
└── Windows (PowerShell)
    ├── vm/agent.py       ← PyAutoGUI automation agent
    ├── Screenshots       ← Screen capture via mss
    └── Brave browser     ← Gmail, frontend, GitHub
```

## How It Works

1. **User submits task** via web UI at localhost:3000
2. **Agent generates plan** using Claude Code CLI (one call)
3. **Agent executes steps** via PyAutoGUI (click, type, navigate)
4. **For feedback loops**: submits form → waits for email → downloads output → analyzes → generates fix → merges PR → verifies deployment → repeats

## Guardrails

The agent has strict safety boundaries:

**BLOCKED:**
- Microsoft Teams, Slack, Discord, WhatsApp
- Email composition/sending (read-only access)
- Billing/payment pages
- Modifying protected files (.env, CI/CD, agent code)
- Destructive git commands (push --force, reset --hard)

**ALLOWED:**
- GitHub (your repos only, via `gh` CLI)
- Gmail (read emails, download attachments)
- Your frontend (form submission)
- Claude Code CLI (with mandate restrictions)
- Downloads folder

## Claude Code CLI Integration

The agent uses Claude Code CLI (`claude --print`) as its "brain":
- **No API key needed** — uses your Anthropic Max subscription ($200/month)
- **Each call is stateless** — context provided in the prompt
- **Mandate system** — every invocation includes rules about what files can be modified
- **PreToolUse hook** — blocks modifications to protected files

## Quick Start

See [SETUP.md](SETUP.md) for detailed instructions.

### Terminal 1 (WSL)
```bash
cd ~/xvasjack.github.io/ai-computer-agent/host
npm install
node server.js
```

### Terminal 2 (Windows PowerShell)
```powershell
C:\agent\start.ps1
```

### Browser
Open http://localhost:3000 → Green dot = agent connected → Submit task

## File Structure

```
ai-computer-agent/
├── host/                    # Runs in WSL
│   ├── server.js            # Express + WebSocket server
│   ├── public/index.html    # Web UI
│   └── package.json
│
├── vm/                      # Runs on Windows (NOT in a VM)
│   ├── agent.py             # Main agent loop
│   ├── computer_use.py      # Screenshot + PyAutoGUI input
│   ├── guardrails.py        # Security guardrails
│   ├── feedback_loop.py     # Feedback loop orchestration
│   ├── feedback_loop_runner.py  # Connects loop to implementations
│   ├── template_comparison.py   # Output vs template comparison
│   ├── config.py            # Configuration
│   ├── claude_mandate.md    # Rules prepended to Claude Code calls
│   ├── actions/
│   │   ├── github.py        # GitHub operations (gh CLI)
│   │   ├── gmail.py         # Gmail (browser automation)
│   │   ├── frontend.py      # Frontend form submission
│   │   └── claude_code.py   # Claude Code CLI integration
│   ├── file_readers/
│   │   ├── pptx_reader.py   # PowerPoint analysis
│   │   ├── xlsx_reader.py   # Excel analysis
│   │   └── docx_reader.py   # Word analysis
│   └── requirements.txt
│
├── shared/
│   └── protocol.py          # WebSocket message format
│
├── .claude/hooks/
│   └── agent_guard.py       # PreToolUse hook for protected files
│
├── SETUP.md                 # Setup instructions
└── ARCHITECTURE.md          # Technical architecture
```

## Security

- No API keys stored — Claude Code CLI uses Max subscription
- All actions logged in `guardrail_audit.log`
- PreToolUse hook blocks modifications to protected files
- Agent runs with PyAutoGUI failsafe (mouse to top-left corner = abort)
- Mandate system scopes Claude Code to relevant service directories
