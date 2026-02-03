# CLAUDE.md

## HARD RULES — DO NOT ASK, JUST DO

These override any instinct to "check with user first." Violating these is a bug.

1. **Commit + push immediately after code changes.** No asking "want me to commit?" — the answer is always yes. `git add`, `git commit`, `git push` as part of the same action that wrote the code. Zero uncommitted changes ever.
2. **Read this file AND `ai-computer-agent/PROJECT_KNOWLEDGE.md` at session start.** Before touching any code.
3. **Update `ai-computer-agent/PROJECT_KNOWLEDGE.md` at session end** if you changed anything significant.
4. **Run `npm test` before pushing** (backend changes only). If tests fail, fix them before pushing.
5. **Never ask permission for things this file already decided.** If CLAUDE.md says to do X, do X. Don't ask "should I do X?"

---

## Session Knowledge (READ FIRST, UPDATE LAST)

**Before starting work**, read `ai-computer-agent/PROJECT_KNOWLEDGE.md` for full project context — architecture, how AI is used, feedback loop internals, environment setup, known issues, file map. This avoids repeating background questions.

**Before ending a session** where you made significant changes, update `ai-computer-agent/PROJECT_KNOWLEDGE.md` with:
- New files created or deleted
- Architecture changes
- New known issues or resolved ones
- Changed env vars or config
- Anything a future session would waste time rediscovering

This is the project's persistent memory. Keep it accurate.

---

## User Workflow (READ THIS FIRST)

This is an automated development loop. User provides inputs, Claude Code executes the full cycle:

### The Loop
```
1. USER PROVIDES: template, input, process, expected output, context
2. CLAUDE: Write code → commit → push → merge PR
3. CLAUDE: Run backend locally OR trigger deployed service
4. CLAUDE: Submit test via frontend (localhost:3000) using computer use tool
5. CLAUDE: Receive result via email → compare output to template
6. CLAUDE: Identify gaps between output and template
7. CLAUDE: Write fix → commit → push → merge PR
8. REPEAT steps 3-7 until output matches template
```

### What User Expects Claude to Do
- Write and fix code autonomously
- Run tests and check results
- Use computer use tool to interact with localhost:3000
- Check email for async results (PPTX, Excel, HTML)
- Compare deliverables against provided templates
- Identify specific gaps (missing sections, wrong format, data errors)
- Self-correct without user intervention until output matches template

### Gap Detection Checklist
When comparing output to template:
- [ ] All required sections present?
- [ ] Data format matches template?
- [ ] Styling/layout matches?
- [ ] No missing fields?
- [ ] No extra unwanted content?
- [ ] File type correct (PPTX, Excel, etc.)?

### User Setup (IMPORTANT)
- **Anthropic Max plan ($200/month)** - Claude Code CLI uses this, NO separate API key needed
- **Gmail** for receiving automation outputs (personal Gmail, not Outlook)
- **Windows VM** already exists - just run the agent code there
- **Claude Code CLI** already installed - you're using it now

### Key Limitation
Claude Code currently CANNOT:
- Access email inbox directly (user must provide email content/attachments)
- Use computer use tool without explicit MCP setup

User should provide email results for Claude to analyze.

### AI Computer Agent (for full automation)
See `ai-computer-agent/ARCHITECTURE.md` for the VM-based automation system that:
- Runs computer use to interact with frontend/Gmail
- Waits for email outputs
- Compares against templates
- Sends fix requests back to Claude Code CLI (uses Max plan, no API cost)

### Template Files (in repo root)
| Service | Template File |
|---------|---------------|
| target-v3/v4/v5/v6 | `YCP Target List Slide Template.pptx` |
| profile-slides | `YCP profile slide template v3.pptx`, `profile slide ref v4.pptx` |
| trading-comparable | `trading comps slide ref.pptx` |
| market-research | `Market_Research_*.pptx` samples |

When comparing outputs, use these as visual/structural reference.

---

## Bug Fixing Process
- **Test-first**: When fixing a production bug, write a failing test that reproduces the bug BEFORE writing the fix. Commit the failing test, then fix the code and confirm the test passes.

## Planning
- When exiting plan mode, state whether the plan is **overengineered**, **underengineered**, or **just right** — with a one-line reason.

## Communication Style
- Sacrifice grammar for brevity. Skip filler words
- No fluff, no emojis unless asked
- Think deep before answering. Dont give shallow/obvious responses
- Tables for comparisons. Bullet points for lists
- If unsure, ask. Dont assume
- NEVER lie or oversimplify to make things sound easier. State real limitations

## Project Overview
- 10 backend microservices (target-v3, profile-slides, market-research, etc.)
- Express.js on Railway (450MB memory limit)
- Static HTML frontend on GitHub Pages
- Heavy AI integration (OpenAI, Anthropic, Gemini, DeepSeek)

## Commands (run from backend/)
- `npm run dev` - run locally
- `npm start` - production start with memory flags
- `npm test` - run tests (1141 tests)
- `npm run test:watch` - run tests in watch mode
- `npm run test:coverage` - run tests with coverage
- `npm run lint` - check for code issues
- `npm run lint:fix` - auto-fix lint issues
- `npm run format` - format code with prettier
- `npm run format:check` - check formatting

## Patterns
- Memory constrained: use --expose-gc, max 450MB heap
- Each folder is independent service
- Tests go in `backend/__tests__/`
- Shared utilities in `backend/shared/`

## Security
All services have:
- Helmet security headers
- Rate limiting (100 req/min)
- XSS protection (escapeHtml in emails)
- Path traversal protection
- 100MB body size limit (for DD file uploads)

## Shared Modules
- `backend/shared/security.js` - Security middleware and helpers
- `backend/shared/utils.js` - Common utility functions
- `backend/shared/middleware.js` - Logging and health checks

## CI/CD
- GitHub Actions runs on push/PR to main
- Runs: lint, test, format check, security audit
- Pre-commit hooks: lint-staged with ESLint + Prettier

## Code Quality
- ESLint for linting
- Prettier for formatting
- Jest for testing
- Husky + lint-staged for pre-commit hooks

## Services

### Search Services
- **target-v3** - Primary company search (~10 min)
- **target-v4** - Improved filtering
- **target-v5** - Enhanced with Gemini + ChatGPT
- **target-v6** - Latest iteration

### Analysis Services
- **validation** - Validate company lists (Excel/CSV)
- **market-research** - Generate market analysis PPTX
- **profile-slides** - Create company profile PPTX
- **trading-comparable** - Trading comps with Excel uploads
- **utb** - Unit-to-business analysis
- **due-diligence** - DD reports (multi-agent: Kimi K2 + Gemini)

### Supporting Services
- **financial-chart** - Financial visualization
- **transcription** - Real-time audio (Deepgram + R2)

## API Pattern
All services follow async email delivery:
```
POST /api/{service}
Body: { Business, Country, Exclusion, Email }
Response: { success: true, message: "Results will be emailed" }
```

## Environment Variables

### Required
```
OPENAI_API_KEY      # GPT-4o
PERPLEXITY_API_KEY  # Web search
GEMINI_API_KEY      # Google Gemini
SENDGRID_API_KEY    # Email delivery
SENDER_EMAIL        # From address
```

### Optional
```
DEEPSEEK_API_KEY    # Market research (cheaper)
DEEPGRAM_API_KEY    # Transcription
ANTHROPIC_API_KEY   # Claude fallback
SERPAPI_API_KEY     # Google search
KIMI_API_KEY        # Kimi K2 (Moonshot) for DD deep analysis
R2_*                # Cloudflare R2 storage
SCREENSHOT_API_KEY  # Screenshot API for partner extraction (screenshotapi.net)
SCREENSHOT_API_URL  # Custom screenshot API URL (optional)
```

## Railway Deployment
- Each service is independent Railway project
- Root: `backend/{service-name}`
- Start: `node --expose-gc --max-old-space-size=450 server.js`
- Health check: `GET /health`

## Frontend
- Static HTML files on GitHub Pages
- Forms POST directly to Railway URLs
- Email stored in localStorage (`ycpUserEmail`)
- Results delivered via email (async)

## Key Functions

### Company Processing
- `normalizeCompanyName()` - Strip Ltd, Inc, Sdn Bhd, etc.
- `normalizeWebsite()` - Clean URLs for comparison
- `dedupeCompanies()` - Remove duplicates by website/domain/name
- `isSpamOrDirectoryURL()` - Filter Wikipedia, Facebook, etc.

### AI Context
- `detectMeetingDomain()` - Identify financial/legal/medical
- `getDomainInstructions()` - Domain-specific prompts
- `ensureString()` - Handle AI returning objects instead of strings

## Exhaustive Verification Rule (APPLIES TO ALL TASKS)
**This rule applies to EVERY task — not just API tracking. Any code change, any feature, any fix.**

1. **Never assume you found everything.** After implementing any change, do a full grep/search across the ENTIRE codebase for related patterns. If you're changing how X works, search for every place X is used — not just the obvious ones.

2. **Search for the underlying thing, not the wrapper.** If something is wrapped in a helper function, also search for direct usage that skips the helper. If you're fixing a pattern, search for the raw pattern AND all abstractions over it.

3. **Triple-check completeness.** After you think you're done:
   - Search again with different keywords/patterns
   - Check edge cases (error paths, fallback logic, conditional branches)
   - If you find even ONE miss, assume there are more and re-scan everything

4. **Document what you verified.** List every file and location you checked. If you can't list them, you didn't check thoroughly enough.

5. **No partial work.** Shipping 90% complete is the same as shipping broken. If a change needs to apply to 10 places and you only hit 9, it's a bug.

6. **Question your own assumptions.** If you think "this is probably the only place" — prove it. Grep. Don't guess.

## Bash Guidelines
### IMPORTANT: Avoid commands that cause output buffering issues
- DO NOT pipe output through `head`, `tail`, `less`, or `more` when monitoring or checking command output
- DO NOT use `| head -n X` or `| tail -n X` to truncate output - these cause buffering problems
- Instead, let commands complete fully, or use `--max-lines` flags if the command supports them
- For log monitoring, prefer reading files directly rather than piping through filters

### When checking command output:
- Run commands directly without pipes when possible
- If you need to limit output, use command-specific flags (e.g., `git log -n 10` instead of `git log | head -10`)
- Avoid chained pipes that can cause output to buffer indefinitely

## Subagent Rule
- When using Claude Code's Task tool (subagents), always specify `model: "opus"` to ensure Opus 4.5 is used.

## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.

## Git Workflow
- Feature branches: `claude/{feature}-{suffix}`
- Commit style: `Type: Description` (Add, Fix, Improve, Update)
- Run `npm test` before pushing (backend changes only)
- **Commit + push is part of the task, not a separate step. See HARD RULES at top of file.**
