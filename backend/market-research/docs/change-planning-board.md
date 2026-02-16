# Change Planning Board (Where to edit for each goal)

Use this when planning work. Pick one goal and edit only the listed files first.

## Goal: Improve depth/insights/story

Primary files:
- `research-engine.js`
- `research-agents.js`
- `research-framework.js`
- `content-gates.js`

Do not start in:
- `ppt-utils.js`
- `template-*` files

Reason:
- Content quality is decided before building.

## Goal: Fix broken or unopenable PPT files

Primary files:
- `deck-file-check.js`
- `deck-builder-single.js`
- `deck-builder.js`

Check commands:
- `npm run preflight:release`
- `npm run smoke:readiness`

## Goal: Change API behavior

Primary file:
- `server.js`

Related:
- `system-map.js`
- `README.md`

## Goal: Release safety

Primary files:
- `scripts/preflight-release.js`
- `scripts/smoke-release-readiness.js`

Related:
- `preflight-gates.js`
- `validate-real-output.js`

## Goal: Make wording/logs clearer

Primary files:
- `server.js`
- `docs/plain-english-map.md`

## Goal: Understand current architecture fast

Read in order:
1. `README.md`
2. `system-map.js`
3. `docs/logic-flow.md`
4. `docs/file-map.md`

