# One-Line Stage Test

Stage 2 only: `npm run stage:check -- --stage=2 --country=Indonesia --industry="Cold-Chain Logistics" --api-key="YOUR_GEMINI_KEY"`

Stage 2 + 2a: `npm run stage:check -- --through=2a --country=Indonesia --industry="Cold-Chain Logistics" --api-key="YOUR_GEMINI_KEY"`

Stage 3 only (runs 2 -> 2a -> 3 and saves stage 3 output): `npm run stage:check -- --stage=3 --country=Indonesia --industry="Cold-Chain Logistics" --api-key="YOUR_GEMINI_KEY"`

Stage 3a only (runs 2 -> 2a -> 3 -> 3a and saves stage 3a output): `npm run stage:check -- --stage=3a --country=Indonesia --industry="Cold-Chain Logistics" --api-key="YOUR_GEMINI_KEY"`

Stage output files are auto-saved in `reports/latest/` as `.md` (readable) and `.json` (full data).
