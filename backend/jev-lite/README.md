# jev-lite

BTC/USD rule backtester. No server yet (scaffold in `shared/`, `railway.json`).

## Files

| File | Purpose |
|------|---------|
| `rules.js` | `momentum`, `meanReversion`, `breakout`, `buyAndHold`. Each returns 0/1 position per candle using only past data. |
| `backtest.js` | Engine + CLI. Long/flat, all-in, next-bar-open execution, fee+slippage per side. |
| `scripts/build-candles.js` | 1min source -> 1h + 15m CSV (2023-01-01 .. latest). |
| `data/btcusd_1h.csv`, `data/btcusd_15m.csv` | Candles. Cols: `timestamp(utc open s),open,high,low,close,volume`. |
| `results/backtest-results.json` | Last run output. |

## Run

```
node backtest.js                      # all rules, both timeframes
node backtest.js --tf 1h --rule momentum
node backtest.js --fee 10 --slip 5    # bps per side (defaults)
```

## Rebuild candles

Source: https://github.com/ff137/bitstamp-btcusd-minute-data

```
curl -sSL -o /tmp/hist.csv.gz https://raw.githubusercontent.com/ff137/bitstamp-btcusd-minute-data/main/data/historical/btcusd_bitstamp_1min_2012-2025.csv.gz
curl -sSL -o /tmp/latest.csv   https://raw.githubusercontent.com/ff137/bitstamp-btcusd-minute-data/main/data/updates/btcusd_bitstamp_1min_latest.csv
node --max-old-space-size=2048 scripts/build-candles.js /tmp/hist.csv.gz /tmp/latest.csv
```

## Rule defaults

| Rule | Entry | Exit |
|------|-------|------|
| momentum | SMA20 > SMA50 | SMA20 <= SMA50 |
| meanReversion | z(close, SMA20) < -2 | z > 0 |
| breakout | close > prior 55-bar high | close < prior 20-bar low |
| buyAndHold | bar 1 | last bar |

## Metrics

totalReturn, cagr, maxDrawdown, sharpe (per-bar returns net of costs, annualised by bars/year), calmar, exposure, trades, winRate, avgTradePct, profitFactor, buyHoldReturn.

## Tests

`backend/__tests__/jev-lite.test.js` (run `npm test` from `backend/`).
