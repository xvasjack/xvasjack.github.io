# Speeda Director Bot

Local dashboard + browser automation tool to extract director name and age from Speeda and write results to column `V` in your workbook.

## What it does

- Runs locally on your machine.
- Uses Playwright browser automation (no AI extraction).
- Reads company data from:
  - Sheet: `Company List`
  - Rows: `11..8673`
  - Company name column: `D`
  - Speeda ID column: `A` (fallback key)
  - Country column: `G` (fallback disambiguation)
- Writes results to column `V` (`Director info`) as:
  - `Name (Age 52); Name (Age 47)`
- Writes markers when extraction cannot complete:
  - `[NOT_FOUND]`, `[AMBIGUOUS]`, `[BLOCKED]`, `[AUTH_REQUIRED]`, `[PARSE_FAIL]`, `[NETWORK_FAIL]`, `[UI_CHANGED]`

## Dashboard actions

- `Login Check`
- `Start`
- `Pause`
- `Resume`
- `Stop`
- `Retry Failed`
- `Export`
- `Download Run Log`

## Setup

1. Run `install.ps1`.
2. Run `start.ps1`.
3. Open `http://127.0.0.1:8787`.

## Notes

- Default workbook path is prefilled to `C:\Users\User\OneDrive - YCP Holdings\potential seller.xlsx`.
- Tool keeps local run state in `data/state.db`.
- Each run writes a working copy into `data/runs/<run_id>/working.xlsx`.
- `Export` creates a final workbook copy and run log CSV.
- Close the workbook in Excel before running to avoid file locks.

## Safety behavior

- Stops on repeated auth issues.
- Stops on repeated blocked/captcha pages.
- Saves after each processed row.
- Supports retry only for failed rows.
