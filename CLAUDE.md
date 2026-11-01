# CLAUDE.md

## Hard rules

1. **Commit and push right after code changes.** `git add`, `git commit` and `git push` are part of the same action that wrote the code. Leave no uncommitted changes.
2. **Run `npm test` in `backend/` before pushing backend changes.** If tests fail, fix them before pushing.
3. **Do not ask permission for things this file already decides.**
4. **Never commit confidential material:** client names, client or employer documents, slide templates, logos, data exported from paid databases, personal paths, or real email inboxes.

## Project overview

- Static HTML frontend on GitHub Pages (`*.html` in the repo root). `index.html` redirects to `find-target.html`.
- Each page posts a form to an Express.js service on Railway (450MB memory limit).
- Services run AI and web research, then email the result (Excel, PowerPoint or Word).
- AI providers: OpenAI, Anthropic, Google Gemini, Perplexity.

## Commands (run from backend/)

- `npm run dev` - run locally
- `npm start` - production start with memory flags
- `npm test` - run tests
- `npm run test:watch` - run tests in watch mode
- `npm run test:coverage` - run tests with coverage
- `npm run lint` / `npm run lint:fix`
- `npm run format` / `npm run format:check`

## Patterns

- Memory constrained: use --expose-gc, max 450MB heap
- Each service folder is independent and has its own `shared/` copy
- Tests go in `backend/__tests__/`
- Shared utilities in `backend/shared/`

## Security

All services have:
- Helmet security headers
- Rate limiting (100 req/min)
- XSS protection (escapeHtml in emails)
- Path traversal protection
- 100MB body size limit (for document uploads)

Routes that return stored reports or recordings stay closed unless an access token is set (`DD_REPORTS_TOKEN`, `TRANSCRIPTION_ACCESS_TOKEN`).

## Shared modules

- `backend/shared/security.js` - security middleware and helpers
- `backend/shared/utils.js` - common utility functions
- `backend/shared/middleware.js` - logging and health checks

## CI/CD

- GitHub Actions runs on push and PR to main: lint, test, format check, security audit
- Pre-commit hooks: lint-staged with ESLint and Prettier

## Services

### Search
- **target-v3** - primary company search (~10 min)
- **target-v4** - broader search with lighter validation
- **target-v5** - Gemini and ChatGPT search
- **target-v6** - faster search

### Analysis
- **validation** / **validation-v2** - validate company lists (Excel/CSV)
- **market-research** - market analysis PPTX
- **profile-slides** - company profile PPTX
- **trading-comparable** - trading comps from an uploaded company list
- **utb** - company business overview
- **due-diligence** - DD summary reports in Word
- **company-metrics** - revenue and headcount from company websites (endpoint in target-v6)
- **translation** - PPTX text translation

### Supporting
- **financial-chart** - financial charts
- **transcription** - real-time audio (Deepgram + R2)

## API pattern

All services deliver results by email:
```
POST /api/{service}
Body: { Business, Country, Exclusion, Email }
Response: { success: true, message: "Results will be emailed" }
```

## Environment variables

### Required
```
OPENAI_API_KEY      # OpenAI
PERPLEXITY_API_KEY  # Web search
GEMINI_API_KEY      # Google Gemini
SENDGRID_API_KEY    # Email delivery
SENDER_EMAIL        # From address
```

### Optional
```
ANTHROPIC_API_KEY           # Claude fallback
SERPAPI_API_KEY             # Google search
DEEPGRAM_API_KEY            # Transcription
R2_*                        # Cloudflare R2 storage
SCREENSHOT_API_KEY          # Screenshot API
SCREENSHOT_API_URL          # Custom screenshot API URL
DD_REPORTS_TOKEN            # Opens the DD report routes when set
TRANSCRIPTION_ACCESS_TOKEN  # Opens the recording routes when set
```

## Railway deployment

- Each service is an independent Railway project
- Root: `backend/{service-name}`
- Start: `node --expose-gc --max-old-space-size=450 server.js`
- Health check: `GET /health`

## Frontend

- Static HTML files on GitHub Pages
- Forms POST directly to Railway URLs
- Email stored in localStorage (`dealToolsEmail`)

## Key functions

- `normalizeCompanyName()` - strip Ltd, Inc, Sdn Bhd, etc.
- `normalizeWebsite()` - clean URLs for comparison
- `dedupeCompanies()` - remove duplicates by website, domain or name
- `isSpamOrDirectoryURL()` - filter Wikipedia, Facebook, etc.
- `ensureString()` - handle AI returning objects instead of strings

## Bug fixing

- Test first: write a failing test that reproduces a production bug, commit it, then fix the code and confirm the test passes.

## Verification

1. After any change, search the whole codebase for every related use, not only the obvious ones.
2. Search for the underlying pattern as well as any wrapper around it.
3. Search again with different keywords before calling a change complete.
4. List the files and locations you checked.

## Planning

- Keep plans concise. End with any open questions.
- When exiting plan mode, say whether the plan is overengineered, underengineered or just right, with a one-line reason.

## Communication style

- Short and plain. No filler, no emojis unless asked.
- Tables for comparisons, bullet points for lists.
- If unsure, ask. State real limitations.

## Git workflow

- Feature branches: `claude/{feature}-{suffix}`
- Commit style: `Type: Description` (Add, Fix, Improve, Update)
