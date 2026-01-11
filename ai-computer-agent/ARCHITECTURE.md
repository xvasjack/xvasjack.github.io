# AI Computer Agent Architecture

## Overview

This system enables an autonomous development feedback loop:

```
User provides template + input + context
         ↓
Claude Code writes/fixes code → commit → push
         ↓
AI Agent (VM) triggers frontend test
         ↓
AI Agent waits for email with output (PPTX/Excel)
         ↓
AI Agent compares output to template
         ↓
AI Agent sends fix comments to Claude Code
         ↓
Repeat until output matches template
```

## Components

```
┌─────────────────────────────────────────────────────────────────┐
│  HOST PC                                                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Host Controller (localhost:3000)                          │ │
│  │  - Web UI for task input                                   │ │
│  │  - WebSocket server for VM communication                   │ │
│  │  - Task persistence (tasks.json)                           │ │
│  └────────────────────────────────────────────────────────────┘ │
│         │                                                       │
│         │ WebSocket                                             │
│         ▼                                                       │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Windows VM (Hyper-V)                                      │ │
│  │  ┌──────────────────────────────────────────────────────┐  │ │
│  │  │  Agent Daemon (agent.py)                             │  │ │
│  │  │  ├── computer_use.py     → Screenshot + input        │  │ │
│  │  │  ├── feedback_loop.py    → Orchestration             │  │ │
│  │  │  ├── template_comparison → Output validation         │  │ │
│  │  │  ├── guardrails.py       → Security                  │  │ │
│  │  │  └── actions/                                        │  │ │
│  │  │      ├── claude_code.py  → Claude Code CLI [MISSING] │  │ │
│  │  │      ├── outlook.py      → Email access              │  │ │
│  │  │      └── github.py       → PR operations             │  │ │
│  │  ├──────────────────────────────────────────────────────┤  │ │
│  │  │  Chrome | Outlook | Claude Code CLI | File Explorer  │  │ │
│  │  └──────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. Task Input
```
User → Host UI → Task stored in tasks.json
                      ↓
              WebSocket → VM Agent
```

### 2. Feedback Loop (feedback_loop.py)
```
State Machine:
IDLE → TESTING_FRONTEND → WAITING_FOR_EMAIL → ANALYZING_OUTPUT
  ↑                                                    ↓
  └── WAITING_FOR_DEPLOY ← MERGING_PR ← GENERATING_FIX
```

### 3. Template Comparison (template_comparison.py)
```
Output (PPTX/Excel)
        ↓
    File Reader (pptx_reader.py / xlsx_reader.py)
        ↓
    Analysis Dict {companies: [...], slides: [...]}
        ↓
    Compare to Template (TEMPLATES dict)
        ↓
    ComparisonResult {discrepancies: [...]}
        ↓
    generate_claude_code_prompt()
```

## Missing Pieces (TODO)

### 1. Claude Code CLI Bridge (CRITICAL)
File: `vm/actions/claude_code.py`

```python
# Needed functions:
async def send_prompt_to_claude_code(prompt: str) -> Dict:
    """
    1. Open Claude Code CLI in terminal
    2. Paste prompt
    3. Wait for Claude to process
    4. Capture response
    5. Return {success: bool, pr_number: int}
    """
    pass

async def check_claude_code_status() -> Dict:
    """Check if Claude Code is ready"""
    pass
```

### 2. Email Polling (CRITICAL)
File: `vm/actions/outlook.py`

```python
# Needed functions:
async def wait_for_email_with_attachment(
    sender_pattern: str,
    subject_pattern: str,
    timeout_minutes: int
) -> Dict:
    """
    1. Open Outlook
    2. Navigate to inbox
    3. Search for matching email
    4. Download attachment
    5. Return {success: bool, file_path: str}
    """
    pass
```

### 3. Task Persistence (HIGH)
File: `host/tasks.json`

```json
{
  "active_task": {
    "id": "task-123",
    "service": "target-v6",
    "template": "target-search",
    "test_input": {...},
    "started_at": "2024-01-11T10:00:00Z",
    "iteration": 3,
    "state": "WAITING_FOR_EMAIL",
    "issues": [...]
  },
  "history": [...]
}
```

### 4. Template File Mapping (HIGH)
Map TEMPLATES dict to actual files in root:

| Template Name | Reference File |
|--------------|----------------|
| target-search | `YCP Target List Slide Template.pptx` |
| profile-slides | `YCP profile slide template v3.pptx` |
| trading-comps | `trading comps slide ref.pptx` |
| market-research | `Market_Research_*.pptx` |

### 5. Service Test Inputs (MEDIUM)
File: `test_inputs.json`

```json
{
  "target-v6": {
    "business": "packaging companies",
    "country": "Thailand",
    "exclusion": "trading companies",
    "email": "test@example.com"
  },
  "profile-slides": {
    "websites": ["https://example.com"],
    "targetDescription": "logistics",
    "email": "test@example.com"
  }
}
```

## Potential Issues & Mitigations

### Issue 1: Infinite Loop
**Risk:** Claude Code keeps making same mistake
**Mitigation:** `feedback_loop.py` has `max_same_issue_attempts=3` - escalates to research mode

### Issue 2: Email Never Arrives
**Risk:** Backend fails silently, email never sent
**Mitigation:** Add Railway log checking step; timeout after 15 min

### Issue 3: API Rate Limits
**Risk:** External AI APIs return errors
**Mitigation:** Exponential backoff in backend; agent retries on API errors

### Issue 4: Merge Conflicts
**Risk:** Another PR merged while fixing
**Mitigation:** `feedback_loop.py` handles `MERGE_CONFLICT` category; agent rebases

### Issue 5: Template Drift
**Risk:** Template expectations change but TEMPLATES dict is stale
**Mitigation:** Link TEMPLATES to actual files; auto-update criteria from reference files

### Issue 6: Session Crash
**Risk:** Agent crashes mid-loop, loses progress
**Mitigation:** Persist state to `tasks.json` after each state transition

### Issue 7: False Positives
**Risk:** Output is fine but comparison flags issues
**Mitigation:** `min_pass_rate=0.9` allows 10% tolerance; review recurring issues

## Security

### Guardrails (guardrails.py)
- BLOCKED: Teams, email composition, billing pages, chat apps
- ALLOWED: GitHub (your repos), frontend, Outlook (read only), Railway logs

### API Keys
- Stored in `config_local.py` (gitignored)
- Never logged or transmitted

### Audit
- All actions logged to `guardrail_audit.log`
- VM is isolated from host network (except WebSocket)

## Usage

### Starting the Loop

1. **Host:** `npm start` in `ai-computer-agent/host/`
2. **VM:** `python agent.py` in `ai-computer-agent/vm/`
3. **UI:** Open http://localhost:3000
4. Enter task:
   ```
   Service: target-v6
   Business: packaging companies
   Country: Thailand
   Template: target-search
   ```
5. Click "Start Task"
6. Agent runs autonomously until:
   - Output matches template (SUCCESS)
   - Max iterations reached (MAX_ITERATIONS)
   - Stuck on same issue (STUCK)
   - Timeout (TIMEOUT)
