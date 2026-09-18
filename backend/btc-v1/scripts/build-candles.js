'use strict';
/**
 * Build BTC/USD 1h + 15m OHLCV candles (2023-01-01 .. latest) from
 * ff137/bitstamp-btcusd-minute-data 1-minute source files.
 *
 * Usage:
 *   node scripts/build-candles.js <hist.csv.gz> <latest.csv> [outDir] [--from 2023-01-01] [--frames 1h,15m] [--suffix _2012]
 *
 * Source: https://github.com/ff137/bitstamp-btcusd-minute-data
 *   data/historical/btcusd_bitstamp_1min_2012-2025.csv.gz
 *   data/updates/btcusd_bitstamp_1min_latest.csv
 * Rows: timestamp(utc open, s),open,high,low,close,volume
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const ALL_FRAMES = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

function parseArgs(argv) {
  const positional = [];
  const opts = { from: '2023-01-01', frames: ['1h', '15m'], suffix: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') opts.from = argv[++i];
    else if (argv[i] === '--frames') opts.frames = argv[++i].split(',');
    else if (argv[i] === '--suffix') opts.suffix = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, opts };
}

function lineStream(file) {
  const raw = fs.createReadStream(file);
  const input = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  return readline.createInterface({ input, crlfDelay: Infinity });
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [histFile, latestFile, outDirArg] = positional;
  if (!histFile || !latestFile) {
    console.error(
      'usage: node scripts/build-candles.js <hist.csv.gz> <latest.csv> [outDir] [--from YYYY-MM-DD] [--frames 1h,15m] [--suffix _x]'
    );
    process.exit(1);
  }
  const START_TS = Date.parse(opts.from + 'T00:00:00Z') / 1000;
  const FRAMES = {};
  for (const f of opts.frames) {
    if (!ALL_FRAMES[f]) throw new Error(`unknown frame ${f}`);
    FRAMES[f] = ALL_FRAMES[f];
  }
  const outDir = outDirArg || path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });

  // buckets[frame] = Map<bucketTs, {o,h,l,c,v,lastMin}>
  const buckets = {};
  for (const f of Object.keys(FRAMES)) buckets[f] = new Map();
  const seenMin = new Set();
  let minutes = 0;

  for (const file of [histFile, latestFile]) {
    let header = true;
    for await (const line of lineStream(file)) {
      if (header) {
        header = false;
        continue;
      }
      if (!line) continue;
      const p = line.split(',');
      const ts = Number(p[0]);
      if (!Number.isFinite(ts) || ts < START_TS || seenMin.has(ts)) continue;
      seenMin.add(ts);
      minutes++;
      const o = +p[1];
      const h = +p[2];
      const l = +p[3];
      const c = +p[4];
      const v = +p[5];
      for (const [frame, secs] of Object.entries(FRAMES)) {
        const b = Math.floor(ts / secs) * secs;
        const m = buckets[frame];
        const cur = m.get(b);
        if (!cur) {
          m.set(b, { o, h, l, c, v, first: ts, last: ts });
        } else {
          if (ts < cur.first) {
            cur.o = o;
            cur.first = ts;
          }
          if (ts > cur.last) {
            cur.c = c;
            cur.last = ts;
          }
          if (h > cur.h) cur.h = h;
          if (l < cur.l) cur.l = l;
          cur.v += v;
        }
      }
    }
  }

  for (const [frame, secs] of Object.entries(FRAMES)) {
    const keys = [...buckets[frame].keys()].sort((a, b) => a - b);
    // drop trailing partial bucket
    const expected = secs / 60;
    while (keys.length) {
      const k = keys[keys.length - 1];
      const b = buckets[frame].get(k);
      if ((b.last - b.first) / 60 + 1 >= expected) break;
      keys.pop();
    }
    const out = ['timestamp,open,high,low,close,volume'];
    for (const k of keys) {
      const b = buckets[frame].get(k);
      out.push(`${k},${b.o},${b.h},${b.l},${b.c},${+b.v.toFixed(8)}`);
    }
    const file = path.join(outDir, `btcusd_${frame}${opts.suffix}.csv`);
    fs.writeFileSync(file, out.join('\n') + '\n');
    const first = new Date(keys[0] * 1000).toISOString();
    const last = new Date(keys[keys.length - 1] * 1000).toISOString();
    console.log(`${frame}: ${keys.length} candles ${first} .. ${last} -> ${file}`);
  }
  console.log(`source minutes used: ${minutes}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
