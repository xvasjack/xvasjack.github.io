# Market Research Tool (Plain English)

## What this project does

You send one request with:
- country (single-country mode)
- industry
- client context

The system returns:
- a market research PPT deck
- runInfo about what happened during the run

## Main goal

The most important thing is:
1. deep content
2. useful insights
3. clear strategy story

Formatting is still important, but secondary.

## The 7-step flow

1. Read request  
File: `server.js`

2. Research the target country  
File: `research-engine.js`

3. Build one strategy story  
File: `research-engine.js`

4. Check content quality  
Files: `content-gates.js`, `content-quality-check.js`

5. Build slides  
Files: `deck-builder-single.js`, `deck-builder.js`, `ppt-utils.js`

6. Check PPT file safety  
File: `deck-file-check.js`

7. Deliver result + store runInfo  
File: `server.js`

## Important terms (simple)

- Content check: score for depth and clarity
- Content size check: warns if content is huge (default does not cut text)
- File safety: checks if PPT file can open cleanly
- Style match: how visually close to template the deck is

## Key files you should know first

- `server.js`: API entrypoint and stage flow
- `research-engine.js`: research and result-combining engine
- `deck-builder-single.js`: actual slide building logic
- `content-gates.js`: content readiness checks
- `deck-file-check.js`: final PPT safety checks
- `system-map.js`: plain-English map of system

## Useful commands

- Run API locally: `npm run dev`
- Preflight check: `npm run preflight:release`
- Smoke check: `npm run smoke:readiness`
- Print plain system map: `npm run explain:system`

## API endpoints

- `POST /api/market-research`: main run
- `GET /api/runInfo`: latest run runInfo
- `GET /api/latest-ppt`: latest PPT download
- `GET /api/system-map`: plain-English flow map

## Where to read next

- `docs/logic-flow.md`
- `docs/file-map.md`
- `docs/plain-english-map.md`
- `PLAIN_LANGUAGE_RULES.md`
