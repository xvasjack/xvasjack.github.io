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
│  │  │      ├── claude_code.py  → Claude Code CLI           │  │ │
│  │  │      ├── gmail.py        → Email access (Gmail)      │  │ │
│  │  │      └── github.py       → PR operations             │  │ │
│  │  ├──────────────────────────────────────────────────────┤  │ │
│  │  │  Chrome | Gmail | Claude Code CLI | File Explorer    │  │ │
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

## Implementation Status

All critical pieces are now implemented:

| Component | File | Status |
|-----------|------|--------|
| Claude Code CLI Bridge | `vm/agent.py`, `vm/actions/claude_code.py` | ✓ Done |
| Email Polling (Gmail) | `vm/actions/gmail.py` | ✓ Done |
| Task Persistence | `host/server.js` (saves to `state.json`) | ✓ Done |
| Template File Mapping | Defined in `CLAUDE.md` | ✓ Done |
| Service Test Inputs | `test_inputs.json` | ✓ Done |
| Feedback Loop Runner | `vm/feedback_loop_runner.py` | ✓ Done |

### Key Design Decisions

1. **No Anthropic API Key Needed**: `agent.py` uses Claude Code CLI (`claude --print --message`) which uses your Max subscription
2. **Gmail over Outlook**: Personal Gmail for receiving automation outputs
3. **Screenshots saved to temp files**: Claude Code CLI reads them via file path

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
- ALLOWED: GitHub (your repos), frontend, Gmail (read only), Railway logs

### No API Keys Needed
- Uses Claude Code CLI authenticated via Anthropic Max subscription
- No API keys to manage or protect

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
