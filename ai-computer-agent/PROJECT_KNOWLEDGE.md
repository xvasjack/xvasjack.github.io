# AI Computer Agent — Complete Project Knowledge Base

Last updated: 2026-02-06 (pipeline quality overhaul — 4 workstreams)

---

## 1. WHAT THIS IS

Autonomous development feedback loop agent. User provides a task (e.g. "fix market-research output to match template"), agent:
1. Submits form on frontend (or skips if user says results already exist)
2. Waits for backend to email output (PPTX/XLSX/DOCX)
3. Downloads output from Gmail
4. Compares output against template
5. Uses Claude Code CLI to generate code fix
6. Commits and pushes directly to main (no PRs)
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
from shared.cli_utils import build_claude_cmd, get_subprocess_cwd

win_cwd, wsl_cwd = get_subprocess_cwd(CLAUDE_CODE_PATH)
cmd = build_claude_cmd(CLAUDE_CODE_PATH, "--print", "--model", "opus", "--allowedTools", "Read,Edit,Write,Grep,Glob,Bash", prompt, wsl_cwd=wsl_cwd)  # prompt is positional, MUST be last
proc = await asyncio.create_subprocess_exec(*cmd, cwd=win_cwd, stdout=PIPE, stderr=PIPE)  # win_cwd=None in WSL mode
```

- Uses Max subscription. **No ANTHROPIC_API_KEY needed.**
- `CLAUDE_CODE_PATH` env var (default: `"claude"`) — set to `"wsl:claude"` (with colon!) if Claude Code only installed in WSL
- `build_claude_cmd("wsl:claude", "--version", wsl_cwd="/home/xvasjack/...")` → `["wsl", "--cd", "/home/xvasjack/...", "-e", "claude", "--version"]`
- `get_subprocess_cwd("wsl:claude")` → `(None, "/home/xvasjack/xvasjack.github.io")` — pass cwd=None to subprocess, wsl_cwd to build_claude_cmd
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

Triggered when task description contains keywords: `target-v3`, `target-v4`, `target-v5`, `target-v6`, `market-research`, `profile-slides`, `trading-comparable`, `validation`, `due-diligence`, `utb`, `feedback loop`.

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
   - Claude commits and pushes directly to main (no PRs)
5. **VERIFYING_PUSH** — Verify git push succeeded (push-to-main flow)
   - If push failed, log error and continue to next iteration
6. **WAITING_FOR_DEPLOY** — Poll health endpoint (exponential backoff 15s→60s, max 10min)
   - Only runs if code was actually pushed
   - No health URL: reduced to 30s blind wait
7. **CHECKING_LOGS** — Check Railway logs (120s timeout, wrapped in try/except)

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
| ~~`merge_pr`~~ | ~~`gh pr merge`~~ | **Removed — push-to-main flow** |
| ~~`wait_for_ci`~~ | ~~`gh pr checks` polling~~ | **Removed — push-to-main flow** |

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

**Gmail API** (primary): searches `subject:({subject_hint}) has:attachment` (no time filter — Gmail returns newest first, grabs latest match regardless of age)

Service-to-subject mapping (exact prefixes matching backend email subjects):
```python
"target-v3"          → "[V3]"
"target-v4"          → "[V4]"
"target-v5"          → "[V5]"
"target-v6"          → "[V6]"
"market-research"    → "Market Research:"
"profile-slides"     → "Profile Slides:"
"trading-comparable" → "Trading Comps:"
"validation"         → "Speeda List Validation:"
"due-diligence"      → "DD Report:"
"utb"                → "utb"
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

**PPTX (structural)**: slide count, company count, logos, websites, descriptions, blocked domains (facebook, linkedin, wikipedia, etc.), duplicates

**PPTX (formatting)** — added 2026-02-02:
- `text_overflow` (CRITICAL): text exceeds shape boundary (estimated lines > available lines)
- `content_overlap` (HIGH): shapes overlap vertically (y+height > next shape y)
- `title_font_size_mismatch` (HIGH): title font size differs from reference template
- `title_color_mismatch` (HIGH): title color differs from reference template
- `missing_header_lines` (HIGH): content slides missing divider line vs reference
- `font_family_mismatch` (MEDIUM): wrong font family vs reference
- `subtitle_font_size_mismatch` / `subtitle_color_mismatch` (MEDIUM)
- Formatting values are learned at runtime from reference PPTX, not hardcoded

**PPTX (content depth)** — added 2026-02-02:
- `shallow_descriptions` (HIGH): >30% of companies have descriptions below `min_words_per_description`
- `thin_slides` (HIGH): >30% of content slides have fewer than `min_content_paragraphs` text blocks
- `missing_actionable_insights` (CRITICAL): <20% of content slides contain actionable keywords (only when `require_actionable_content=True`)
- `generic_content` (HIGH): >50% of descriptions contain shallow filler phrases ("is a company that", "was founded in", etc.)

**XLSX**: required sheets, row counts, required columns, data validation (URLs, numbers, no-empty)

**DOCX**: cover page fields, section numbering, table structure, Pre-DD Workplan rows, financial format (SGD '000)

### PPTTemplate Content Depth Fields (added 2026-02-02)

```python
min_words_per_description: int = 40      # min words per company description
min_content_paragraphs: int = 3          # min text blocks per content slide
require_actionable_content: bool = False  # check for recommendation/strategy language
content_depth_keywords: List[str]         # words indicating substantive content
shallow_content_phrases: List[str]        # red flags for generic filler
```

Configured per template:
- `market-research`: 50 word min, actionable required, strict keywords+phrases
- `profile-slides`: 40 word min, actionable not required, moderate keywords+phrases
- `target-search`: defaults (40 word min, no actionable check)

### Formatting Profile System (added 2026-02-02)

`pptx_reader.extract_formatting_profile()` reads a PPTX and returns `FormattingProfile`:
- Per-shape: position (x,y,w,h in inches), font (name, size, color, bold), text length, line estimates
- Per-slide: shapes, title/subtitle font info, header line count/positions
- Aggregate: mode/median of title font, subtitle font, header lines, font family, content start y
- Overflow detection: estimated text lines > available lines per shape
- Overlap detection: shapes sorted by y, y+height > next shape's y

Reference templates per service in `template_comparison.SERVICE_REFERENCE_PPTX`:
- market-research → `Market_Research_energy_services_2025-12-31 (6).pptx`
- profile-slides → `YCP profile slide template v3.pptx`
- target-search → `YCP Target List Slide Template.pptx`
- trading-comps → `trading comps slide ref.pptx`

### Template Reference File

`vm/template_reference.md` — MBB-quality content standards per service. Loaded by `feedback_loop_runner._load_template_reference()` and appended to every fix prompt so Claude Code knows expected content depth. Sections: Market Research, Profile Slides, Target Search, Due Diligence Report.

### Formatting Spec File

`MARKET_RESEARCH_FORMATTING_SPEC.md` — font/color/layout rules. Loaded by `feedback_loop_runner._load_formatting_spec()` and included in fix prompts when formatting issues detected. Includes pptxgenjs-specific fix hints (adjust h, y, color hex, fontSize).

### ComparisonResult → Claude Code Prompt

`generate_claude_code_prompt()` creates a structured fix prompt grouped by severity (CRITICAL, HIGH, MEDIUM). Each issue includes: category, location, expected vs actual, fix suggestion. The fix prompt is then augmented with:
1. `template_reference.md` section via `_load_template_reference()` — content quality
2. `MARKET_RESEARCH_FORMATTING_SPEC.md` via `_load_formatting_spec()` — formatting (only when formatting issues detected)

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
│   ├── template_comparison.py # Output vs template comparison engine (structural + content depth)
│   ├── template_reference.md  # MBB content depth standards per service (read by fix prompts)
│   ├── run_loop.py            # One-shot feedback loop runner (python run_loop.py)
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
│   ├── cli_utils.py           # Claude CLI WSL helpers: build_claude_cmd, get_subprocess_cwd
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
AGENT_BROWSER=brave                       # Browser for automation (brave, chrome, edge)
USER_EMAIL=xvasjack@gmail.com             # Default email for feedback loop tasks
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

### Railway URLs (defaults updated 2026-02-01 to match actual production)

```bash
# Defaults now use actual production URLs (e.g. target-v3-production.up.railway.app)
# Set env vars to override:
TARGET_V3_URL, TARGET_V4_URL, TARGET_V5_URL, TARGET_V6_URL
MARKET_RESEARCH_URL, PROFILE_SLIDES_URL, TRADING_COMPARABLE_URL
VALIDATION_URL, DUE_DILIGENCE_URL, UTB_URL
USER_EMAIL=your-email@example.com    # B4: Default email for feedback loop tasks
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
| **pywin32 only on Windows** | `requirements.txt` now has `; sys_platform == 'win32'` marker (F77) |
| **Claude CLI OOMs in WSL** | `claude --print` can crash with JS heap OOM under constrained WSL memory. May need `NODE_OPTIONS=--max-old-space-size=4096`. |

### Recently Fixed (2026-02-06 — Pipeline Quality Overhaul)

**4 Workstreams completed:**
- **WS1**: Removed 32 fabricated filler strings from `ppt-single-country.js` (-302 lines net). Wired synthesis data to 7 slide types. Added `return` after `addDataUnavailableMessage` to prevent orphaned elements. Removed filler from `ppt-utils.js` `enrichCompanyDesc`.
- **WS2**: Replaced single-strategy JSON extraction in 4 research agents (market, competitor, depth, insights) with `extractJsonFromContent` (6 strategies) + automatic retry on failure. Added array regex strategy 2.5. Exported `extractJsonFromContent` for testing.
- **WS3**: Extracted regulation, data point, and company counting into helper functions (`_count_regulations`, `_count_data_points`, `_count_companies`) in `template_comparison.py`. Broader pattern matching for accurate scoring. Created `original_text` for case-sensitive company detection.
- **WS1C**: Removed `scores.overall >= 50` bypass from `validateContentDepth` in `research-orchestrator.js` so re-research triggers on content depth failures.
- **Tests**: 21 Python tests for scoring helpers, 10 JS tests for JSON extraction. All 1285 backend tests pass.

### Previously Fixed (2026-02-01 — 80-issue audit, 60 fixes across 21 files)

**Phase 1-5 Fix Summary (F1-F77)**:
- **F1**: Service name aliases (e.g. "market-assessment" → "market-research")
- **F2**: Terminal logging after task result
- **F3**: Removed slow Claude CLI intent parsing, keyword-only
- **F4**: USER_EMAIL set to xvasjack@gmail.com
- **F5**: KeyError on body['Business'] in frontend_api.py
- **F6-F13**: Deploy wait skipped if no code pushed, check_logs timeout, actual iteration count
- **F18-F19**: Protocol validation, sendToAgent() helper with readyState check
- **F20**: Windows ctypes screen resolution detection
- **F21-F28**: Brave browser support, Gmail load wait 8s, vision-based clicks (no keyboard shortcuts)
- **F29-F30**: Clipboard save/restore, click coordinate validation
- **F31-F42**: UI plan box fixes, server state persistence, debounced saves, stale task cleanup
- **F43-F45**: try-catch per message type, cancel_token in retry, analyze_output retry
- **F49-F50**: WSL-wrapped gh and curl in verification.py
- **F51**: Normalized issue keys for stuck detection
- **F54-F56**: Reduced blind wait 120→30s, curl error capture, state save error level
- **F67**: get_repo_cwd uses REPO_PATH env var in WSL mode too
- **F68**: config_local merges fields instead of replacing entire objects
- **F69-F70**: guardrails.py import fix, word boundary on "billing" pattern
- **F72-F73**: fsync before os.replace, type validation on loaded state fields
- **F77**: pywin32 platform marker in requirements.txt
- **MAJOR**: Replaced entire PR/CI/merge flow with push-to-main (~200 lines removed)

### Previously Fixed (2026-02-01 comprehensive audit — 80+ fixes)

**Tier 1 Blocking (B1-B12)**:
- **B1: WinError 267** — subprocess cwd was WSL path on Windows. Now uses `get_subprocess_cwd()` → `(None, wsl_cwd)` and `wsl --cd` flag. Fixed in cli_utils.py, agent.py, claude_code.py, feedback_loop.py, github.py, verification.py.
- **B2: UI running flag** — `setRunning(true)` now called in task_update handler (was only in task_created).
- **B3: No progress updates** — Agent sends updates before intent parsing, plan generation, and approval wait.
- **B4: Email never provided** — Falls back to `USER_EMAIL` env var.
- **B5: utb keyword** — Reverted "unit-to-business" back to "utb" — false positive risk acceptable, service lookup was broken.
- **B6: asyncio.run in executor** — `get_plan_from_claude` is now fully async.
- **B7: Wrong form fields** — `frontend_api.py` now has per-service field mapping (10 services).
- **B8: Email timeout clamped** — Passes explicit `email_wait_timeout_minutes * 60` instead of `step_timeout=0`.
- **B9: Wrong API paths** — target services now use `/api/find-target`, `/api/find-target-v4`, etc.
- **B10: Wrong Railway URLs** — All 10 fallback URLs updated to actual production URLs.

**Tier 2 Critical (C1-C21)**:
- **C1**: `from vision import` → `from actions.vision import` (8 locations in gmail.py + frontend.py).
- **C2**: All `gh` CLI calls WSL-wrapped via `is_wsl_mode()` check (github.py, verification.py, feedback_loop.py).
- **C3**: `git stash` uses WSL-aware command construction.
- **C4**: WebSocket sends serialized via `asyncio.Lock()` in agent.py.
- **C5**: `threading.Lock` removed from `LRUDict` — blocks event loop; access is single-coroutine.
- **C6**: Plan approval tracks `_plan_task_id` to prevent cross-task approval.
- **C7**: `ws.send()` guarded with null/readyState check in UI.
- **C8**: `JSON.parse` wrapped in try/catch in UI `ws.onmessage`.
- **C9**: Dead `_needs_reconnect` code removed entirely (set in 4 places, never read).
- **C10**: Safe int parsing for TIMEOUT env vars with `_safe_int()` helper.
- **C11**: Agent disconnect marks running task as `failed` (was orphaned in `running` forever).
- **C12**: `reject_plan` now transitions task to `cancelled` and broadcasts update.
- **C13**: `gh pr create` subprocess killed on timeout to prevent resource leak.
- **C14**: `LRUDict` converted to `dict()` before JSON serialization in `_save_state`.
- **C15**: Vision coordinate validation `<= 0` → `< 0` (allows (0,0) top-left).
- **C16**: `get_all_windows()` wrapped in `run_in_executor()` for async contexts.
- **C17**: Cancelled task not re-dispatched on reconnect (already correct by design).
- **C18**: Task status validated against whitelist before applying in server.js.
- **C19**: `httpx.Timeout()` syntax fixed (keyword arg `timeout=`).
- **C20**: `ppt_analyzer.py` loop variable shadowing fixed in 3 list comprehensions.

**Tier 3 High (selected H1-H28)**:
- **H1**: Reconnect restores plan approval box for `awaiting_approval` tasks.
- **H7**: Send button debounced (2s cooldown).
- **H14**: `_wait_for_deployment` returns `False` (not `True`) when curl not found.
- **H16**: HTTP approve endpoint rejects if task not in `awaiting_approval`.
- **H17**: Guardrails email sender uses domain-anchored matching.
- **H18**: `delete_template()` uses `os.path.basename()` to prevent path traversal.
- **H19**: Vision resolution detection instead of hardcoded 1920x1080.
- **H21**: VM agent error handler nulls `state.vmAgent`.
- **H27**: `agent_guard.py` blocks force push variants (`-f`, `--force`, `--force-with-lease`).

**Tier 4 Medium (selected M1-M24)**:
- **M1**: `CLAUDE_STREAM` message type added to protocol.py.
- **M2**: Screenshot handler added in UI.
- **M3-M6**: Plan box CSS (max-height, overflow), word-wrap, ws.onclose/onerror handlers.
- **M7**: JSON parse failures logged at WARNING not DEBUG.
- **M10**: Version check has 10s timeout.
- **M14/M21**: Retry backoff capped at `max_delay=300s`.
- **M15/M23**: `broadcastToUI` wraps individual sends in try-catch.
- **M16**: Duplicate `sys.path.insert` calls removed from vision.py.
- **M18**: File descriptor leak on `os.fdopen()` failure fixed.
- **M20**: Guardrails folder check normalizes paths with `os.path.realpath()`.
- **M24**: `setInterval` handles stored and cleared on graceful shutdown.

### Previous fixes (2026-01-31 audit)

| Fix | Detail |
|-----|--------|
| **`--message` flag removed** | Was not a valid Claude CLI flag. Prompt is now positional arg (last) in all 5 call sites. |
| **`waiting_for_vm` dispatch** | Server now dispatches pending tasks when agent reconnects (H1). |
| **Cancel without agent** | `waiting_for_vm` tasks can now be cancelled from UI even when agent disconnected (H2). |
| **Duplicate agent clobber** | Old agent connection closed before storing new one; close handler scoped (H3). |
| **`plan_proposal` task_id check** | Stale proposals from cancelled tasks no longer corrupt current task (H4). |
| **Subprocess timeout** | Now uses `TIMEOUTS["subprocess"]` (default 600s) instead of hardcoded 120s (M4). |
| **Messages cap** | `currentTask.messages` capped at 100 entries (M5). |
| **WS maxPayload** | WebSocket server limited to 10MB payload (M6). |
| **start.ps1 fixes** | Dead try/catch replaced with `$LASTEXITCODE`, pip install skipped if unchanged, stderr wrapped with `cmd /c` (M1-M3). |

### Structural

| Issue | Detail |
|-------|--------|
| No tests for agent code | `npm test` tests backend, not ai-computer-agent |
| Single task at a time | New task cancels old. No queue. |
| ~~git stash not popped~~ | Fixed (F11): `claude_code.py` now pops stash after invocation |
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

Railway URLs: Production URLs vary per service (see `config.py RAILWAY_URLS`)
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
7. ALWAYS commit and push directly to main
8. NEVER create PRs — push-to-main workflow
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

**Push-to-main (current)**: Agent commits and pushes directly to main. No PRs, no CI wait, no merge.
- Commit format: `Fix: <description>`
- Run `npm test` before pushing
- Railway auto-deploys from main push
- `merge_pr()`, `wait_for_ci()`, `fix_merge_conflict()` functions still exist but are not called

**Previous (deprecated)**: Feature branches → PR → CI → merge. Eliminated ~200 lines of PR/CI/merge logic.

## 16. USER ENVIRONMENT

- **Browser**: Brave (default). Set `AGENT_BROWSER` env var to change. Chrome also installed.
- **Gmail keyboard shortcuts**: OFF (default). Agent uses vision-based clicks and Ctrl+/ fallback, not keyboard shortcuts.
- **Email**: xvasjack@gmail.com (set via `USER_EMAIL` env var)
- **NOT a VM**: Agent runs directly on Windows 11 laptop with WSL. `vm/` directory name is historical.
- **Screen resolution**: Auto-detected via Windows ctypes (`GetSystemMetrics`), falls back to xdpyinfo/xrandr, then 1920x1080.

---

## 17. MARKET-RESEARCH REBUILD (2026-02-03)

Major rebuild of the market-research PPTX generation pipeline. Template becomes a pattern library + quality bar, not a rigid 27-slide recipe.

### Architecture Changes

**Before**: Hardcoded 27-slide structure, monolithic DeepSeek synthesis, generic scoring.
**After**: Dynamic section-based generation, per-section Gemini synthesis, pattern-based layout, content-depth scoring.

### New Files Created

| File | Purpose |
|------|---------|
| `ai-computer-agent/vm/pattern_extractor.py` | Extracts 12 layout patterns from reference PPTX using python-pptx |
| `ai-computer-agent/vm/issue_pattern_detector.py` | Detects recurring failures in issue history (3+ same failure = change approach) |
| `backend/market-research/template-patterns.json` | 12 layout patterns with exact positions/fonts/colors from template |
| `backend/market-research/issue-history.json` | Per-iteration scoring history for self-learning loop |

### Files Modified (Heavy)

| File | Change |
|------|--------|
| `backend/market-research/ai-clients.js` | Added `callGemini()` with Gemini 2.0 Flash, fallback to DeepSeek |
| `backend/market-research/research-orchestrator.js` | Per-section Gemini synthesis (policy/market/competitors/summary), depth-demanding prompts, content validation, removed AI reviewer |
| `backend/market-research/ppt-utils.js` | Added 10 layout functions: `choosePattern`, `addDualChart`, `addChevronFlow`, `addInsightPanelsFromPattern`, `addCalloutOverlay`, `addMatrix`, `addCaseStudyRows`, `addFinancialCharts`, `addColoredBorderTable` + `templatePatterns` export |
| `backend/market-research/ppt-single-country.js` | Replaced hardcoded 27-slide + Story Architect with section-based generation. Uses `classifyDataBlocks()` → `choosePattern()` → pattern-specific renderers. Market charts use insight panels layout (chart 60% + callouts 40%). Dynamic slide count per section. 3265→1868 lines |
| `ai-computer-agent/vm/template_comparison.py` | Added market-research content-depth + pattern-match scoring. **Now populates** ComparisonResult.content_depth_score/insight_score/regulation_count/data_point_count/company_indicator_count on the result object (were computed but never assigned) |
| `ai-computer-agent/vm/feedback_loop.py` | Added `_check_service_health()` (Railway health check before iterations), `_check_hollow_output()` (>50% empty = abort) |
| `ai-computer-agent/vm/feedback_loop_runner.py` | Added issue history context, pattern detection, priority rules. **Now includes**: `_build_deep_analysis_context()` showing actual slide text/scores/diagnosis to fix agent; `form_data` threaded to fix prompt so agent sees original user request; deep analysis injected for content_depth/insight_missing/research_quality/empty_data issues |
| `ai-computer-agent/vm/claude_mandate.md` | Replaced generic "THINK BEFORE FIXING" with 4-step deep analysis protocol requiring reading output excerpts and tracing data flow before writing code |
| `ai-computer-agent/host/ppt_analyzer.py` | Simplified to PASS/FAIL with content_depth/pattern_match/formatting categories |

### Files Deleted

| File | Reason |
|------|--------|
| `backend/market-research/compare-to-template.js` | Replaced by template_comparison.py pattern-based scoring |

### 12 Layout Patterns

Cover, TOC/Divider, 2×2 Matrix, Label-Row Table, Multi-Column Data Table, Text-Heavy Policy Block, Chart+Insight Panels (chart left 60% + 2-3 callout panels right 40%), Chart+Callout Boxes (5 sub-variations), Case Study Rows, Dual Chart Financial, Diagram+Text Split, Glossary Table.

### Synthesis Flow

1. Kimi web search (15 topics, unchanged)
2. Per-section Gemini synthesis with depth-demanding prompts (fallback: Gemini → DeepSeek → null)
3. Content validation: ≥3 regulations, ≥3 data series, ≥3 companies. Score 0-100 per section
4. Weak sections (<50) get re-researched
5. >50% empty after retry → abort, don't email hollow PPT

### Self-Learning Loop

- `issue-history.json`: Each iteration appends scores + failures + fixes
- `issue_pattern_detector.py`: Same failure 3+ times → "change approach, don't patch"
- Fix prompts include last 3 iteration issues + pattern detection results + priority rules

### Key Environment Variables Added

```bash
GEMINI_API_KEY    # Required for per-section synthesis (fallback to DeepSeek if missing)
```

---

## 18. ANTI-FABRICATION GUARDRAILS (2026-02-06)

After 7 commits injected ~800 lines of fake data (fake URLs, fake companies, fake regulations) to mask empty research results, a 3-layer defense system was implemented.

### The Problem

The fix agent fabricated content because:
1. Mandate said "don't hardcode" but LLM ignored it under iteration pressure
2. No enforcement mechanism — agent could bypass soft rules
3. No escape valve — agent had to "solve at any cost" even when impossible

### Layer 1: PreToolUse Hook (HARD)

**File**: `.claude/hooks/agent_guard.py`
**Activation**: `.claude/settings.json` → `hooks.PreToolUse`

Blocks Edit/Write to `backend/` containing fabrication patterns:
- Fake URLs: `https://www.word-word-word.com.xx`
- Fallback functions: `getFallback*Content`, `getDefaultChartData`
- Fake company names: `Local Energy Services Co.`
- Estimated amounts: `$50B (estimated)`
- Fake regulations: `Energy Conservation Act`
- Hardcoded year arrays: `[2019, 2020, 2021, 2022, 2023]`

Also blocks Bash file writes to backend (must use Edit tool).

**Scoped via AGENT_MODE=1**: Only active when agent subprocess runs. User's manual Claude Code sessions unaffected.

### Layer 2: Diff Validator (HARD)

**File**: `vm/feedback_loop_runner.py` → `_validate_no_fabrication()`

After Claude Code returns, scans the full git diff (up to 100K chars) for same fabrication patterns. If match found:
- Sets `result["success"] = False`
- Sets `result["error"] = "Fix rejected: FABRICATION DETECTED"`
- Next iteration prompt automatically includes rejection reason

Agent cannot bypass — parent process controls the diff.

### Layer 3: CANNOT_FIX Escape Valve

**File**: `vm/claude_mandate.md`

If agent determines the issue is unfixable without human help (e.g., Kimi/Gemini returning empty data), it can:
1. Create `backend/{service}/CANNOT_FIX.md` explaining root cause
2. Commit with message "Diagnostic: [description]"

Feedback loop detects this file in diff and returns `{"needs_human": True}`, stopping the loop instead of continuing to iterate.

### Research Pipeline Fixes

**File**: `backend/market-research/research-agents.js`
- Added `extractJsonFromContent()` — 4-strategy JSON extraction
- Retry with simplified prompt on extraction failure

**File**: `backend/market-research/research-orchestrator.js`
- `validateCompetitorsSynthesis()` — warns on empty players, applies honest fallbacks
- `validateMarketSynthesis()` — warns on missing chart data, honest keyInsight fallbacks
- `validatePolicySynthesis()` — warns on thin regulations
- Honest fallbacks: missing website → Google search link, missing description → "Details pending further research"

### Defense Summary

| Layer | Type | What it catches | Bypassable? |
|-------|------|-----------------|-------------|
| Mandate rules | Soft | First signal | Yes (LLM ignores) |
| PreToolUse hook | **Hard** | Fake data in Edit/Write | No (runtime) |
| Diff validator | **Hard** | Fabrication in commits | No (parent process) |
| CANNOT_FIX escape | Structural | Removes pressure | N/A (safe exit) |

### Files Changed

| File | Change |
|------|--------|
| `agent_guard.py` | Correct JSON format + fabrication patterns + Bash blocker + AGENT_MODE scope |
| `claude_code.py` | AGENT_MODE=1 env var + full diff capture |
| `feedback_loop_runner.py` | Fabrication validator + CANNOT_FIX detection + diagnosis template |
| `claude_mandate.md` | Anti-fabrication rules + escape valve + think-before-push |
| `settings.json` | Activate PreToolUse hook |
| `research-agents.js` | Multi-strategy JSON extraction with retry |
| `research-orchestrator.js` | Synthesis validation + honest fallbacks |
