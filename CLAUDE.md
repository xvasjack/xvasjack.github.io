# CLAUDE.md

## Communication Style
- Be concise and plain
- No fluff, no emojis unless asked
- Get to the point
- Give high-level, user-friendly summaries (no technical tool names)
- Use table format for comparisons and options
- Avoid lengthy explanations - brevity is key

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

## Git Workflow
- Feature branches: `claude/{feature}-{suffix}`
- Commit style: `Type: Description` (Add, Fix, Improve, Update)
- Run `npm test` before pushing
