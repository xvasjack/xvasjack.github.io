# Agent 3 Report: Remove Silent Truncation Risk

## Summary

Removed all cosmetic/layout truncation from `deck-builder-single.js` and `content-size-check.js`. Only true file-safety hard caps remain. Content that the user pays for (48 LLM calls, 585K tokens) is now preserved in full.

## Truncation Points Found

### deck-builder-single.js

| Line (original) | What it truncates | Category | Action |
|---|---|---|---|
| 1964-1971 | `truncateTitle()` - title text at 110 chars | Cosmetic | REMOVED. Title passes through; `fit:'shrink'` handles overflow |
| 2067 | `truncateTitle(title)` call | Cosmetic | Now calls passthrough version |
| 2070-2073 | `truncateSubtitle(subtitle, 140-320)` | Cosmetic | REMOVED. Uses `ensureString()` instead; `fit:'shrink'` handles |
| 348-378 | `safeCell()` effectiveLimit path (220-600 chars) | Cosmetic | REMOVED. Only 3000-char hard cap kept |
| 351-359 | `safeCell()` 3000-char hard cap | File safety (XML node size) | KEPT |
| 381-386 | `limitWords()` word-based truncation | Dead code (unused) | Left in place (no callers) |
| 454 (old 467) | `compactRenderString()` calls `truncate(str, limit)` | Cosmetic | REMOVED. Logs warning instead |
| 472 (old 485) | `compactRenderPayload()` array `.slice(0, maxItems)` | Cosmetic | REMOVED. Preserves all items, logs warning |
| 2422-2470 | `compactTableRowsForDensity()` truncates cells via `truncate(cell, cap)` | Cosmetic | REMOVED. Only collects overflow samples for rethink/font scaling |
| 3146-3180 | density-overflow hard-truncate severe cells (`cell.slice(0, entry.cap-3)`) | Cosmetic | REMOVED. Warns instead, relies on TABLE_CELL_HARD_CAP for safety |
| 6351-6352 | `dynamicText()` falls back to `truncate()` at font floor | Cosmetic | REMOVED. Returns full text at min font size |
| 2178 | `truncate(sourceUrl, 30)` for URL display in source footnote | Display-only (URL, not content) | KEPT - URLs have no semantic value when truncated |
| 3091-3105 | `TABLE_CELL_HARD_CAP` (3000 chars) in `safeAddTable` | File safety (XML node size) | KEPT |
| 2800-2816 | Table row/column capping when exceeding `TABLE_FLEX_MAX_ROWS/COLS` | Structural (slide geometry) | KEPT |
| 3021-3036 | Table fit-score fallback row/col reduction | Structural (slide geometry) | KEPT |
| 3046-3074 | Table fit-score truncate row/col reduction | Structural (slide geometry) | KEPT |

### content-size-check.js

| Line (original) | What it truncates | Category | Action |
|---|---|---|---|
| 300-327 | `compactContent()` trims string fields to char budget via `trimToSentenceBoundary()` | Cosmetic | REMOVED. Logs warning instead, preserves content |
| 329-358 | `compactContent()` truncates table rows over `TABLE_MAX_ROWS` | Structural (slide geometry) | KEPT but added warning log |

## What Changed

### deck-builder-single.js (6 changes)

1. **`truncateTitle()`** (line 1964): Now returns `ensureString(text).trim()` instead of cutting at 110 chars
2. **`addSlideWithTitle()`** subtitle (line 2070): Uses `ensureString(subtitle).trim()` instead of `truncateSubtitle(subtitle, subtitleMaxLen)`. Import renamed to `_truncateSubtitle`
3. **`safeCell()`** (line 348): Removed entire effectiveLimit/cosmetic truncation path. Only 3000-char hard cap remains. `maxLen` parameter is now `_maxLen` (ignored)
4. **`compactRenderString()`** (line 449): Warns instead of calling `truncate()`. Returns full string
5. **`compactRenderPayload()`** array branch (line 470): No longer slices arrays to `maxItems`. Warns and preserves all items
6. **`compactTableRowsForDensity()`** (line 2400): No longer truncates any cells. Only collects overflow metadata for downstream rethink/font scaling
7. **density-overflow in `safeAddTable()`** (line 3146): No longer hard-truncates severe cells in non-strict mode. Warns and preserves, relies on TABLE_CELL_HARD_CAP
8. **`dynamicText()`** (line 6349): No longer falls back to `truncate()` at font floor. Returns full text at min font size in all modes

### content-size-check.js (2 changes)

1. **Field trimming** (line 300): Logs `[CONTENT-SIZE]` warning instead of silently trimming. Preserves full text
2. **Table row truncation** (line 329): Adds `[CONTENT-SIZE]` warning before truncating. Still enforces `TABLE_MAX_ROWS` (structural)

## Files Changed

- `/home/xvasjack/xvasjack.github.io/backend/market-research/deck-builder-single.js` - 8 edit regions
- `/home/xvasjack/xvasjack.github.io/backend/market-research/content-size-check.js` - 2 edit regions

## Hard Caps Preserved (file-safety only)

| Cap | Value | Location | Purpose |
|---|---|---|---|
| `HARD_TEXT_CAP` | 15,000 chars | ppt-utils.js (read-only) | XML text node size limit |
| `safeCell` hard cap | 3,000 chars | deck-builder-single.js:351 | Table cell XML node safety |
| `TABLE_CELL_HARD_CAP` | 3,000 chars (configurable) | deck-builder-single.js:3091 | safeAddTable cell safety |
| `TABLE_FLEX_MAX_ROWS` | 16 (configurable) | deck-builder-single.js:2800+ | Slide geometry limit |
| `TABLE_FLEX_MAX_COLS` | 9 (configurable) | deck-builder-single.js:2813+ | Slide geometry limit |

## Issues Found in Files I Cannot Edit

### ppt-utils.js (owned by another agent)

1. **`truncate()` function** (line 123): Still has both the `HARD_TEXT_CAP` safety path and a cosmetic `maxLen` path. When `DISABLE_TEXT_TRUNCATION` is false (not default), it will cosmetically truncate. Since `DISABLE_TEXT_TRUNCATION` defaults to `true`, this is not currently active, but the flag name is confusing (double-negative: "disable truncation = true" means truncation IS disabled). No action needed since default is safe, but the function could be simplified.

2. **`truncateSubtitle()` function** (line 238): Same pattern as `truncate()`. Currently safe because `DISABLE_TEXT_TRUNCATION` defaults to `true`, but the cosmetic path still exists.

3. **`fitTextToShape()` function** (not fully audited since ppt-utils.js is read-only): May contain additional cosmetic truncation. Would need audit by its owning agent.

## Syntax Verification

Both files pass `node -c`:
- `deck-builder-single.js`: OK
- `content-size-check.js`: OK
