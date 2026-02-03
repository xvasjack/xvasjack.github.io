# FORJACK.md — How This Whole Thing Works

*A plain-language guide to the YCP Target Tools platform, written so future-you can pick this up in 6 months and not be lost.*

---

## What Is This Project?

You built an **M&A research automation platform**. Investment bankers at YCP need to find acquisition targets, create pitch decks, analyze trading comparables, and run due diligence. All of that used to be manual — junior analysts grinding through Google searches, copying data into PowerPoint slides, formatting Excel sheets.

This platform does it with AI.

A user fills out a simple web form ("Find me packaging companies in Southeast Asia, exclude MNCs"), hits submit, and gets a polished deliverable in their email inbox 10-15 minutes later. That deliverable — a PowerPoint, Excel, or Word doc — is the kind of thing that used to take an analyst a full day.

Think of it like a **restaurant kitchen**. The frontend is the menu and the waiter. The backend services are the individual chefs — one makes the appetizer, another does the main course, another handles desserts. Each chef works independently, but they all use the same pantry (shared modules) and follow the same hygiene rules (security middleware). When the dish is ready, a courier (SendGrid) delivers it to the customer's table (email inbox).

---

## The Architecture: 13 Kitchens, One Restaurant

### The Frontend (The Menu)

Static HTML files hosted on GitHub Pages. No React, no Vue, no build step. Just HTML, CSS, and vanilla JavaScript. Each page is a form that POSTs to a Railway backend URL.

Why so simple? Because the complexity lives in the backend. The frontend's only job is to collect four things: **what** (business type), **where** (country), **what to skip** (exclusions), and **who to email** (the user). A React app would've been overengineering for forms that literally just collect four fields.

The email gets stored in `localStorage` so the user doesn't have to retype it every visit. That's the only "state management" on the frontend.

**Files:**
- `index.html` — navigation hub
- `find-target-v6.html` — latest company search
- `profile-slides.html` — company profile PowerPoint generation
- `market-research.html` — market analysis decks
- `trading-comparable.html` — trading comps (with Excel file upload)
- `due-diligence.html` — DD reports
- Plus `validation.html`, `utb.html`, and earlier versions (v3/v4/v5)

### The Backend (The Kitchen)

13 independent Express.js microservices, each deployed as a separate Railway project. Each one is a self-contained Node.js app with its own `server.js`, `package.json`, and local copy of shared utilities.

Here's why they're independent rather than a monolith: **Railway gives each service 450MB of memory**. These services do heavy AI processing — multiple LLM calls, PDF parsing, PowerPoint generation. A monolith would blow past memory limits. Separate services mean each one gets its own 450MB allocation.

The trade-off is **code duplication**. The `shared/` folder gets copied into every service directory. If you fix a bug in `shared/utils.js`, you need to update it in 13 places. This is deliberate — it means you can deploy one service without touching the others. In a monolith, a bug fix in one service could break another. Here, blast radius is contained.

### The Services

| Service | What It Does | Analogy |
|---------|-------------|---------|
| **target-v3 through v6** | Finds acquisition target companies via AI-powered web search | Google on steroids — searches 14 strategies in parallel, deduplicates, filters, formats |
| **profile-slides** | Creates company profile PowerPoint decks | An analyst who reads about a company and makes a presentation about it |
| **market-research** | Generates market analysis presentations | A research department that produces industry reports |
| **trading-comparable** | Analyzes trading comps from uploaded Excel/PDF annual reports | A financial analyst who reads annual reports and extracts metrics |
| **due-diligence** | Produces comprehensive DD reports (Word docs) | A law firm's associate doing deep background checks |
| **validation** | Checks if a list of companies is real, active, and correctly categorized | A fact-checker going through a spreadsheet |
| **utb** | Unit-to-business analysis | Breaks down business units and maps them |
| **financial-chart** | Generates financial visualizations | A data viz specialist |
| **transcription** | Real-time audio transcription via WebSocket | A court stenographer, but instant |

### The Shared Pantry (backend/shared/)

Seven modules that every service uses:

- **`utils.js`** — Company name normalization ("Acme Ltd." → "Acme"), website cleanup, deduplication, spam URL filtering. This is the workhorse. If a company shows up twice because one version says "example.com" and another says "www.example.com/home", this module catches it.

- **`security.js`** — Helmet headers, rate limiting (100 req/min per IP, 10 for expensive ops), XSS prevention, path traversal protection, CORS config. Every service gets the same armor.

- **`email.js`** — SendGrid integration with retry logic and exponential backoff. Supports attaching XLSX, PPTX, DOCX, PDF, and more. This is the delivery truck.

- **`ai-models.js`** — The brains of the operation. Configures 15+ AI models (GPT-4o, Gemini 2.5 Flash, DeepSeek, Kimi K2, Perplexity Sonar, etc.) with their costs, timeouts, and temperature presets. Includes `withRetry()` for exponential backoff when APIs flake out.

- **`tracking.js`** — Cost tracking per request. Uses `AsyncLocalStorage` to isolate tracking per HTTP request (so concurrent requests don't mix their token counts). Persists to Google Sheets for cost monitoring.

- **`middleware.js`** — Request logging, health checks, error handling. Every service gets a `/health` endpoint that reports memory usage, uptime, and heap percentage.

- **`logging.js`** — Memory monitoring and global error handlers. The `setupGlobalErrorHandlers()` function is critical — it catches unhandled promise rejections and uncaught exceptions so the server keeps running instead of crashing on Railway.

---

## The AI Orchestration: Talking to Six Different Brains

This platform doesn't use just one AI model. It uses **six different AI providers**, each chosen for a specific strength:

| Provider | Models | Strength | Used For |
|----------|--------|----------|----------|
| **OpenAI** | GPT-4o, GPT-4o-mini | General intelligence, structured output | Company extraction, profile analysis, validation |
| **Google Gemini** | 2.5 Flash, 2.5 Flash-Lite, 2.5 Pro | Speed, large context (1M tokens), cheap | Search diversity, relevance checks, bulk processing |
| **DeepSeek** | V3.2, Reasoner | Cost-effective reasoning | Market research, due diligence (primary) |
| **Perplexity** | Sonar Pro | Web search built-in | Real-time web verification |
| **Moonshot/Kimi** | K2 (128K context) | Massive context window | Due diligence deep analysis (reads entire documents) |
| **Anthropic** | Claude | Fallback reasoning | Emergency fallback when others fail |

The key insight is that **different tasks need different models**. Extracting a company name from a webpage (simple) shouldn't cost the same as analyzing an annual report (complex). The platform uses GPT-4o-mini ($0.15/M tokens) for simple extraction and reserves o1 ($15/M tokens) for deep financial reasoning. That's a 100x price difference.

The fallback chain works like this: try the primary model → if it fails, try the secondary → if that fails, try GPT-4o as the universal fallback. Every step has exponential backoff (wait 1s, then 2s, then 4s) with max 3 retries. This makes the system resilient to API outages without hammering rate limits.

---

## The Async Email Pattern: Why Everything Gets Emailed

Every service follows the same pattern:

```
User submits form → Backend returns "Results will be emailed" → Backend processes for 5-15 minutes → Email arrives with attachment
```

Why not show results on the page? Because these operations take **5 to 15 minutes**. Railway has request timeouts. Browsers have timeouts. Users close tabs. If you tried to keep a connection open for 15 minutes while the backend calls six different AI models, parses PDFs, generates PowerPoint slides, and deduplicates company lists... it would fail.

The email pattern is a **message queue in disguise**. Instead of Redis or RabbitMQ, the queue is "the email hasn't been sent yet." Instead of a consumer polling a queue, the consumer is SendGrid's API. It's simple, reliable, and the user gets a permanent record of every result in their inbox.

The trade-off: testing is painful. You can't just hit an endpoint and check the response. You have to submit a form, wait for an email, open the attachment, and compare it to a template. That's why the AI Computer Agent exists.

---

## The AI Computer Agent: A Robot That Tests Your Robot

This is the most meta part of the whole system. You built an **AI agent that tests your AI-powered services**.

The problem: every time you change code, you need to verify the output still matches the PowerPoint template. Manually submitting forms, waiting for emails, opening attachments, and comparing slide-by-slide is tedious and error-prone.

The solution: a Python agent running in a Windows VM (Hyper-V) that:

1. **Fills out the frontend form** using computer vision (screenshots + clicking)
2. **Waits for the email** by polling Gmail
3. **Opens the attachment** and extracts content (reads PPTX slides, Excel sheets)
4. **Compares to the template** and identifies gaps ("Section 3 is missing," "Font is wrong on slide 7")
5. **Sends a fix request** to Claude Code CLI
6. **Merges the PR** when CI passes
7. **Repeats** until output matches or max iterations hit

The architecture is split between a **host** (your PC, running Express + WebSocket on port 3000) and a **VM** (Windows, running the Python agent). They communicate over WebSocket. The host provides the chat UI and task management; the VM does the actual computer use.

The security model is important here. The agent has **guardrails** — hard blocks on dangerous actions. It can't compose emails (only read automation emails), can't open Teams or Slack, can't visit payment pages, can't access arbitrary URLs. Every action is logged to `guardrail_audit.log`. Think of it like giving an intern access to specific tools but not the company credit card.

The most interesting architectural decision: **Claude Code CLI instead of the Anthropic API**. Since you have the Anthropic Max subscription ($200/month), the CLI is effectively free — no per-token charges. The agent literally spawns `claude` as a subprocess to get AI reasoning. It's like using a phone call to a genius friend instead of paying a consultant by the hour.

---

## Technical Decisions and Why We Made Them

### "Why not a monolith?"

Memory. Railway gives you 450MB per service. A monolith running 13 services would need 2-3GB. Microservices let each one have its own allocation. The downside (code duplication in `shared/`) is worth the upside (independent deployment, isolated memory, blast radius containment).

### "Why static HTML instead of React?"

The frontend collects four form fields and shows a success message. React would add a build step, a node_modules folder, a bundler config, and 200KB of JavaScript to do what 50 lines of vanilla JS already does. This is a case where the boring technology was the right technology.

### "Why email delivery instead of WebSocket streaming?"

Reliability. Operations take 5-15 minutes. WebSocket connections drop. Browser tabs close. Emails don't disappear. Plus, the user gets a permanent record of every result. The only downside is testing difficulty, which the AI agent solves.

### "Why copy shared/ into every service instead of using npm packages?"

Deployment independence. If `shared/utils.js` is an npm package, updating it requires publishing a new version, updating every service's package.json, and redeploying all 13 services. With local copies, you can update one service's `shared/` without touching the others. Yes, you might forget to update all copies — that's a real risk, and audit rounds have caught this. But the deployment simplicity is worth it for a small team.

### "Why six AI providers instead of just OpenAI?"

Cost and capability. GPT-4o is excellent but expensive ($2.50/$10 per million tokens). DeepSeek V3.2 gives 80% of the quality at 10% of the price ($0.28/$0.42). Kimi K2 has a 128K context window, which means it can read entire annual reports in one shot — something GPT-4o can't do without chunking. Perplexity has web search built in, which saves you from maintaining your own search infrastructure. Each model earns its place.

---

## The Bug Chronicles: What Went Wrong and What We Learned

This project went through six rounds of auditing that found and fixed **233+ bugs** in two days. Here are the most instructive ones.

### The Silent No-Op (The Scariest Bug)

In the trading-comparable service, companies needed to be filtered based on AI analysis. The AI prompt told the model to number companies `1, 2, 3...` (1-based). The JavaScript code looked them up with `0, 1, 2...` (0-based). Every `.find()` call missed. **The entire filtering pipeline was silently doing nothing.**

No error. No crash. No warning. The code "worked" — it just produced wrong results. Every company passed the filter regardless of relevance.

**Lesson:** When your code talks to an AI model, the prompt and the parsing code are a contract. If the prompt says "number from 1" but the code expects "number from 0," that's an off-by-one error that no linter will catch. The modern version of the classic bug, specific to LLM-integrated systems.

### The Bullet Point Saga (8 Commits to Render a Dot)

```
Fix bullet points: smaller red squares to match template
Fix: Revert bullet to BLACK SQUARE at 82% size
Fix: Restore font size to 14pt, keep bullet at 82%
Fix: Bullet size now actually 82% (11pt vs 14pt text)
Fix: Use round bullet • instead of black square
Fix: Use BLACK SMALL SQUARE ▪ at full font size, no hack needed
Revert: Back to BLACK SQUARE ■ at 82% size (working version)
Fix: Preserve point form when AI returns bullets as array
```

Eight commits. Each one "fixed" the bullet point rendering and broke something else. The root cause: nobody read the PPTX XML specification before trying to manipulate bullet styling. Each attempt was trial-and-error against the renderer.

**Lesson:** Understand the output format before you iterate on rendering. Read the spec. Don't guess. An hour of reading documentation saves eight rounds of commit-test-revert.

### The 233 Bugs in Two Days (Why Defensive Coding Matters)

The biggest category of bugs across all six audit rounds: **null/undefined access**. Every time data crosses a boundary — AI response, API call, function return — the code assumed the data would be the right shape. It never consistently was.

- `analysisResult` was `undefined` before `.match()` was called
- `response.content[0]` accessed without checking if `content` was empty
- `iterations[-1]` on an empty list
- `merge_result` was not a dict before `.get()` was called

**Lesson:** AI output is untrusted input. Treat every LLM response the same way you'd treat user input from the internet. Validate the shape. Check for null. Handle the unexpected. If you're accessing `response.content[0].text`, that's four assumptions in one expression — `response` exists, `content` exists, it's not empty, and `[0]` has a `.text` property. Any of those can fail.

### The Zombie Processes (Async is Hard)

In the AI agent, subprocesses were killed with `.kill()` but never `.wait()`'d. The OS still held references to them. Over time, zombie processes accumulated and ate system resources.

Similarly, `asyncio.CancelledError` was caught but not re-raised, which broke Python's cancellation propagation. Tasks that should have been cleaned up kept running in the background.

**Lesson:** In async code, every resource you create (process, connection, file handle) needs an explicit cleanup path. `kill()` without `wait()` is a leak. Catching `CancelledError` without re-raising breaks the entire async cleanup chain. The rule is: if you `create()`, you must `cleanup()`. No exceptions.

### The except: pass Epidemic

Found in 8+ locations across the codebase. Silent exception swallowing that made debugging impossible:

```python
except json.JSONDecodeError:
    pass  # AI returned garbage. We'll never know.
```

When something fails silently, you don't get a bug report — you get subtly wrong output that nobody notices until a client points it out.

**Lesson:** Every catch block should log something. Even if you want to continue execution, at least record that an error happened, what it was, and what data caused it. The cost of a log line is zero. The cost of silent data corruption is your client's trust.

### The Unbounded Everything

Multiple locations had loops, queues, or data structures that could grow without limit:

- A JSON extraction `while` loop with no max iterations — could hang the CPU forever on malformed AI output
- An email MIME walker with no depth/count limit — DoS vector
- An `issue_tracker` dict that grew with every iteration — slow memory leak
- A send queue with no max size

**Lesson:** Everything needs a bound. Every `while` needs a max count. Every `await` needs a timeout. Every queue needs a max size. Every recursive function needs a depth limit. If it can grow, it will grow until it kills your process. Railway gives you 450MB and then kills your service. Unbounded anything is a ticking bomb.

---

## How Good Engineers Think: Patterns Worth Internalizing

### 1. "What's the simplest thing that could work?"

The frontend is static HTML. The email delivery is SendGrid. The cost tracking goes to Google Sheets. None of these are "scalable" or "enterprise-grade." They're simple, reliable, and appropriate for the scale of this project. The urge to add React, Redis, PostgreSQL, and Kubernetes would have turned a weekend project into a quarter-long infrastructure buildout.

### 2. "What happens when this fails?"

Every AI call can fail. Every network request can timeout. Every email can bounce. The platform handles this with:
- Retry with exponential backoff (1s → 2s → 4s, max 3 tries)
- Fallback model chains (primary → secondary → GPT-4o)
- Global error handlers that keep the server running
- Memory logging on every error for post-mortem analysis

The key mindset shift: don't ask "will this work?" Ask "what happens when this doesn't work?"

### 3. "Blast radius containment"

Each service is independent. A memory leak in trading-comparable can't crash profile-slides. A bad deployment to target-v6 doesn't affect target-v5. This isn't just good architecture — it's risk management. When (not if) something goes wrong, it only affects one thing.

### 4. "Test the contract, not the implementation"

The trading-comparable off-by-one bug happened because the prompt and the parsing code had different assumptions about indexing. The lesson: when your system has a contract between two components (AI prompt ↔ JSON parser, API request ↔ response handler, frontend form ↔ backend validation), test the contract explicitly. Write a test that sends a realistic AI response through the parser and checks that the right companies come out the other end.

### 5. "Automate the tedious verification"

The AI Computer Agent exists because manual testing was unsustainable. Every code change required: submit form → wait for email → open attachment → compare to template → note differences → fix → repeat. Automating this loop turned hours of manual QA into a background process that runs while you sleep.

### 6. "Log everything at boundaries"

The codebase logs memory usage, API call durations, token counts, and error details at every system boundary. When something goes wrong at 3 AM on Railway, these logs are the only evidence. The pattern: log at entry (what came in), log at exit (what went out, how long it took), and log on error (what failed and why).

---

## Technology Cheat Sheet

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Static HTML + vanilla JS | Simplicity, GitHub Pages hosting |
| Backend runtime | Node.js 18+ (Express) | Async I/O, large npm ecosystem |
| Deployment | Railway (NIXPACKS) | Simple PaaS, per-service isolation |
| AI (general) | OpenAI GPT-4o / GPT-4o-mini | Best general quality |
| AI (cheap bulk) | DeepSeek V3.2, Gemini 2.5 Flash-Lite | 10x cheaper for 80% quality |
| AI (deep analysis) | Kimi K2 (128K context) | Reads entire documents in one shot |
| AI (web search) | Perplexity Sonar Pro | Built-in real-time web search |
| AI (reasoning) | Gemini 2.5 Pro, o1 | Complex financial analysis |
| Email delivery | SendGrid | Reliable, supports attachments |
| Document generation | pptxgenjs, docx | PowerPoint and Word in Node.js |
| Audio | Deepgram | Real-time transcription via WebSocket |
| Storage | Cloudflare R2 | S3-compatible, cheap, for audio files |
| Cost tracking | Google Sheets API | Simple persistence, easy to review |
| Testing | Jest (1141+ tests) | Standard Node.js testing |
| Code quality | ESLint + Prettier + Husky | Automated formatting, pre-commit hooks |
| CI/CD | GitHub Actions | Lint → Test → Format check → Security audit |
| Automation testing | Python agent in Windows VM | Computer use, Gmail polling, template comparison |

---

## The Cost Story

AI costs can spiral fast. Here's the pricing landscape this platform navigates:

| Model | Cost per 1M tokens (input/output) | Use Case |
|-------|-----------------------------------|----------|
| o1 | $15 / $60 | Deep financial reasoning (most expensive) |
| GPT-4o | $2.50 / $10 | General extraction and analysis |
| GPT-4o-mini | $0.15 / $0.60 | Simple tasks (40x cheaper than GPT-4o) |
| Gemini 2.5 Flash-Lite | $0.10 / $0.40 | Bulk processing (25x cheaper than GPT-4o) |
| DeepSeek V3.2 | $0.28 / $0.42 | Market research (10x cheaper than GPT-4o) |
| DeepSeek V3.2 (cached) | $0.028 / $0.42 | Repeated queries (100x cheaper than GPT-4o) |

The optimization analysis (in `docs/AI_MODEL_COST_OPTIMIZATION_ANALYSIS.md`) found that replacing o1 with Gemini 3 Flash in trading-comparable alone could save **95% per request** ($15 → $0.50 input). Across the platform, strategic model replacement could save 40-60% of total AI costs.

The principle: use the cheapest model that produces acceptable quality. Simple extraction tasks don't need GPT-4o. Save the expensive models for tasks where quality genuinely matters — financial analysis, edge case handling, complex reasoning.

---

## Project Structure at a Glance

```
xvasjack.github.io/
├── *.html                     ← Frontend (GitHub Pages)
├── css/main.css               ← Styling
├── CLAUDE.md                  ← Rules for Claude Code
├── CLAUDE-FAILURES.md         ← Failure log (meta-engineering)
├── FORJACK.md                 ← You are here
│
├── backend/                   ← All services
│   ├── shared/                ← 7 modules (utils, security, email, ai-models, tracking, middleware, logging)
│   ├── __tests__/             ← 1141+ Jest tests
│   ├── target-v3/             ← Company search v3
│   ├── target-v4/             ← Company search v4
│   ├── target-v5/             ← Company search v5
│   ├── target-v6/             ← Company search v6 (latest)
│   ├── profile-slides/        ← Profile PowerPoint generation
│   ├── market-research/       ← Market analysis decks
│   ├── trading-comparable/    ← Trading comps analysis
│   ├── due-diligence/         ← DD reports (DOCX)
│   ├── validation/            ← Company list validation
│   ├── validation-v2/         ← Enhanced validation
│   ├── utb/                   ← Unit-to-business analysis
│   ├── financial-chart/       ← Financial visualizations
│   └── transcription/         ← Real-time audio (WebSocket)
│
├── ai-computer-agent/         ← Automated testing agent
│   ├── host/                  ← Express + WebSocket controller
│   ├── vm/                    ← Python agent (runs in Windows VM)
│   │   ├── agent.py           ← Main loop
│   │   ├── feedback_loop.py   ← State machine
│   │   ├── guardrails.py      ← Security enforcement
│   │   └── actions/           ← GitHub, Gmail, Claude Code, frontend
│   └── shared/                ← Protocol definitions
│
├── docs/                      ← Cost analysis, architecture docs
└── .github/workflows/ci.yml   ← CI pipeline
```

---

## Final Thoughts

This project is a case study in **pragmatic engineering**. It doesn't use the trendiest tools or the most scalable architecture. It uses the simplest things that work at this scale:

- Static HTML when React isn't needed
- Email when WebSockets would be fragile
- Google Sheets when PostgreSQL would be overkill
- Copied files when npm packages would add deployment complexity

The 233 bugs found in audit rounds are humbling but instructive. Most of them were the same category: **assuming data would be the shape you expected**. The fix is always the same: validate, check for null, handle the unexpected, and log when things go wrong.

The most valuable skill this project teaches isn't any specific technology. It's the discipline of asking: **"What happens when this fails?"** — and writing the code to handle that answer before it happens in production.
