# btc-v1

BTC/USD rule backtester, strategy research and a daily paper trader.

## Run it locally (no server, no email, no cloud)

```
cd backend && npm install          # once
cd btc-v1
node run.js            # fetch today's candle, compute signal, rebalance paper account, print
node run.js status     # show account
node run.js signal     # show signal only
node run.js --loop     # keep running: now, then daily at 00:05 UTC
```

State lives in `btc-v1/state/paper-state.json` (gitignored), one line per run in `btc-v1/state/log.txt`. Needs internet for Bitstamp's public API. No keys.

### Run daily automatically with a desktop notification

`node run.js --notify` runs once and pops a desktop notification (Windows toast / macOS / Linux). Schedule it:

Windows (PowerShell, edit the path). 08:10 local = 00:10 UTC in Singapore:

```
schtasks /Create /SC DAILY /ST 08:10 /TN "btc-v1" /TR "cmd /c cd /d C:\path\to\xvasjack.github.io\backend\btc-v1 && node run.js --notify >> state\task.log 2>&1"
schtasks /Run /TN "btc-v1"     # test it now
```

macOS / Linux (`crontab -e`), 10 minutes past midnight UTC:

```
10 0 * * * cd /path/to/xvasjack.github.io/backend/btc-v1 && /usr/bin/env node run.js --notify >> state/task.log 2>&1
```

If the machine is asleep at that time the run happens at the next start (`schtasks` option `/RL` not needed; the rule is idempotent per day, so running late or twice is harmless).

## Paper trader service (`server.js`, `paper.js`, `storage.js`)

Strategy: ensemble of smaTrend 40/50/60/75d on daily Bitstamp candles (target position 0, 0.25, 0.5, 0.75 or 1). Once a day at 00:05 UTC it fetches completed daily candles, computes the target, rebalances a virtual $10k account at the ticker price with 15 bps/side fees, saves state, and emails a one-line summary vs buy & hold. Idempotent per daily candle; catches up on restart.

| Route                    | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `GET /health`            | Railway health check                                                  |
| `GET /api/btc-v1/status` | equity, return vs buy & hold, drawdown, last signal, last trades      |
| `GET /api/btc-v1/signal` | live signal from Bitstamp (no state change)                           |
| `POST /api/btc-v1/run`   | run the daily job now; header `x-run-token`, body `{ "force": true }` |

Env: `SENDGRID_API_KEY`, `SENDER_EMAIL`, `BTC_EMAIL` (recipient, default sender), `BTC_RUN_TOKEN`, `BTC_RUN_HOUR_UTC` (0), `BTC_RUN_MINUTE` (5), `BTC_CATCHUP_ON_START` (1), `BTC_COST_BPS` (15), `BTC_START_CASH` (10000). State goes to Cloudflare R2 when `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` are set (Railway disk is ephemeral), else `state/paper-state.json`.

`node scripts/replay-paper.js --from 2025-01-01` replays the paper code path over history and compares it with the backtest engine (they agree within ~1.5 points). Note: the 2023-2026 catalog numbers below start the SMAs cold in Jan 2023 (75-day warmup), so they understate the ensemble; with warmup from 2022 data it made +324% over 2023-2026 vs +359% buy & hold.

## Files

| File                                         | Purpose                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules.js`                                   | Rules: `(candles, params) => positions` (1 long, -1 short, 0 flat, fractions ok). No lookahead.                                                |
| `strategies.js`                              | Catalog of named strategy configs run by `backtest.js`.                                                                                        |
| `backtest.js`                                | Engine + CLI. Next-bar-open fills, fee+slippage per side, short funding, borrow cost above 1x, IS/OOS + yearly splits, resampling 1h -> 4h/1d. |
| `scripts/research.js`                        | Sweeps, leverage, day-boundary robustness, walk-forward parameter selection -> `results/REPORT.md`.                                            |
| `scripts/build-candles.js`                   | 1min source -> 1h + 15m CSV (2023-01-01 .. latest).                                                                                            |
| `data/btcusd_1h.csv`, `data/btcusd_15m.csv`  | Candles. Cols: `timestamp(utc open s),open,high,low,close,volume`. 4h/1d are resampled in memory.                                              |
| `results/backtest-results.json`              | Last catalog run.                                                                                                                              |
| `results/REPORT.md`, `results/research.json` | Last research run (all tables).                                                                                                                |

## Run

```
node backtest.js                          # whole catalog, 1h/4h/1d as configured
node backtest.js --rule smaTrend --tf 1d  # one rule, default params
node backtest.js --fee 10 --slip 5        # bps per side (defaults)
node backtest.js --oos 2025-01-01         # OOS start (default)
node backtest.js --sort oos               # sort by OOS Sharpe
node scripts/research.js                  # full report (takes ~1 min)
```

## Rules

| Rule          | Params (defaults)                            | Logic                                                        |
| ------------- | -------------------------------------------- | ------------------------------------------------------------ |
| buyAndHold    |                                              | always long (benchmark)                                      |
| momentum      | fast 20, slow 50 (bars)                      | SMA fast > slow                                              |
| meanReversion | period 20, entryZ 2, exitZ 0 (bars)          | z-score dip buy                                              |
| breakout      | entry 55, exit 20 (bars)                     | Donchian                                                     |
| smaTrend      | days 200, band 0, short                      | close vs SMA(days), hysteresis band                          |
| emaCross      | fastDays 50, slowDays 200, short             | EMA cross                                                    |
| tsmom         | lookbackDays 90, short                       | sign of trailing return                                      |
| donchian      | entryDays 20, exitDays 10, short             | Turtle channel, stop-and-reverse                             |
| chandelier    | entryDays 20, atrBars 14, k 3                | Donchian entry, ATR trailing exit                            |
| rsiDip        | rsiBars 14, entry 30, exit 55, trendDays 200 | RSI dip inside uptrend                                       |
| trendCombo    | smaDays 200, momDays 90, short               | long only if trend AND momentum agree                        |
| volTarget     | base, baseParams, targetVol 0.4, volDays 20  | base position x targetVol/realisedVol, capped at maxLeverage |
| levered       | base, baseParams, leverage 2                 | base position x L                                            |
| ensemble      | members [{rule, params}]                     | mean of member positions                                     |
| skipDays      | days [5]                                     | flat on listed UTC weekdays                                  |
| hours         | from 13, to 21                               | long only in UTC hour window                                 |

"…Days" params are converted to bars for the timeframe in use.

## Cost model

Default 10 bps fee + 5 bps slippage per side on every unit of position change. `borrowApr` (default 10%/yr) on the part of |position| above 1x. `shortFundingApr` (default 0) while short. Equity <= 0 = wiped out. Liquidation is not otherwise modelled.

## Findings (2023-01-01 .. 2026-09-18, 15 bps/side) — see `results/REPORT.md`

Buy & hold: +358%, maxDD 53%, Sharpe 1.11, 2025-26 (OOS) -18%.

| Strategy                       | Return | maxDD | Sharpe | OOS return | Years positive |
| ------------------------------ | ------ | ----- | ------ | ---------- | -------------- |
| ensemble smaTrend 40/50/60/75d | +213%  | 31%   | 1.12   | +15.5%     | 4/4            |
| smaTrend-50d                   | +213%  | 27%   | 1.10   | +9.5%      | 4/4            |
| ensemble sma40-75 x1.5         | +341%  | 45%   | 1.07   | +15.8%     | 4/4            |
| volTarget(sma40-75) 80% cap 2x | +381%  | 49%   | 1.03   | +13.6%     | 4/4            |
| smaTrend-50d x2                | +440%  | 53%   | 1.01   | -0.9%      | 3/4            |

- Daily price-vs-SMA trend filter with 40-75 day length is the robust region: positive every year, drawdown roughly halved, positive OOS while buy & hold was -18%. 10-30d and 200d+ do not hold up OOS.
- Walk-forward (SMA length picked each year using only prior years, always chose 40d): 2024-2026 compound +105% vs buy & hold +81%, worst-year drawdown 24% vs 40%.
- Unlevered, trend filters return less than buy & hold in this bull-heavy sample (they sit out ~35-45% of the time). With 1.5x-2x leverage or 80% vol targeting they match/beat it at similar or lower drawdown, but leverage costs and liquidation risk are only roughly modelled.
- Rejected: shorting (all L/S variants worse than long-only), intraday rules on 1h/15m (costs dominate), US-hours seasonality (no stable hour-of-day edge), weekday effects (not OOS), RSI dip buying (tiny exposure).
- Caveats: 3.7 years, one cycle, ~35-40 trades per strategy. Results shift +-10% OOS depending on which UTC hour the daily bar closes. Earlier BTC cycles favoured longer (100-200d) filters.

## Long history 2014-2026 (`scripts/long-history.js` -> `results/LONG_HISTORY.md`)

Daily bars from 2013 (`data/btcusd_1d_2012.csv`, timeframe `1d-long`), 15 bps/side, long only, no leverage.

| Strategy           | 2014-26 return | CAGR | maxDD | Sharpe | 2018 bear | 2022 bear | Years positive |
| ------------------ | -------------- | ---- | ----- | ------ | --------- | --------- | -------------- |
| buy & hold         | +10,315%       | 44%  | 83%   | 0.88   | -73%      | -64%      | 8/13           |
| smaTrend-50d       | +39,501%       | 60%  | 62%   | 1.23   | -40%      | -51%      | 10/13          |
| ensemble sma40-75  | +36,046%       | 59%  | 62%   | 1.24   | -44%      | -47%      | 10/13          |
| ensemble sma40-200 | +33,197%       | 58%  | 62%   | 1.23   | -45%      | -33%      | 9/13           |
| smaTrend-200d      | +11,941%       | 46%  | 67%   | 0.99   | -55%      | 0%        | 8/13           |

- The 40-75d region holds across three full cycles: more return, higher Sharpe and lower drawdown than holding.
- It does not protect well in choppy bears: 2018 and 2022 still lost 40-50% (holding lost 64-73%). Longer filters (125-200d) handled 2022 far better but were chopped up in 2014-15 and 2021.
- Walk-forward picking a single SMA length by prior-years Sharpe is noisy: it chose 20d for 2018-21 and 125d after 2022, compounding +8,551% vs +17,594% holding over 2016-26, with worst-year drawdown 56% vs 81%. Use the fixed 40-75 ensemble rather than yearly re-fitting.

## Rebuild candles

Source: https://github.com/ff137/bitstamp-btcusd-minute-data

```
curl -sSL -o /tmp/hist.csv.gz https://raw.githubusercontent.com/ff137/bitstamp-btcusd-minute-data/main/data/historical/btcusd_bitstamp_1min_2012-2025.csv.gz
curl -sSL -o /tmp/latest.csv   https://raw.githubusercontent.com/ff137/bitstamp-btcusd-minute-data/main/data/updates/btcusd_bitstamp_1min_latest.csv
node --max-old-space-size=2048 scripts/build-candles.js /tmp/hist.csv.gz /tmp/latest.csv
node --max-old-space-size=2048 scripts/build-candles.js /tmp/hist.csv.gz /tmp/latest.csv --from 2012-01-01 --frames 1d --suffix _2012
```

## Tests

`backend/__tests__/btc-v1.test.js` (run `npm test` from `backend/`).
