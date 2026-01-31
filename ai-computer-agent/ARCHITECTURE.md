# AI Computer Agent Architecture

## Overview

This system enables an autonomous development feedback loop:

```
User provides template + input + context
         ↓
Claude Code writes/fixes code → commit → push → PR
         ↓
Agent submits form on frontend (PyAutoGUI)
         ↓
Agent waits for email with output (Gmail)
         ↓
Agent downloads + analyzes output (PPTX/Excel)
         ↓
Agent compares output to template
         ↓
If issues found → Claude Code generates fix → merge PR → repeat
```

## Components

```
┌─────────────────────────────────────────────────────────────┐
│  Windows 11 Machine                                          │
│                                                              │
│  ┌──────────────────────────────────────┐                   │
│  │  WSL (Ubuntu)                        │                   │
│  │  ├── Host Controller (localhost:3000)│                   │
│  │  │   - Web UI for task input         │                   │
│  │  │   - WebSocket server              │                   │
│  │  │   - Task persistence (state.json) │                   │
│  │  └── Claude Code CLI                 │                   │
│  │      - Max plan auth (no API key)    │                   │
│  │      - Code edits, git, PRs          │                   │
│  └──────────────────────────────────────┘                   │
│         │ WebSocket (ws://localhost:3000/agent)              │
│         ▼                                                    │
│  ┌──────────────────────────────────────┐                   │
│  │  Windows (Native)                    │                   │
│  │  ├── Agent Daemon (vm/agent.py)      │                   │
│  │  │   - Plan generation via Claude CLI│                   │
│  │  │   - Action execution via PyAutoGUI│                   │
│  │  │   - Guardrail checks before each  │                   │
│  │  │     action                        │                   │
│  │  ├── GitHub ops (gh CLI)             │                   │
│  │  │   - PR status, merge, CI checks   │                   │
│  │  ├── Gmail (browser automation)      │                   │
│  │  │   - Search, open, download        │                   │
│  │  └── Brave browser                   │                   │
│  │      - Gmail, frontend, GitHub       │                   │
│  └──────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### Task Input
```
User → Web UI → Host server → WebSocket → Agent
```

### Feedback Loop (feedback_loop.py)
```
State Machine:
IDLE → TESTING_FRONTEND → WAITING_FOR_EMAIL → ANALYZING_OUTPUT
  ↑                                                    ↓
  └── CHECKING_LOGS ← WAITING_FOR_DEPLOY ← MERGING_PR ← GENERATING_FIX
```

### Template Comparison (template_comparison.py)
```
Output (PPTX/Excel)
        ↓
    File Reader (pptx_reader.py / xlsx_reader.py)
        ↓
    Analysis Dict {companies: [...], slides: [...]}
        ↓
    Compare to Template
        ↓
    ComparisonResult {discrepancies: [...]}
        ↓
    generate_claude_code_prompt()
```

## Claude Code Guardrails

### Layer 1: Protected Files (Hard-coded)
Files that can NEVER be modified:
- `.env`, `.env.*`, `credentials*`, `secrets*`
- `.github/workflows/*`
- `CLAUDE.md`
- `ai-computer-agent/**`
- `.git/config`, `*.pem`, `*.key`, `*.cert`

### Layer 2: Task-Scoped Restrictions
Each invocation limits Claude Code to relevant directories:
- "Fix target-v6" → `backend/target-v6/`, `backend/shared/`
- "Fix profile slides" → `backend/profile-slides/`, `backend/shared/`

### Layer 3: Mandate (claude_mandate.md)
Prepended to every Claude Code prompt with:
- Allowed directories
- Forbidden actions
- Commit/PR conventions
- Task context

### Layer 4: PreToolUse Hook (.claude/hooks/agent_guard.py)
Python script that intercepts every tool call:
- Blocks Edit/Write to protected files
- Blocks dangerous Bash commands

## Key Design Decisions

1. **No API Key Needed**: Claude Code CLI uses Max subscription ($200/month)
2. **Gmail over Outlook**: Browser-based, personal Gmail
3. **gh CLI over browser**: GitHub operations via `gh` CLI (reliable)
4. **Health check polling**: Deployment verification via `/health` endpoint
5. **Exponential backoff**: WebSocket reconnection uses 2s→60s backoff
6. **Clipboard paste**: Unicode text typed via Ctrl+V (pyperclip)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST_WS_URL` | `ws://localhost:3000/agent` | WebSocket URL |
| `CLAUDE_CODE_PATH` | `claude` | Claude Code binary |
| `REPO_PATH` | `~/xvasjack.github.io` | Git repo path |
| `AGENT_DOWNLOAD_PATH` | `~/Downloads` | Browser download folder |
| `FRONTEND_URL` | `https://xvasjack.github.io` | Frontend base URL |
| `GITHUB_OWNER` | `xvasjack` | GitHub username |
| `GITHUB_REPO` | `xvasjack.github.io` | GitHub repo name |
