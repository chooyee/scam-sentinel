#!/usr/bin/env node
'use strict';
/* =====================================================================
   ibm-aml-to-scam-sentinel.js
   ---------------------------------------------------------------------
   1. Downloads the IBM "Transactions for Anti Money Laundering" dataset
      (Kaggle: ealtman2019/ibm-transactions-for-anti-money-laundering-aml)
      — only the two files for one variant (default HI-Small).
   2. Converts it into the Scam Sentinel training-data layout described in
      ../training-data/TRAINING-DATA-GUIDE.md: one row per transfer, 14
      transfers per account timeline, receiver-side signals computed
      point-in-time.

   Usage
     node tools/ibm-aml-to-scam-sentinel.js download [--variant HI-Small] [--in data/ibm-aml] [--force]
     node tools/ibm-aml-to-scam-sentinel.js convert  [--variant HI-Small] [--in data/ibm-aml]
                                                     [--out training-data/ibm-aml-corpus.csv]
                                                     [--scam 800] [--legit 1200] [--hard-share 0.25]
                                                     [--min-transfers 14] [--pad] [--warmup-days 3]
                                                     [--format csv|json|both] [--seed 42] [--max-rows N]
                                                     [--signatures 3000]   (0 = skip the signature library)
     node tools/ibm-aml-to-scam-sentinel.js all      (download, then convert)

   Besides the corpus, convert writes <out>.signatures.json: point-in-time
   receiver-side snapshots (fan-in, fan-out, pass-through, onward shape) taken
   at laundering transfers ("scam") and at clean transfers ("legit"). Load it
   into the page (Import, or Load from path) and "Generate corpus" will draw
   receiver behaviour from these real-shaped samples instead of fixed ranges.

   Kaggle credentials: ~/.kaggle/kaggle.json ({"username":..,"key":..})
   or env KAGGLE_USERNAME + KAGGLE_KEY. No npm dependencies; Node >= 18.

   What maps to what (see printHelp() and the README section in the guide):
     owner            = the sending account of the anchor transfer
     timeline         = the owner's last 14 transactions (in + out) up to the anchor
     label 1          = anchor is flagged "Is Laundering" (typology -> scenario)
     label 0          = anchor is clean and the owner never touches a laundering row
     amount           = Amount Paid converted to MYR via a static FX table (approx.)
     fan-in / fan-out = distinct counterparties of the receiver in trailing windows
     pass-through     = receiver outflow within 30 min of an inflow / inflow (24h)
     non-bank exits   = receiver outflow with Payment Format Cash or Bitcoin
     structured       = receiver outflows in equal slices or just under USD 10k
     blank            = receiver_account_age_days, onward_young_receiver_share
                        (not in the dataset; importer defaults apply)
     proxy            = balance_drain_ratio = amount / max(7d inflow, 10 x typical)
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

/* ============================ CONFIG ============================ */

const KAGGLE_DATASET = 'ealtman2019/ibm-transactions-for-anti-money-laundering-aml';
const TRANSFERS_PER_TIMELINE = 14;
const HOUR = 3600e3, DAY = 86400e3, MIN30 = 1800e3;
const USD_TO_MYR = 4.7; // approximate; only the scale matters for the model

// Approximate USD value of one unit of each currency that appears in the dataset.
const FX_TO_USD = {
  'US Dollar': 1, 'Euro': 1.08, 'UK Pound': 1.27, 'Swiss Franc': 1.13, 'Canadian Dollar': 0.74,
  'Australian Dollar': 0.66, 'Yen': 0.0067, 'Yuan': 0.14, 'Rupee': 0.012, 'Shekel': 0.27,
  'Ruble': 0.011, 'Mexican Peso': 0.058, 'Brazil Real': 0.20, 'Saudi Riyal': 0.27, 'Bitcoin': 30000,
};

// Payment formats. Cash and Bitcoin are the dataset's "non-bank" exits.
const FORMATS = ['Reinvestment', 'Cheque', 'Credit Card', 'ACH', 'Cash', 'Wire', 'Bitcoin'];
const NON_BANK_FORMATS = new Set([FORMATS.indexOf('Cash'), FORMATS.indexOf('Bitcoin')]);

// Laundering typologies named in *_Patterns.txt. Index 0 = not laundering, 1 = flagged but unmatched.
const PATTERNS = ['none', 'unknown', 'FAN-OUT', 'FAN-IN', 'GATHER-SCATTER', 'SCATTER-GATHER', 'CYCLE', 'RANDOM', 'BIPARTITE', 'STACK'];

const STRUCTURING_LIMIT_USD = 10000; // classic reporting threshold
const STRUCTURING_BAND = 0.10;       // "just under" = within 10% below the limit
const EQUAL_SLICE_TOLERANCE = 0.02;  // two onward transfers within 2% of each other

const CSV_HEADER = [
  'account_id', 'seq', 'label', 'scenario', 'owner_typical_amount', 'timestamp', 'amount', 'direction',
  'hour_of_day', 'seconds_since_previous', 'is_new_payee', 'receiver_account_age_days', 'balance_drain_ratio',
  'receiver_fan_in_1h', 'receiver_fan_in_24h', 'receiver_fan_in_7d', 'receiver_fan_out_1h', 'receiver_fan_out_24h',
  'pass_through_ratio', 'onward_nonbank_exit_share', 'onward_structured_share', 'onward_young_receiver_share',
  'amount_vs_typical', 'is_round_amount',
];

/* ============================ CLI ============================ */

function parseArgs(argv) {
  const opts = {
    variant: 'HI-Small', in: 'data/ibm-aml', out: 'training-data/ibm-aml-corpus.csv',
    scam: 800, legit: 1200, hardShare: 0.25, minTransfers: TRANSFERS_PER_TIMELINE, pad: false,
    warmupDays: 3, format: 'csv', seed: 42, maxRows: Infinity, force: false, signatures: 3000,
  };
  const keyMap = { 'hard-share': 'hardShare', 'min-transfers': 'minTransfers', 'warmup-days': 'warmupDays', 'max-rows': 'maxRows' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const raw = a.slice(2);
    const key = keyMap[raw] || raw;
    if (key === 'pad' || key === 'force') { opts[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${raw} needs a value`);
    opts[key] = ['scam', 'legit', 'hardShare', 'minTransfers', 'warmupDays', 'seed', 'maxRows', 'signatures'].includes(key) ? Number(value) : value;
  }
  return { command: positional[0], opts };
}

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf8').split('===== */')[0].split('\n').slice(2).join('\n'));
}

function log(...args) { console.error(new Date().toISOString().slice(11, 19), ...args); }

/* ============================ DOWNLOAD ============================ */

/** Kaggle API token from env or ~/.kaggle/kaggle.json, or null (public datasets often download anonymously). */
function loadKaggleCredentials() {
  if (process.env.KAGGLE_USERNAME && process.env.KAGGLE_KEY) {
    return { username: process.env.KAGGLE_USERNAME, key: process.env.KAGGLE_KEY };
  }
  const file = path.join(process.env.KAGGLE_CONFIG_DIR || path.join(os.homedir(), '.kaggle'), 'kaggle.json');
  if (fs.existsSync(file)) {
    const { username, key } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (username && key) return { username, key };
  }
  return null;
}

function credentialsHelp() {
  const file = path.join(process.env.KAGGLE_CONFIG_DIR || path.join(os.homedir(), '.kaggle'), 'kaggle.json');
  return 'Kaggle refused the anonymous download. Create an API token at https://www.kaggle.com/settings and either\n' +
    `  save it as ${file}\n` +
    '  or set KAGGLE_USERNAME and KAGGLE_KEY in the environment.\n' +
    'Alternatively download the files by hand from https://www.kaggle.com/datasets/' + KAGGLE_DATASET +
    ' into the --in folder and run "convert".';
}

function isZipFile(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  return head.readUInt32LE(0) === 0x04034b50;
}

/** Extract the first entry of a plain (non-zip64) zip file by streaming through inflateRaw. */
async function extractSingleFileZip(zipFile, dest) {
  const size = fs.statSync(zipFile).size;
  const fd = fs.openSync(zipFile, 'r');
  try {
    // End-of-central-directory record sits in the last 64 KiB + 22 bytes.
    const tailLength = Math.min(size, 65536 + 22);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
    const centralOffset = tail.readUInt32LE(eocd + 16);

    const central = Buffer.alloc(46);
    fs.readSync(fd, central, 0, 46, centralOffset);
    if (central.readUInt32LE(0) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = central.readUInt16LE(10);
    const compressedSize = central.readUInt32LE(20);
    const localOffset = central.readUInt32LE(42);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('zip64 archive: please unzip it manually into the --in folder');
    }
    const local = Buffer.alloc(30);
    fs.readSync(fd, local, 0, 30, localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('zip: bad local header');
    const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);

    const source = fs.createReadStream(zipFile, { start: dataStart, end: dataStart + compressedSize - 1 });
    const sink = fs.createWriteStream(dest);
    if (method === 8) await pipeline(source, zlib.createInflateRaw(), sink);
    else if (method === 0) await pipeline(source, sink);
    else throw new Error(`zip: unsupported compression method ${method}`);
  } finally {
    fs.closeSync(fd);
  }
}

async function download(opts) {
  const creds = loadKaggleCredentials();
  const headers = creds ? { Authorization: 'Basic ' + Buffer.from(`${creds.username}:${creds.key}`).toString('base64') } : {};
  log(creds ? `using Kaggle token for ${creds.username}` : 'no Kaggle token found; trying anonymous download');
  fs.mkdirSync(opts.in, { recursive: true });

  for (const file of [`${opts.variant}_Trans.csv`, `${opts.variant}_Patterns.txt`]) {
    const dest = path.join(opts.in, file);
    if (fs.existsSync(dest) && !opts.force) { log(`skip ${file} (exists; use --force to re-download)`); continue; }

    const url = `https://www.kaggle.com/api/v1/datasets/download/${KAGGLE_DATASET}/${encodeURIComponent(file)}`;
    log(`GET ${url}`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error(`Kaggle responded ${res.status} for ${file}.\n` + credentialsHelp());
      throw new Error(`Kaggle responded ${res.status} ${res.statusText} for ${file}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) throw new Error(`Kaggle returned a web page instead of ${file} (probably a login page).\n` + credentialsHelp());

    const tmp = dest + '.download';
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0, lastLogged = 0;
    const progress = new (require('stream').Transform)({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received - lastLogged > 50e6) { lastLogged = received; log(`  ${(received / 1e6).toFixed(0)} MB${total ? ` of ${(total / 1e6).toFixed(0)} MB` : ''}`); }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), progress, fs.createWriteStream(tmp));
    const bytes = fs.statSync(tmp).size;

    if (isZipFile(tmp)) {
      log(`unzipping ${file} (${(bytes / 1e6).toFixed(1)} MB compressed)`);
      await extractSingleFileZip(tmp, dest);
      fs.unlinkSync(tmp);
    } else {
      fs.renameSync(tmp, dest);
    }
    log(`saved ${dest} (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
  }
}

/* ============================ LOADING ============================ */

/** Growable typed array. */
class Column {
  constructor(Type, capacity = 1 << 16) { this.Type = Type; this.buf = new Type(capacity); this.length = 0; }
  push(v) {
    if (this.length === this.buf.length) { const next = new this.Type(this.buf.length * 2); next.set(this.buf); this.buf = next; }
    this.buf[this.length++] = v;
  }
  finish() { return this.buf.subarray(0, this.length); }
}

/** "2022/09/01 00:20" -> ms since epoch (treated as UTC). */
function parseTimestamp(s) {
  if (s.length < 16) return NaN;
  return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16));
}

/** Key that identifies one transaction line in both the Trans and Patterns files. */
function transactionKey(cols) {
  return `${cols[0]}|${cols[1]}|${cols[2]}|${cols[3]}|${cols[4]}|${cols[7]}`;
}

/** Read *_Patterns.txt into Map<transactionKey, patternIndex>. */
async function loadPatterns(file) {
  const map = new Map();
  if (!fs.existsSync(file)) { log(`no patterns file at ${file}; scenarios will read aml:unknown`); return map; }
  let current = 1;
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (line.startsWith('BEGIN LAUNDERING ATTEMPT')) {
      // e.g. "BEGIN LAUNDERING ATTEMPT - FAN-OUT:  Max 16-degree Fan-Out"
      const name = (line.split(' - ')[1] || '').split(':')[0].trim().toUpperCase();
      current = Math.max(1, PATTERNS.indexOf(name));
    } else if (line.startsWith('END LAUNDERING ATTEMPT')) {
      current = 1;
    } else if (line.includes(',')) {
      map.set(transactionKey(line.split(',')), current);
    }
  }
  log(`patterns: ${map.size} laundering transactions tagged`);
  return map;
}

/** Read *_Trans.csv into columnar typed arrays (self-transfers dropped). */
async function loadTransactions(file, patterns, maxRows) {
  const time = new Column(Float64Array), from = new Column(Int32Array), to = new Column(Int32Array);
  const amountUsd = new Column(Float64Array), format = new Column(Uint8Array), pattern = new Column(Uint8Array);
  const accountIndex = new Map();
  const accounts = [];
  const accountOf = (bank, acct) => {
    const key = `${bank}:${acct}`;
    let id = accountIndex.get(key);
    if (id === undefined) { id = accounts.length; accountIndex.set(key, id); accounts.push(key); }
    return id;
  };
  const unknownCurrencies = new Map();
  let lineNo = 0, skippedSelf = 0, skippedBad = 0;

  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (lineNo++ === 0) { if (!line.startsWith('Timestamp')) throw new Error(`unexpected header in ${file}: ${line}`); continue; }
    if (lineNo > maxRows) break;
    const cols = line.split(',');
    if (cols.length < 11) { skippedBad++; continue; }
    const ts = parseTimestamp(cols[0]);
    if (Number.isNaN(ts)) { skippedBad++; continue; }
    const sender = accountOf(cols[1], cols[2]);
    const receiver = accountOf(cols[3], cols[4]);
    if (sender === receiver) { skippedSelf++; continue; }
    const fx = FX_TO_USD[cols[8]];
    if (fx === undefined) { unknownCurrencies.set(cols[8], (unknownCurrencies.get(cols[8]) || 0) + 1); skippedBad++; continue; }
    const fmt = FORMATS.indexOf(cols[9]);
    const laundering = cols[10].trim() === '1';

    time.push(ts); from.push(sender); to.push(receiver);
    amountUsd.push(parseFloat(cols[7]) * fx);
    format.push(fmt < 0 ? 0 : fmt);
    pattern.push(laundering ? (patterns.get(transactionKey(cols)) || 1) : 0);
    if (lineNo % 1e6 === 0) log(`  ${lineNo.toLocaleString()} lines read`);
  }
  if (unknownCurrencies.size) log('skipped unknown currencies:', Object.fromEntries(unknownCurrencies));
  log(`transactions: ${time.length.toLocaleString()} kept, ${skippedSelf} self-transfers and ${skippedBad} bad rows dropped, ${accounts.length.toLocaleString()} accounts`);
  return { n: time.length, time: time.finish(), from: from.finish(), to: to.finish(), amountUsd: amountUsd.finish(), format: format.finish(), pattern: pattern.finish(), accounts };
}

/** Sort row indices by time and build per-account CSR indexes (all / in / out). */
function buildIndexes(d) {
  let order = new Int32Array(d.n);
  for (let i = 0; i < d.n; i++) order[i] = i;
  let sorted = true;
  for (let i = 1; i < d.n; i++) if (d.time[i] < d.time[i - 1]) { sorted = false; break; }
  if (!sorted) { log('sorting by time'); order = order.sort((a, b) => d.time[a] - d.time[b] || a - b); }

  const nAcc = d.accounts.length;
  const build = (touches) => {
    const count = new Int32Array(nAcc + 1);
    for (let k = 0; k < d.n; k++) { const i = order[k]; if (touches(i, d.from[i])) count[d.from[i] + 1]++; if (touches(i, d.to[i])) count[d.to[i] + 1]++; }
    for (let a = 0; a < nAcc; a++) count[a + 1] += count[a];
    const rows = new Int32Array(count[nAcc]);
    const fill = count.slice(0, nAcc);
    for (let k = 0; k < d.n; k++) {
      const i = order[k];
      if (touches(i, d.from[i])) rows[fill[d.from[i]]++] = i;
      if (touches(i, d.to[i])) rows[fill[d.to[i]]++] = i;
    }
    return { offsets: count, rows };
  };
  const all = build(() => true);
  const out = build((i, acc) => d.from[i] === acc);
  const inn = build((i, acc) => d.to[i] === acc);
  return { order, all, out, in: inn };
}

/* ============================ FEATURES ============================ */

class FeatureEngine {
  constructor(d, idx) { this.d = d; this.idx = idx; this.firstPaidCache = new Map(); }

  /** Rows of `acct` in index `which` with time in (t - windowMs, t]. Returns [start, end) positions. */
  window(which, acct, t, windowMs) {
    const { offsets, rows } = this.idx[which];
    const lo = offsets[acct], hi = offsets[acct + 1];
    const lower = this.bisect(rows, lo, hi, t - windowMs);   // first row with time > t - w
    const upper = this.bisect(rows, lo, hi, t);              // first row with time > t
    return [lower, upper];
  }

  /** First position in rows[lo, hi) whose time is greater than t. */
  bisect(rows, lo, hi, t) {
    const time = this.d.time;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (time[rows[mid]] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Map<receiver, first time `acct` ever paid them>. Cached per account. */
  firstPaid(acct) {
    let m = this.firstPaidCache.get(acct);
    if (m) return m;
    m = new Map();
    const { offsets, rows } = this.idx.out;
    for (let p = offsets[acct]; p < offsets[acct + 1]; p++) { const i = rows[p]; if (!m.has(this.d.to[i])) m.set(this.d.to[i], this.d.time[i]); }
    this.firstPaidCache.set(acct, m);
    return m;
  }

  isNewPayee(owner, receiver, t) { const first = this.firstPaid(owner).get(receiver); return first === undefined || first >= t ? 1 : 0; }

  /** Distinct senders into `acct` in the window, excluding `exclude`. */
  fanIn(acct, t, windowMs, exclude) {
    const [a, b] = this.window('in', acct, t, windowMs);
    const rows = this.idx.in.rows, seen = new Set();
    for (let p = a; p < b; p++) { const s = this.d.from[rows[p]]; if (s !== exclude) seen.add(s); }
    return seen.size;
  }

  /** Distinct first-time receivers `acct` paid in the window (never paid before the window start). */
  fanOut(acct, t, windowMs) {
    const [a, b] = this.window('out', acct, t, windowMs);
    const rows = this.idx.out.rows, first = this.firstPaid(acct), seen = new Set();
    for (let p = a; p < b; p++) { const r = this.d.to[rows[p]]; if (first.get(r) > t - windowMs) seen.add(r); }
    return seen.size;
  }

  /** Share of the last-24h inflow to `acct` that left again within 30 minutes of an inflow. */
  passThrough(acct, t) {
    const [ia, ib] = this.window('in', acct, t, DAY);
    const [oa, ob] = this.window('out', acct, t, DAY);
    const inRows = this.idx.in.rows, outRows = this.idx.out.rows, time = this.d.time, amt = this.d.amountUsd;
    let inflow = 0;
    for (let p = ia; p < ib; p++) inflow += amt[inRows[p]];
    if (inflow <= 0) return 0;
    let outflow = 0, q = ia;
    for (let p = oa; p < ob; p++) {
      const tOut = time[outRows[p]];
      while (q < ib && time[inRows[q]] + MIN30 < tOut) q++;               // drop inflows too old to matter
      let matched = false;
      for (let r = q; r < ib && time[inRows[r]] <= tOut; r++) { if (tOut - time[inRows[r]] <= MIN30) { matched = true; break; } }
      if (matched) outflow += amt[outRows[p]];
    }
    return Math.min(1, outflow / inflow);
  }

  /** Non-bank exit share and structured share of `acct`'s outflow in the last 24h. */
  onwardShape(acct, t) {
    const [a, b] = this.window('out', acct, t, DAY);
    const rows = this.idx.out.rows, amt = this.d.amountUsd, fmt = this.d.format;
    if (b <= a) return { nonBank: 0, structured: 0 };
    let total = 0, nonBank = 0, structuredCount = 0;
    const amounts = [];
    for (let p = a; p < b; p++) { const v = amt[rows[p]]; total += v; amounts.push(v); if (NON_BANK_FORMATS.has(fmt[rows[p]])) nonBank += v; }
    for (let i = 0; i < amounts.length; i++) {
      const v = amounts[i];
      let structured = v < STRUCTURING_LIMIT_USD && v >= STRUCTURING_LIMIT_USD * (1 - STRUCTURING_BAND);
      if (!structured && amounts.length > 1) {
        for (let j = 0; j < amounts.length; j++) if (j !== i && Math.abs(amounts[j] - v) <= EQUAL_SLICE_TOLERANCE * v) { structured = true; break; }
      }
      if (structured) structuredCount++;
    }
    return { nonBank: total > 0 ? nonBank / total : 0, structured: structuredCount / amounts.length };
  }

  /** Sum of inflow to `acct` over the last 7 days (for the drain proxy). */
  inflow7d(acct, t) {
    const [a, b] = this.window('in', acct, t, 7 * DAY);
    let sum = 0; for (let p = a; p < b; p++) sum += this.d.amountUsd[this.idx.in.rows[p]];
    return sum;
  }

  /** Median outbound amount of `acct` strictly before `t` (USD), or null if fewer than 3. */
  typicalAmount(acct, t) {
    const { offsets, rows } = this.idx.out;
    const end = this.bisect(rows, offsets[acct], offsets[acct + 1], t - 1);
    const values = [];
    for (let p = offsets[acct]; p < end; p++) values.push(this.d.amountUsd[rows[p]]);
    if (values.length < 3) return null;
    values.sort((x, y) => x - y);
    return values[Math.floor(values.length / 2)];
  }
}

/* ============================ TIMELINES ============================ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function shuffle(array, rng) { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } return array; }

/** Build one timeline ending at `anchorRow` for `owner`. Returns null if too short. */
function buildTimeline(engine, owner, anchorRow, opts) {
  const { d, idx } = engine;
  const { offsets, rows } = idx.all;
  const lo = offsets[owner], hi = offsets[owner + 1];
  let pos = engine.bisect(rows, lo, hi, d.time[anchorRow] - 1);
  while (pos < hi && rows[pos] !== anchorRow) pos++;
  if (pos >= hi) return null;

  const start = Math.max(lo, pos + 1 - TRANSFERS_PER_TIMELINE);
  const count = pos + 1 - start;
  if (count < opts.minTransfers) return null;

  const tAnchor = d.time[anchorRow];
  const typicalUsd = engine.typicalAmount(owner, d.time[rows[start]]) ?? engine.typicalAmount(owner, tAnchor + 1) ?? 100;
  const transfers = [];
  for (let p = start; p <= pos; p++) {
    const i = rows[p];
    const t = d.time[i];
    const outbound = d.from[i] === owner;
    const counterparty = outbound ? d.to[i] : d.from[i];
    const prevTime = p > lo ? d.time[rows[p - 1]] : null;
    const shape = engine.onwardShape(counterparty, t);
    transfers.push({
      timestamp: new Date(t).toISOString().replace('.000Z', '+00:00'),
      amount: round2(d.amountUsd[i] * USD_TO_MYR),
      direction: outbound ? 1 : 0,
      hourOfDay: new Date(t).getUTCHours(),
      secondsSincePrevious: prevTime === null ? 86400 : Math.round((t - prevTime) / 1000),
      isNewPayee: outbound ? engine.isNewPayee(owner, counterparty, t) : 0,
      balanceDrainRatio: outbound ? round3(Math.min(1, d.amountUsd[i] / Math.max(engine.inflow7d(owner, t), typicalUsd * 10, d.amountUsd[i]))) : 0,
      receiverFanInLastHour: engine.fanIn(counterparty, t, HOUR, owner),
      receiverFanInLast24h: engine.fanIn(counterparty, t, DAY, owner),
      receiverFanInLast7d: engine.fanIn(counterparty, t, 7 * DAY, owner),
      receiverFanOut1h: engine.fanOut(counterparty, t, HOUR),
      receiverFanOut24h: engine.fanOut(counterparty, t, DAY),
      passThroughRatio: round3(engine.passThrough(counterparty, t)),
      onwardNonBankExitShare: round3(shape.nonBank),
      onwardStructuredShare: round3(shape.structured),
      ...(outbound ? {} : { amountVsTypical: 1, isRoundAmount: 0 }),
    });
  }
  if (opts.pad) while (transfers.length < TRANSFERS_PER_TIMELINE) transfers.unshift(paddingTransfer(transfers[0].timestamp, typicalUsd));

  return { ownerTypicalAmount: round2(typicalUsd * USD_TO_MYR), transfers, anchorIndex: transfers.length - 1 };
}

/** Neutral baseline row used when --pad is set (mirrors the page's canonical transfer). */
function paddingTransfer(beforeTimestamp, typicalUsd) {
  const t = new Date(beforeTimestamp).getTime() - DAY;
  return {
    timestamp: new Date(t).toISOString().replace('.000Z', '+00:00'), amount: round2(typicalUsd * USD_TO_MYR), direction: 1,
    hourOfDay: 14, secondsSincePrevious: 86400, isNewPayee: 0, balanceDrainRatio: 0.015,
    receiverFanInLastHour: 0, receiverFanInLast24h: 1, receiverFanInLast7d: 3, receiverFanOut1h: 0, receiverFanOut24h: 0,
    passThroughRatio: 0.05, onwardNonBankExitShare: 0.05, onwardStructuredShare: 0.05, padded: true,
  };
}

const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;

/** Pick anchors and build the labelled corpus. */
function buildCorpus(d, idx, opts) {
  const engine = new FeatureEngine(d, idx);
  const rng = mulberry32(opts.seed);
  const tMin = d.time[idx.order[0]], tMax = d.time[idx.order[d.n - 1]];
  const warmup = tMin + opts.warmupDays * DAY;
  log(`dataset spans ${new Date(tMin).toISOString().slice(0, 10)} .. ${new Date(tMax).toISOString().slice(0, 10)}; anchors after ${new Date(warmup).toISOString().slice(0, 10)}`);

  // Accounts that touch any laundering row are never used as clean examples.
  const tainted = new Uint8Array(d.accounts.length);
  const lastLaunderingBySender = new Map();
  for (let i = 0; i < d.n; i++) {
    if (!d.pattern[i]) continue;
    tainted[d.from[i]] = 1; tainted[d.to[i]] = 1;
    if (d.time[i] < warmup) continue;
    const prev = lastLaunderingBySender.get(d.from[i]);
    if (prev === undefined || d.time[i] > d.time[prev]) lastLaunderingBySender.set(d.from[i], i);
  }

  const stats = { candidatesScam: lastLaunderingBySender.size, scam: 0, legit: 0, hardLegit: 0, tooShort: 0, byScenario: {} };
  const timelines = [];
  const used = new Uint8Array(d.accounts.length);

  // Positives: one anchor per laundering sender (its last flagged outbound after warm-up).
  for (const [owner, row] of shuffle([...lastLaunderingBySender.entries()], rng)) {
    if (timelines.length >= opts.scam) break;
    const tl = buildTimeline(engine, owner, row, opts);
    if (!tl) { stats.tooShort++; continue; }
    const scenario = 'aml:' + PATTERNS[d.pattern[row]].toLowerCase();
    timelines.push({ id: `IBM-${d.accounts[owner].replace(':', '-')}`, label: 1, scenario, ...tl });
    used[owner] = 1; stats.scam++; stats.byScenario[scenario] = (stats.byScenario[scenario] || 0) + 1;
  }

  // Negatives: clean senders, sampled from a shuffled row order; a share must be "big new payee" hard cases.
  const hardQuota = Math.round(opts.legit * opts.hardShare);
  const order = shuffle(Array.from(idx.order), rng);
  for (const row of order) {
    if (stats.legit >= opts.legit) break;
    const owner = d.from[row];
    if (d.pattern[row] || tainted[owner] || used[owner] || d.time[row] < warmup) continue;
    const tl = buildTimeline(engine, owner, row, opts);
    if (!tl) { stats.tooShort++; continue; }
    const anchor = tl.transfers[tl.anchorIndex];
    const isHard = anchor.isNewPayee === 1 && anchor.amount >= 5 * tl.ownerTypicalAmount;
    if (isHard && stats.hardLegit >= hardQuota) continue;
    if (!isHard && stats.legit - stats.hardLegit >= opts.legit - hardQuota) continue;
    const scenario = isHard ? 'big new payee' : 'routine';
    timelines.push({ id: `IBM-${d.accounts[owner].replace(':', '-')}`, label: 0, scenario, ...tl });
    used[owner] = 1; stats.legit++; if (isHard) stats.hardLegit++;
    stats.byScenario[scenario] = (stats.byScenario[scenario] || 0) + 1;
  }
  return { timelines: shuffle(timelines, rng), stats, engine, tainted, warmup, rng };
}

/**
 * Receiver-side snapshot of `to` at the moment row `i` happened, as the sender saw it.
 * Same definitions as buildTimeline(), so the page can plug these straight into its generator.
 */
function receiverSnapshot(engine, i) {
  const { d } = engine;
  const t = d.time[i], receiver = d.to[i], sender = d.from[i];
  const shape = engine.onwardShape(receiver, t);
  return {
    receiverFanInLastHour: engine.fanIn(receiver, t, HOUR, sender),
    receiverFanInLast24h: engine.fanIn(receiver, t, DAY, sender),
    receiverFanInLast7d: engine.fanIn(receiver, t, 7 * DAY, sender),
    receiverFanOut1h: engine.fanOut(receiver, t, HOUR),
    receiverFanOut24h: engine.fanOut(receiver, t, DAY),
    passThroughRatio: round3(engine.passThrough(receiver, t)),
    onwardNonBankExitShare: round3(shape.nonBank),
    onwardStructuredShare: round3(shape.structured),
  };
}

/** Sample up to `count` scam and `count` legit receiver snapshots for the page's generator. */
function extractSignatures(d, idx, engine, tainted, warmup, rng, count) {
  const launderingRows = [], cleanRows = [];
  for (let i = 0; i < d.n; i++) {
    if (d.time[i] < warmup) continue;
    if (d.pattern[i]) launderingRows.push(i);
    else if (!tainted[d.to[i]] && !tainted[d.from[i]]) cleanRows.push(i);
  }
  const pick = (rows) => shuffle(rows, rng).slice(0, count).map((i) => receiverSnapshot(engine, i));
  return { scam: pick(launderingRows), legit: pick(cleanRows) };
}

/* ============================ OUTPUT ============================ */

function writeCsv(file, timelines) {
  const lines = [CSV_HEADER.join(',')];
  const blank = '';
  for (const tl of timelines) {
    tl.transfers.forEach((t, k) => {
      lines.push([
        tl.id, k + 1, tl.label, tl.scenario, tl.ownerTypicalAmount, t.timestamp, t.amount, t.direction ? 'out' : 'in',
        t.hourOfDay, t.secondsSincePrevious, t.isNewPayee, blank /* receiver_account_age_days */, t.balanceDrainRatio,
        t.receiverFanInLastHour, t.receiverFanInLast24h, t.receiverFanInLast7d, t.receiverFanOut1h, t.receiverFanOut24h,
        t.passThroughRatio, t.onwardNonBankExitShare, t.onwardStructuredShare, blank /* onward_young_receiver_share */,
        t.amountVsTypical ?? blank, t.isRoundAmount ?? blank,
      ].join(','));
    });
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function writeJson(file, timelines, opts) {
  const corpus = {
    $schema: './training-data.schema.json', format: 'scam-sentinel-corpus', version: 1,
    notes: `Converted from IBM AML ${opts.variant} (Kaggle ${KAGGLE_DATASET}). Labels are laundering typologies, not scam reports. ` +
      'Amounts are approximate MYR via a static FX table. receiver_account_age_days and onward_young_receiver_share are unavailable. ' +
      'balance_drain_ratio is a proxy (amount / max(7-day inflow, 10 x typical)). pass-through window 30 min.',
    timelines: timelines.map((tl) => ({
      id: tl.id, label: tl.label, scenario: tl.scenario, ownerTypicalAmount: tl.ownerTypicalAmount,
      transfers: tl.transfers.map(({ padded, ...t }) => t),
    })),
  };
  fs.writeFileSync(file, JSON.stringify(corpus));
}

async function convert(opts) {
  const transFile = path.join(opts.in, `${opts.variant}_Trans.csv`);
  const patternsFile = path.join(opts.in, `${opts.variant}_Patterns.txt`);
  if (!fs.existsSync(transFile)) throw new Error(`${transFile} not found; run "download" first or pass --in`);

  log(`reading ${transFile}`);
  const patterns = await loadPatterns(patternsFile);
  const d = await loadTransactions(transFile, patterns, opts.maxRows);
  if (d.n === 0) throw new Error('no usable transactions');
  log('building indexes');
  const idx = buildIndexes(d);
  log('building timelines');
  const { timelines, stats, engine, tainted, warmup, rng } = buildCorpus(d, idx, opts);

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const base = opts.out.replace(/\.(csv|json)$/i, '');
  if (opts.format === 'csv' || opts.format === 'both') { writeCsv(base + '.csv', timelines); log(`wrote ${base}.csv`); }
  if (opts.format === 'json' || opts.format === 'both') { writeJson(base + '.json', timelines, opts); log(`wrote ${base}.json`); }
  if (opts.signatures > 0) {
    log('extracting receiver signatures');
    const signatures = extractSignatures(d, idx, engine, tainted, warmup, rng, opts.signatures);
    fs.writeFileSync(base + '.signatures.json', JSON.stringify({
      format: 'scam-sentinel-mule-signatures', version: 1,
      source: `IBM AML ${opts.variant}`, note: 'Point-in-time receiver snapshots as seen by the sender. No account age in the source; the page keeps its synthetic age.',
      ...signatures,
    }));
    stats.signatures = { scam: signatures.scam.length, legit: signatures.legit.length };
    log(`wrote ${base}.signatures.json (${signatures.scam.length} scam / ${signatures.legit.length} legit)`);
  }
  const report = { variant: opts.variant, options: opts, rows: d.n, accounts: d.accounts.length, timelines: timelines.length, ...stats };
  fs.writeFileSync(base + '.report.json', JSON.stringify(report, null, 2));
  log(`wrote ${base}.report.json`);
  console.log(JSON.stringify({ timelines: timelines.length, scam: stats.scam, legit: stats.legit, hardLegit: stats.hardLegit, tooShort: stats.tooShort, byScenario: stats.byScenario, signatures: stats.signatures }, null, 2));
}

/* ============================ MAIN ============================ */

module.exports = { parseArgs, download, convert, loadPatterns, loadTransactions, buildIndexes, FeatureEngine, buildTimeline, buildCorpus, extractSignatures, extractSingleFileZip };

if (require.main === module) {
  (async () => {
    try {
      const { command, opts } = parseArgs(process.argv.slice(2));
      if (command === 'download') await download(opts);
      else if (command === 'convert') await convert(opts);
      else if (command === 'all') { await download(opts); await convert(opts); }
      else { printHelp(); process.exitCode = command ? 1 : 0; }
    } catch (err) {
      console.error('error:', err.message);
      process.exitCode = 1;
    }
  })();
}
