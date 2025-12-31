# CLAUDE.md

## Communication Style
- Be concise and plain
- No fluff, no emojis unless asked
- Get to the point

## Project Overview
- 10 backend microservices (target-v3, profile-slides, market-research, etc.)
- Express.js on Railway (450MB memory limit)
- Static HTML frontend on GitHub Pages
- Heavy AI integration (OpenAI, Anthropic, Gemini, DeepSeek)

## Commands (run from backend/)
- `npm run dev` - run locally
- `npm start` - production start with memory flags
- `npm test` - run tests
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
