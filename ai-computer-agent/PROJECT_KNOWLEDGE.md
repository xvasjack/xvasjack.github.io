# AI Computer Agent — Complete Project Knowledge Base

Last updated: 2026-01-31

---

## 1. WHAT THIS IS

Autonomous development feedback loop agent. User provides a task (e.g. "fix market-research output to match template"), agent:
1. Submits form on frontend (or skips if user says results already exist)
2. Waits for backend to email output (PPTX/XLSX/DOCX)
3. Downloads output from Gmail
4. Compares output against template
5. Uses Claude Code CLI to generate code fix
6. Creates PR, waits for CI, merges
7. Waits for Railway deploy
8. Repeats until output matches template

Also supports ad-hoc desktop automation (plan-based tasks) — but the feedback loop is the core.

---

## 2. WHERE THINGS RUN

**This is NOT a VM. The `vm/` directory name is historical. Everything runs on ONE Windows 11 machine with WSL.**

| Component | Where | Language | Auth |
|-----------|-------|----------|------|
| `host/server.js` | WSL Ubuntu | Node.js | - |
| `vm/agent.py` | Windows native | Python 3.11+ | - |
| Claude Code CLI | WSL (or Windows) | `claude --print` | **Anthropic Max subscription ($200/mo), NO API key** |
| `gh` CLI | Windows or WSL | Go binary | `gh auth login` |
| Brave browser | Windows | - | Gmail OAuth2 |
| Backends | Railway (remote) | Node.js | Railway deploy tokens |
| Frontend | GitHub Pages | Static HTML | - |

### How Claude Code CLI is invoked

All Claude CLI invocations go through `shared/cli_utils.py`:

```python
from shared.cli_utils import build_claude_cmd, get_repo_cwd

cmd = build_claude_cmd(CLAUDE_CODE_PATH, "--print", "--model", "opus", "--allowedTools", "Read,Edit,Write,Grep,Glob,Bash", prompt)  # prompt is positional, MUST be last
proc = await asyncio.create_subprocess_exec(*cmd, cwd=get_repo_cwd(), stdout=PIPE, stderr=PIPE)
```

- Uses Max subscription. **No ANTHROPIC_API_KEY needed.**
- `CLAUDE_CODE_PATH` env var (default: `"claude"`) — set to `"wsl:claude"` (with colon!) if Claude Code only installed in WSL
- `build_claude_cmd("wsl:claude", "--version")` → `["wsl", "-e", "claude", "--version"]`
- `get_repo_cwd("wsl:claude")` → `/home/xvasjack/xvasjack.github.io` (WSL path)
- `to_wsl_path(r"C:\Temp\foo.png")` → `/mnt/c/Temp/foo.png` (for vision temp files)
- Model string: `"opus"` everywhere (not the full ID)
- Timeout: 600s for fixes, 120s for plan generation, 45s for vision

### Where Claude Code CLI is used

| Module | Function | Purpose |
|--------|----------|---------|
| `vm/agent.py` | `_run_claude_subprocess()` | Plan generation for desktop automation |
| `vm/actions/claude_code.py` | `run_claude_code()` | Fix generation, CI fix, merge conflict fix |
| `vm/actions/vision.py` | `find_element()` | Find UI elements on screen via screenshot |
| `vm/actions/vision.py` | `ask_about_screen()` | Ask yes/no questions about what's on screen |

### Where Anthropic API is used (OPTIONAL, requires ANTHROPIC_API_KEY)

| Module | Class | Purpose |
|--------|-------|---------|
| `vm/research.py` | `ResearchAgent` | Root cause analysis when loop gets stuck |
| `vm/template_learner.py` | `TemplateLearner` | Learn quality patterns from successful outputs |

Both fall back gracefully if no API key. The agent works without them — just less smart when stuck.

---

## 3. THE TWO TASK TYPES

### Feedback Loop Task (`_run_feedback_loop_task`)

Triggered when task description contains keywords: `target-v3`, `target-v4`, `target-v5`, `target-v6`, `market-research`, `profile-slides`, `trading-comparable`, `validation`, `due-diligence`, `unit-to-business`, `feedback loop`.

**Current problem (as of 2026-01-31)**: The agent does NOT parse user intent from the description beyond extracting the service name. If user says "results already emailed, start from email", agent ignores this and starts with form submission anyway. `start_from` param exists in `feedback_loop_runner.py` but is only populated from `task.context` JSON, never from the description.

Flow:
1. Extract service name from keywords
2. Parse form_data from `task.context` JSON (needs Email, Business, Country)
3. Build plan summary, send to user for approval
4. On approval, call `feedback_loop_runner.run_feedback_loop()`
5. Runner creates `FeedbackLoop` and calls `loop.run()`

### Plan-based Task (`_run_plan_task`)

Triggered for any task that doesn't match feedback loop keywords.

Flow:
1. Call Claude Code CLI with desktop automation prompt
2. Get back JSON array of actions: `[{"action": "open_url", "params": {"url": "..."}}, ...]`
3. Show plan to user, wait for approval
4. Execute each step via PyAutoGUI (click, type, scroll, etc.)

Action types: `open_app`, `open_url`, `type`, `click`, `press`, `hotkey`, `scroll`, `wait`, `done`

---

## 4. FEEDBACK LOOP INTERNALS

### State Machine (feedback_loop.py `_run_iteration()`)

Each iteration runs these steps IN ORDER. No step can be skipped mid-iteration (only via `start_from` on first iteration):

1. **TESTING_FRONTEND** — Call `submit_form()` callback (retry 3x, 300s timeout)
2. **WAITING_FOR_EMAIL** — Call `wait_for_email()` callback (retry 2x)
3. **ANALYZING_OUTPUT** — Call `analyze_output()` callback (5min timeout)
   - If no issues → return "pass" → loop ends successfully
   - If stuck (same issues 3x) → try research, then "stuck"
4. **GENERATING_FIX** — Call `generate_fix()` callback (retry 2x, 600s timeout)
   - Uses Claude Code CLI with structured fix prompt from ComparisonResult
5. **MERGING_PR** — Wait for CI, then merge PR via `gh` CLI
   - Handles: merge conflicts, CI failures, review_required
6. **WAITING_FOR_DEPLOY** — Poll health endpoint (exponential backoff 15s→60s, max 10min)
7. **CHECKING_LOGS** — Check Railway logs (non-blocking)

Returns "continue" → next iteration.

### start_from Parameter

Controls what to skip on FIRST iteration only. After first iteration, all steps run normally.

| Value | Skips |
|-------|-------|
| `None` | Nothing — full loop |
| `"email_check"` | Form submission (submit returns `{"skipped": True}`) |
| `"analyze"` | Form submission AND email wait (needs `existing_file_path`) |

**How it works** (feedback_loop_runner.py:575-596):
```python
if start_from in ("email_check", "analyze"):
    # Wrap submit() to return {"skipped": True} on first iteration
    real_submit = submit
    async def submit():
        if not _first_iteration_done[0]:
            return {"success": True, "skipped": True}
        return await real_submit()

if start_from == "analyze" and existing_file_path:
    # Also wrap wait_email() on first iteration
    real_wait = wait_email
    async def wait_email():
        if not _first_iteration_done[0]:
            return {"success": True, "file_path": existing_file_path, "skipped": True}
        return await real_wait()
```

`_first_iteration_done[0]` is set to True after the first fix is generated.

### Callback Implementations (feedback_loop_runner.py)

| Callback | Primary Method | Fallback |
|----------|---------------|----------|
| `submit_form` | HTTP POST to Railway API (`frontend_api.py`) | Browser automation (`frontend.py`) |
| `wait_for_email` | Gmail API (`gmail_api.py`) | Browser Gmail (`gmail.py`), then Downloads folder scan |
| `analyze_output` | File readers + `template_comparison.py` | Auto-detect template |
| `generate_fix` | Claude Code CLI (`claude_code.py`) | - |
| `merge_pr` | `gh pr merge` | - |
| `wait_for_ci` | `gh pr checks` polling | - |

### Form Submission Details

**API POST** (`frontend_api.py`):
```python
async with session.post(url + "/api/" + service_name, json=form_data) as resp:
    ...
```
Railway URLs from `config.py RAILWAY_URLS` dict.

**Browser fallback** (`frontend.py`):
Opens `https://xvasjack.github.io/{service}.html`, fills form via PyAutoGUI + vision.

### Email Retrieval Details

**Gmail API** (primary): searches `subject:({subject_hint}) has:attachment newer_than:1h`

Service-to-subject mapping:
```python
"target-v3" through "target-v6" → "target search"
"market-research"               → "market research"
"profile-slides"                → "profile slide"
"trading-comparable"            → "trading comp"
"validation"                    → "validation result"
"due-diligence"                 → "due diligence"
"utb"                           → "utb"
```

**Downloads folder fallback**: scans `~/Downloads` for files matching service name, then any file <120s old with expected extension (.pptx, .xlsx, .docx).

### Crash Recovery

`loop_state.py` saves to `loop_state.json` at start/end of each iteration:
- service_name, iteration number, state, prs_merged, issue_tracker
- Atomic writes (write .tmp, then os.replace)
- On restart, resumes from interrupted iteration

### Stuck Detection

Uses LRU dict (max 100 entries) keyed by SHA256 of sorted issues. When same issues appear 3 times → triggers `ResearchAgent` (needs ANTHROPIC_API_KEY). Max 2 research attempts before giving up.

---

## 5. TEMPLATE COMPARISON

### Templates Defined in template_comparison.py

| Template Name | Type | Used By |
|---------------|------|---------|
| `target-search` | PPTTemplate | target-v3, v4, v5, v6 |
| `profile-slides` | PPTTemplate | profile-slides |
| `market-research` | PPTTemplate | market-research |
| `validation-results` | ExcelTemplate | validation |
| `trading-comps` | ExcelTemplate | trading-comparable |
| `dd-report` | DOCXTemplate | due-diligence |

### What Gets Checked

**PPTX**: slide count, company count, logos, websites, descriptions, blocked domains (facebook, linkedin, wikipedia, etc.), duplicates

**XLSX**: required sheets, row counts, required columns, data validation (URLs, numbers, no-empty)

**DOCX**: cover page fields, section numbering, table structure, Pre-DD Workplan rows, financial format (SGD '000)

### ComparisonResult → Claude Code Prompt

`generate_claude_code_prompt()` creates a structured fix prompt grouped by severity (CRITICAL, HIGH, MEDIUM). Each issue includes: category, location, expected vs actual, fix suggestion.

### Auto-Detection

If no template mapping exists, falls back to guessing by file type, slide count, sheet names, etc.

### Learned Templates (optional)

`template_learner.py` uses Anthropic API to learn from successful outputs. Saved to `vm/templates/` directory. Applied in addition to hardcoded templates.

---

## 6. COMMUNICATION

### WebSocket Protocol

**Message format**: `{"type": "<type>", "payload": {...}}`

**Message types** (shared/protocol.py):
```
NEW_TASK, TASK_UPDATE, TASK_RESULT,
PLAN_PROPOSAL, PLAN_APPROVED, PLAN_REJECTED,
USER_INPUT, PAUSE_TASK, RESUME_TASK, CANCEL_TASK,
SCREENSHOT_REQUEST, SCREENSHOT_RESPONSE
```

### Data Classes

- **Task**: id, description (max 50KB), context (max 100KB), max_duration_minutes (1-480), status
- **TaskUpdate**: task_id, status, message (max 10KB), screenshot_base64, iteration, prs_merged, elapsed
- **TaskResult**: task_id, status, summary, iterations, prs_merged, elapsed, output_files

### Host Server (server.js)

Express + WebSocket on port 3000.
- `/agent` endpoint: VM agent connects (one at a time)
- `/` endpoint: UI clients connect (multiple)
- State persisted to `state.json` every 30s
- Last 50 tasks in history
- Optional `AGENT_WS_SECRET` for auth

### Agent Connection (agent.py)

- Exponential backoff: 2s → 60s, max 10 retries
- Send queue: messages queued during disconnect (max 1000)
- Ping every ~2min to detect stale connections
- On WS disconnect: `_plan_event.set()` to unblock any pending approval
- Single task at a time (previous task cancelled if new arrives)
- Graceful shutdown via SIGINT/SIGTERM

### Browser UI (host/public/index.html)

- WebSocket auto-reconnect (3s delay)
- Task input field + Send button
- Plan approval box (Approve/Reject)
- Status bar: state, iteration, PRs merged, elapsed
- Log area with timestamps

---

## 7. GMAIL SETUP

### Gmail API (primary) — `vm/actions/gmail_api.py`

- Scope: `gmail.readonly`
- Credentials: `vm/credentials/gmail_credentials.json` (OAuth2 client from Google Cloud Console)
- Token: `vm/credentials/gmail_token.json` (auto-generated after first OAuth2 flow)
- First run: `flow.run_local_server(port=0)` — **needs browser, hangs on headless**
- After first run: token auto-refreshes, no browser needed

**Setup steps**:
1. Google Cloud Console → API & Services → Credentials → OAuth 2.0 Client ID
2. Download JSON → save as `vm/credentials/gmail_credentials.json`
3. Run with browser available: `cd vm && python3 -c "from actions.gmail_api import _get_gmail_service; _get_gmail_service()"`
4. Complete OAuth2 in browser → generates `gmail_token.json`

**Security**: sender whitelist (GitHub, SendGrid, configured SENDER_EMAIL), subject whitelist, download dir validation, path traversal protection, MIME depth limit (10 levels), file extension whitelist (.pptx, .xlsx, .docx, .pdf, .csv).

### Browser Gmail (fallback) — `vm/actions/gmail.py`

Uses PyAutoGUI + vision.py to automate Brave browser:
- Opens `https://mail.google.com`
- Vision-based element finding (Claude Code CLI analyzes screenshots)
- Blocked: compose, reply, forward, send, delete, archive (PermissionError)

---

## 8. FILE STRUCTURE

```
ai-computer-agent/
├── host/
│   ├── server.js              # Express + WS server (port 3000)
│   ├── public/index.html      # Browser UI
│   └── package.json           # deps: express, ws, uuid, cors
│
├── vm/
│   ├── agent.py               # Main: WS client, task dispatch, plan execution
│   ├── config.py              # All config: model, URLs, paths, guardrails
│   ├── computer_use.py        # PyAutoGUI wrapper: screenshot, click, type
│   ├── guardrails.py          # Blocked apps/URLs/processes/folders
│   ├── feedback_loop.py       # State machine: 7 steps per iteration
│   ├── feedback_loop_runner.py # Wires callbacks, manages start_from, crash recovery
│   ├── template_comparison.py # Output vs template comparison engine
│   ├── template_learner.py    # AI template learning (needs ANTHROPIC_API_KEY)
│   ├── research.py            # AI research for stuck issues (needs ANTHROPIC_API_KEY)
│   ├── verification.py        # State transition verification
│   ├── retry.py               # Generic retry with exponential backoff
│   ├── loop_state.py          # Crash recovery persistence
│   ├── claude_mandate.md      # Prepended to every Claude Code prompt
│   ├── requirements.txt       # Python deps
│   │
│   ├── actions/
│   │   ├── claude_code.py     # Claude Code CLI integration
│   │   ├── frontend.py        # Browser form filling (PyAutoGUI + vision)
│   │   ├── frontend_api.py    # Direct HTTP POST to Railway backends
│   │   ├── gmail.py           # Browser Gmail automation
│   │   ├── gmail_api.py       # Gmail API with OAuth2
│   │   ├── vision.py          # Screenshot analysis via Claude Code CLI
│   │   └── github.py          # GitHub ops via gh CLI
│   │
│   ├── file_readers/
│   │   ├── pptx_reader.py     # PowerPoint analysis
│   │   ├── xlsx_reader.py     # Excel analysis
│   │   └── docx_reader.py     # Word doc analysis
│   │
│   └── credentials/           # Gmail OAuth2 files (gitignored)
│       ├── gmail_credentials.json  # OAuth2 client (from Google Cloud)
│       └── gmail_token.json        # Refresh token (auto-generated)
│
├── shared/
│   └── protocol.py            # WS message types and data classes
│
├── .claude/hooks/
│   └── agent_guard.py         # PreToolUse hook for Claude Code
│
├── ARCHITECTURE.md
├── README.md
├── SETUP.md
├── PROJECT_KNOWLEDGE.md       # THIS FILE
└── .gitignore
```

### Root-level files (repo: xvasjack.github.io)

```
xvasjack.github.io/
├── CLAUDE.md                  # Context for ALL Claude Code invocations
├── ai-computer-agent/         # This project
├── backend/                   # 10+ microservice directories (the code being fixed)
│   ├── target-v3/
│   ├── target-v4/
│   ├── target-v5/
│   ├── target-v6/
│   ├── market-research/
│   ├── profile-slides/
│   ├── trading-comparable/
│   ├── validation/
│   ├── validation-v2/
│   ├── due-diligence/
│   ├── utb/
│   ├── financial-chart/
│   ├── transcription/
│   └── shared/                # Shared utilities
├── *.pptx                     # Template files for comparison
└── *.html                     # Frontend pages (GitHub Pages)
```

---

## 9. ENVIRONMENT VARIABLES

### Required

```bash
# None strictly required — Claude Code CLI uses Max subscription
# But these are needed for full functionality:

SENDER_EMAIL=your-sendgrid@domain.com    # Backend email sender (for Gmail whitelist)
```

### Important (with defaults)

```bash
HOST_WS_URL=ws://localhost:3000/agent    # Agent connects here
CLAUDE_CODE_PATH=claude                   # Or "wsl:claude" (with colon) if only in WSL
REPO_PATH=~/xvasjack.github.io           # Repo for Claude Code cwd
AGENT_DOWNLOAD_PATH=~/Downloads           # Where attachments go
FRONTEND_URL=https://xvasjack.github.io  # Frontend base URL
GITHUB_OWNER=xvasjack
GITHUB_REPO=xvasjack.github.io
```

### Optional

```bash
ANTHROPIC_API_KEY=sk-...                 # For research.py + template_learner.py
AGENT_WS_SECRET=...                      # WS auth (disabled if not set)
GMAIL_CREDENTIALS_PATH=vm/credentials/gmail_credentials.json
GMAIL_TOKEN_PATH=vm/credentials/gmail_token.json
LOOP_STATE_PATH=vm/loop_state.json
TEMPLATES_DIR=vm/templates/
```

### Timeout Overrides

```bash
TIMEOUT_HTTP_REQUEST=60
TIMEOUT_WEBSOCKET_RECV=120
TIMEOUT_SUBPROCESS=600
TIMEOUT_EMAIL_WAIT=300
TIMEOUT_CI_WAIT=1800
TIMEOUT_HEALTH_CHECK=10
TIMEOUT_PLAN_GENERATION=180
```

### Railway URLs (all have defaults: https://{service}.up.railway.app)

```bash
TARGET_V3_URL, TARGET_V4_URL, TARGET_V5_URL, TARGET_V6_URL
MARKET_RESEARCH_URL, PROFILE_SLIDES_URL, TRADING_COMPARABLE_URL
VALIDATION_URL, DUE_DILIGENCE_URL, UTB_URL
```

---

## 10. STARTUP CHECKLIST

```bash
# 1. Install Python deps (in VM/Windows)
cd ~/xvasjack.github.io/ai-computer-agent/vm
python3 -m pip install -r requirements.txt

# 2. Gmail OAuth2 setup (one-time, needs browser)
#    First: download credentials from Google Cloud Console
#    Then:
python3 -c "from actions.gmail_api import _get_gmail_service; _get_gmail_service()"

# 3. Verify tools
claude --version          # Claude Code CLI
gh auth status            # GitHub CLI

# 4. Clean git state
cd ~/xvasjack.github.io && git status   # should be clean

# 5. Start host (WSL terminal)
cd ~/xvasjack.github.io/ai-computer-agent/host
npm install   # first time
node server.js

# 6. Start agent (Windows terminal or another WSL terminal)
cd ~/xvasjack.github.io/ai-computer-agent/vm
python3 agent.py

# 7. Open UI
# http://localhost:3000
```

---

## 11. KNOWN ISSUES AND LIMITATIONS

### Critical (blocks execution)

| Issue | Detail |
|-------|--------|
| **Gmail creds required** | `vm/credentials/` must have OAuth2 files. First run needs browser. |
| **pywin32 only on Windows** | `requirements.txt` includes pywin32, won't install on Linux/WSL |
| **Claude CLI OOMs in WSL** | `claude --print` can crash with JS heap OOM under constrained WSL memory. May need `NODE_OPTIONS=--max-old-space-size=4096`. |

### Recently Fixed (2026-01-31 audit)

| Fix | Detail |
|-----|--------|
| **`--message` flag removed** | Was not a valid Claude CLI flag. Prompt is now positional arg (last) in all 5 call sites. |
| **`waiting_for_vm` dispatch** | Server now dispatches pending tasks when agent reconnects (H1). |
| **Cancel without agent** | `waiting_for_vm` tasks can now be cancelled from UI even when agent disconnected (H2). |
| **Duplicate agent clobber** | Old agent connection closed before storing new one; close handler scoped (H3). |
| **`plan_proposal` task_id check** | Stale proposals from cancelled tasks no longer corrupt current task (H4). |
| **`utb` false positives** | Changed keyword from `"utb"` to `"unit-to-business"` to avoid matching "distribute", "contribute", etc. (H5). |
| **Subprocess timeout** | Now uses `TIMEOUTS["subprocess"]` (default 600s) instead of hardcoded 120s (M4). |
| **Messages cap** | `currentTask.messages` capped at 100 entries (M5). |
| **WS maxPayload** | WebSocket server limited to 10MB payload (M6). |
| **start.ps1 fixes** | Dead try/catch replaced with `$LASTEXITCODE`, pip install skipped if unchanged, stderr wrapped with `cmd /c` (M1-M3). |

### Structural

| Issue | Detail |
|-------|--------|
| No tests for agent code | `npm test` tests backend, not ai-computer-agent |
| Single task at a time | New task cancels old. No queue. |
| git stash not popped | `claude_code.py` stashes before invocation, never pops |
| utb has no template | `SERVICE_TO_TEMPLATE["utb"] = None` |
| 3 separate email whitelists | guardrails.py, gmail.py, gmail_api.py each have own lists |
| CORS wide open | server.js: `cors()` with no restrictions |
| Plan not customizable | User can only approve/reject the whole plan, not modify steps |

### Edge Cases

| Issue | Detail |
|-------|--------|
| signal.SIGALRM on Windows | `gmail.py._list_download_files()` uses SIGALRM (Unix only) |
| Max prompt 100KB | `claude_code.py` truncates prompts |
| Max response 1MB | `agent.py` truncates Claude responses |
| pyautogui.FAILSAFE | Moving mouse to top-left corner aborts actions |

---

## 12. BACKEND SERVICES (what the agent fixes)

All services: Express.js on Railway, 450MB memory limit, async email delivery.

API pattern: `POST /api/{service}` → `{ Business, Country, Exclusion, Email }` → results emailed.

| Service | Output Type | Template |
|---------|------------|----------|
| target-v3 | PPTX | target-search |
| target-v4 | PPTX | target-search |
| target-v5 | PPTX | target-search |
| target-v6 | PPTX | target-search |
| market-research | PPTX | market-research |
| profile-slides | PPTX | profile-slides |
| trading-comparable | PPTX+XLSX | trading-comps |
| validation | XLSX | validation-results |
| due-diligence | DOCX | dd-report |
| utb | ? | None |

Railway URLs: `https://{service}.up.railway.app`
Frontend: `https://xvasjack.github.io/{page}.html`

---

## 13. CLAUDE CODE MANDATE

Every Claude Code invocation is prepended with `vm/claude_mandate.md`:

```
# Agent Mandate
1. ONLY modify files in: {ALLOWED_DIRECTORIES}
2. NEVER modify: .env, .github/workflows/*, CLAUDE.md, ai-computer-agent/**
3. NEVER run destructive commands
4. NEVER modify tests to make them pass
5. ALWAYS run npm test after changes
6. ALWAYS commit as "Fix: <description>"
7. ALWAYS push to branch claude/{SERVICE_NAME}-fix-<desc>
8. ALWAYS create PR (never push to main)
```

Variables filled in per invocation: `{ALLOWED_DIRECTORIES}`, `{SERVICE_NAME}`, `{ITERATION_NUMBER}`, `{PREVIOUS_ISSUES}`, `{ORIGINAL_TASK}`, `{FIX_PROMPT}`

---

## 14. GUARDRAILS

### agent_guard.py (PreToolUse hook for Claude Code CLI)

Blocks modification of: `.env`, `credentials`, `secrets`, `.github/workflows/`, `CLAUDE.md`, `ai-computer-agent/`, `.git/config`, `.pem`/`.key`/`.cert` files.

Blocks bash commands: `rm -rf`, `push --force`, `reset --hard`, `format c:`, `del /s`, `rmdir /s`, `git push origin main`.

### guardrails.py (runtime action guardrails)

Blocked apps: cmd, powershell, regedit, taskmgr (as admin), etc.
Blocked URLs: banking sites, crypto exchanges, social media, OS settings, Anthropic billing.
Blocked processes: Cannot terminate system processes.
Allowed folders: `C:\Users\*\Downloads`, `C:\agent-shared`, `Z:\`.

---

## 15. GIT WORKFLOW

- Feature branches: `claude/{service}-fix-iter{N}`
- Commit format: `Fix: <description>`
- Always create PR, never push to main directly
- Run `npm test` before pushing
- `--delete-branch` on merge
- Merge conflicts: Claude Code CLI resolves via `fix_merge_conflict()`
- CI failures: Claude Code CLI resolves via `fix_ci_failure()`
