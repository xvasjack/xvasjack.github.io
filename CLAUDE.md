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

## Commands
- `npm run dev` - run locally
- `npm start` - production start with memory flags

## Patterns
- Memory constrained: use --expose-gc, max 450MB heap
- Each folder is independent service
- No tests or linting currently configured
