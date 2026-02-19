# Phase Tracker Hooks

Pipeline checkpoint hooks for `runMarketResearch`. These hooks let callers observe stage transitions, stop the pipeline at any public stage, and skip email delivery.

## Run Options

Pass these inside the `options` object to `runMarketResearch(prompt, email, options)`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `stopAfterStage` | `string` | `null` | Public stage ID to stop at. Pipeline returns partial result after this stage completes. |
| `disableEmail` | `boolean` | `false` | Skip email delivery. Pipeline returns success with `emailSkipped: true`. |
| `stageHooks` | `object` | `null` | Hook callbacks (see below). |

## Stage Hooks

```js
const options = {
  stageHooks: {
    onStageStart(stage, payload)    { /* called before stage runs */ },
    onStageComplete(stage, payload) { /* called after stage succeeds */ },
    onStageFail(stage, payload)     { /* called when stage fails fatally */ },
  }
};
```

All hooks receive `(stageId: string, payload: object)`. Payloads are sanitized — no API keys, tokens, passwords, or raw Buffers leak through.

Hooks are fire-and-forget. If a hook throws, the error is logged and the pipeline continues.

## Public Stages

| Stage | Label | Internal |
|-------|-------|----------|
| `2`  | Country Research | Stage 2 |
| `2a` | Country Analysis Review | Stage 2a |
| `3`  | Synthesis | Stage 3 |
| `3a` | Synthesis Quality Review | Stage 3a |
| `4`  | Content Readiness Check | Content gate |
| `4a` | Content Review Loop | Content review |
| `5`  | Pre-Build Check | Stage 6 |
| `6`  | Content Size Check | Stage 7 |
| `6a` | Readability Rewrite | Stage 7a |
| `7`  | PPT Generation | Stage 8 |
| `8`  | PPT Structure Hardening | Stage 9 |
| `8a` | Final Deck Review | Stage 9a |
| `9`  | Email Delivery | Stage 10 |

## stopAfterStage

When `stopAfterStage` is set, the pipeline runs through the target stage, emits `onStageComplete`, then returns early with:

```json
{
  "success": true,
  "partial": true,
  "stoppedAfterStage": "3a",
  "completedStages": ["2", "2a", "3", "3a"],
  "scope": { "industry": "...", "targetMarkets": ["..."] },
  "totalCost": 0.42,
  "totalTimeSeconds": 120.5
}
```

## disableEmail

When `disableEmail: true`, stage 9 (Email Delivery) is skipped. The pipeline returns:

```json
{
  "success": true,
  "emailSkipped": true,
  "scope": { ... },
  "countriesAnalyzed": 1,
  "totalCost": 1.23,
  "totalTimeSeconds": 600
}
```

The PPT buffer is still generated and available via `/api/latest-ppt`.

## Backward Compatibility

When no hook options are passed, `runMarketResearch` behaves identically to the existing API path. The `/api/market-research` endpoint does not expose these options — they are for direct callers (phase runner, tests).

## Export

`runMarketResearch` is exported from `server.js`:

```js
const { runMarketResearch } = require('./server');
```

## Payload Sanitization

All hook payloads pass through `sanitizeStagePayload()` from `phase-tracker/core/stage-payload-sanitizer.js`:

- Keys matching secret patterns (`apiKey`, `token`, `password`, `secret`, `sendgrid`, `bearer`, `authorization`, `credential`) are replaced with `[REDACTED]`
- `Buffer` values become `[Buffer N bytes]`
- Strings longer than 500 chars are truncated
- Nesting beyond 6 levels becomes `[nested]`
- Arrays are capped at 50 items
