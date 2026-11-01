# Market Research Deck Generator

Express service that turns one request (country + industry + optional client context)
into a single-country market research PowerPoint deck and emails it to the requester.

Example request: "Cold-chain logistics market entry in Indonesia for a European investor".

## Pipeline

1. Read request — `server.js`, `research-framework.js`
2. Research the target country with web-grounded AI calls — `research-engine.js`, `research-agents.js`
3. Combine the research into one storyline — `research-engine.js`
4. Check content depth and story flow — `content-gates.js`, `content-quality-check.js`, `story-flow-check.js`
5. Build slides from template geometry — `deck-builder-single.js`, `ppt-utils.js`, `template-patterns.json`
6. Check that the PPTX opens cleanly — `deck-file-check.js`, `pptx-fileSafety-pipeline.js`
7. Deliver by email and store run info — `server.js`

`template-patterns.json` holds slide geometry, fonts and colours only. It holds no slide text.

## Commands

- Run locally: `npm run dev`
- Tests (from `backend/`): `npx jest market-research`
- Release checks: `npm run preflight:release`, `npm run smoke:readiness`
- Print the system map: `npm run explain:system`
- Stage-by-stage runs: `npm run phase:run -- --help`

## API

- `POST /api/market-research` — start a run (result is emailed)
- `GET /api/runInfo` — details of the latest run
- `GET /api/latest-ppt` — download the latest deck
- `GET /api/system-map` — machine-readable flow map

## More docs

- `docs/logic-flow.md`
- `docs/file-map.md`
- `docs/PHASE_TRACKER_QUICKSTART.md`
