/**
 * Prefetch the frozen partition datasets.
 *
 * Run ONCE. Writes gzipped files into data/frozen/ plus a manifest carrying each
 * file's sha256. Runtime reads those files and never pages the API for partition
 * data.
 *
 *   node --experimental-strip-types scripts/prefetch.ts
 *   node --experimental-strip-types scripts/prefetch.ts --partitions DISCOVERY
 *   node --experimental-strip-types scripts/prefetch.ts --symbols BTCUSDT,RCOINUSDT
 *   node --experimental-strip-types scripts/prefetch.ts --kinds funding
 *
 * TWO KINDS OF FILE
 * -----------------
 *   candles   <SYMBOL>__<PARTITION>.json.gz          [ts, close]
 *   funding   <SYMBOL>__<PARTITION>.funding.json.gz  [fundingTime, fundingRate]
 *
 * Candles alone were not enough. A verdict rests on a price leg AND a signal
 * leg, and for the funding families the signal leg is a funding rate. While only
 * candles were frozen, every funding rate was still fetched live on each
 * backtest, so the `dataset_sha256` recorded with each verdict described the
 * price data and silently missed the funding data behind most of them. Freezing
 * one of the two legs is worse than freezing neither, because the provenance
 * claim then looks complete while being partial.
 *
 * Funding is only frozen for the REFERENCE coins (BTCUSDT, ETHUSDT), because
 * those are the only funding series any signal reads — the rToken targets are
 * priced, never funded, in this protocol.
 *
 * LEAD-IN
 * -------
 * Each file covers its partition PLUS a bounded lead-in of older data, so that
 * a signal's warm-up reads resolve from the committed file instead of the
 * network. Nothing after the partition end is ever written. The rule and its
 * justification live in src/data/freezeWindow.ts, which this script imports so
 * the freezer and the reader cannot disagree about the window.
 *
 * ENDPOINT STRATEGY (candles)
 * ---------------------------
 * Bitget exposes two candle endpoints with different trade-offs:
 *
 *   /api/v2/spot/market/candles          limit 1000, shallow 1min retention
 *   /api/v2/spot/market/history-candles  limit  200, deep 1min retention
 *
 * Neither dominates. The fast one covers recent windows and every rToken back
 * past the start of DISCOVERY; the deep one goes back to April for BTC/ETH but
 * needs five times as many requests. So each page tries fast first and falls
 * back to deep. Measured: rTokens resolve entirely on the fast path (~43
 * requests per symbol for DISCOVERY), BTC/ETH fall through to the deep path.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Imported with explicit `.ts` specifiers because this script runs under Node's
// strip-only type stripping, which does not rewrite `./x.js` to `./x.ts`. Both
// modules are deliberately dependency-free so they can be imported from here at
// all — see the header of src/data/freezeWindow.ts. Importing them (rather than
// re-deriving the numbers) is the point: the freezer and the runtime reader
// share one definition of the freeze window and one funding pagination.
import {
  clampRowsToFreezeWindow,
  freezeWindowFor,
  MINUTE_MS,
  type FrozenKind,
} from '../src/data/freezeWindow.ts';
import { fetchFundingHistory, FUNDING_SOURCE } from '../src/data/fundingHistory.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'data', 'frozen');

const BASE = 'https://api.bitget.com';
const FAST_LIMIT = 1000;
const DEEP_LIMIT = 200;
const PAGE_DELAY_MS = 60;

const CANDLE_SOURCE = 'bitget:/api/v2/spot/market/{candles,history-candles}';

/** [unixMs, value] — the only two fields the protocol needs. */
type FrozenRow = [number, number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function getJson<T>(url: string, attempts = 4): Promise<T | null> {
  for (let a = 1; a <= attempts; a++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status >= 500 && a < attempts) {
        await sleep(400 * a);
        continue;
      }
      const body = (await res.json()) as T;
      return body;
    } catch {
      if (a === attempts) return null;
      await sleep(400 * a);
    }
  }
  return null;
}

interface CandleResponse {
  code?: string;
  msg?: string;
  data?: string[][];
}

/** One page of up to `limit` candles ending at `endMs`, newest-last. */
async function pageVia(
  endpoint: string,
  symbol: string,
  endMs: number,
  limit: number,
): Promise<FrozenRow[] | null> {
  const url =
    `${BASE}/api/v2/spot/market/${endpoint}?symbol=${encodeURIComponent(symbol)}` +
    `&granularity=1min&endTime=${endMs}&limit=${limit}`;
  const body = await getJson<CandleResponse>(url);
  if (!body) return null;
  // A parameter error means this endpoint cannot serve this request at all
  // (e.g. limit too large) — distinct from a legitimate empty result.
  if (body.code && body.code !== '00000') return null;
  return (body.data ?? []).map((r) => [Number(r[0]), Number(r[4])] as FrozenRow);
}

/**
 * Fetch one page, preferring the fast endpoint.
 *
 * Fast is tried first because it is 5x cheaper per request. When it returns
 * nothing — which is what it does for windows older than its 1min retention —
 * the deep endpoint is asked instead.
 */
async function page(symbol: string, endMs: number): Promise<FrozenRow[]> {
  const fast = await pageVia('candles', symbol, endMs, FAST_LIMIT);
  if (fast && fast.length > 0) return fast;

  const deep = await pageVia('history-candles', symbol, endMs, DEEP_LIMIT);
  if (deep && deep.length > 0) return deep;

  return [];
}

/** Walk backward from `endMs` to `startMs`, de-duplicating by timestamp. */
async function fetchWindow(
  symbol: string,
  startMs: number,
  endMs: number,
  log: (msg: string) => void,
): Promise<FrozenRow[]> {
  const byTs = new Map<number, number>();
  let cursor = endMs;
  let pages = 0;

  for (;;) {
    if (++pages > 20_000) {
      log(`  ! pagination guard tripped for ${symbol}`);
      break;
    }

    const rows = await page(symbol, cursor);
    if (rows.length === 0) break;

    rows.sort((a, b) => a[0] - b[0]);
    for (const [ts, close] of rows) {
      if (ts >= startMs && ts <= endMs) byTs.set(ts, close);
    }

    const oldest = rows[0]![0];
    if (oldest <= startMs) break;

    const next = oldest - MINUTE_MS;
    if (next >= cursor) break; // no progress
    cursor = next;

    if (pages % 50 === 0) log(`  ... ${pages} pages, ${byTs.size} candles`);
    await sleep(PAGE_DELAY_MS);
  }

  return [...byTs.entries()].sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------------------
// Frozen file output
// ---------------------------------------------------------------------------

export interface FrozenEntry {
  symbol: string;
  partition: string;
  /** Which series this file holds. Absent on pre-funding entries means candles. */
  kind: FrozenKind;
  /** First row's timestamp, unix ms. For a lead-in'd file this PREDATES the partition. */
  startMs: number;
  /** Last row's timestamp, unix ms. Never after the partition end. */
  endMs: number;
  rows: number;
  sha256: string;
  file: string;
  fetched_at: string;
  source: string;
}

/** `<SYMBOL>__<PARTITION>.json.gz`, or `...funding.json.gz` for funding. */
function frozenFileName(symbol: string, partition: string, kind: FrozenKind): string {
  return kind === 'funding'
    ? `${symbol}__${partition}.funding.json.gz`
    : `${symbol}__${partition}.json.gz`;
}

/**
 * Write a frozen file and describe it.
 *
 * `startMs`/`endMs` are the OBSERVED first and last row timestamps, not the
 * window that was requested. Derived-from-content is the honest choice: a
 * requested window can promise coverage the exchange did not actually return,
 * whereas the row bounds cannot. It also means scripts/rebuild-manifest.ts needs
 * no window-derivation logic of its own to reproduce these fields — it reads the
 * same two numbers straight out of the file.
 */
function writeFrozenFile(
  symbol: string,
  partition: string,
  kind: FrozenKind,
  rows: FrozenRow[],
): FrozenEntry {
  const file = frozenFileName(symbol, partition, kind);
  const gz = gzipSync(Buffer.from(JSON.stringify(rows), 'utf8'), { level: 9 });
  writeFileSync(join(OUT_DIR, file), gz);

  return {
    symbol,
    partition,
    kind,
    startMs: rows[0]![0],
    endMs: rows[rows.length - 1]![0],
    rows: rows.length,
    sha256: 'sha256:' + createHash('sha256').update(gz).digest('hex'),
    file,
    fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: kind === 'funding' ? FUNDING_SOURCE : CANDLE_SOURCE,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

/**
 * Read the entries of an existing manifest, or [] when there is none.
 *
 * Deliberately tolerant: a malformed manifest is treated as absent rather than
 * fatal, because the alternative is a prefetch that cannot be re-run to repair
 * a damaged manifest. The cost of tolerance is bounded — the worst case is that
 * this run's entries replace a file that was already on disk, and the file
 * itself is rewritten with a fresh hash either way.
 */
function readManifestEntries(path: string): FrozenEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (e): e is FrozenEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as FrozenEntry).symbol === 'string' &&
        typeof (e as FrozenEntry).partition === 'string' &&
        typeof (e as FrozenEntry).file === 'string',
    );
  } catch {
    return [];
  }
}

/** Identity of a manifest row. Kind is part of it: two files share a pair. */
function entryKey(e: { symbol: string; partition: string; kind?: FrozenKind }): string {
  return `${e.symbol}|${e.partition}|${e.kind === 'funding' ? 'funding' : 'candles'}`;
}

async function main(): Promise<void> {
  const raw = readFileSync(join(ROOT, 'config', 'partitions.json'), 'utf8');
  const partitionsCfg = JSON.parse(raw) as Record<string, { start: string; end: string }> & {
    symbols: { reference: string[]; targets: string[] };
  };

  const wantPartitions = (arg('partitions') ?? 'DISCOVERY,VALIDATION,LOCKED_TEST').split(',');
  const allSymbols = [
    ...(partitionsCfg.symbols?.reference ?? []),
    ...(partitionsCfg.symbols?.targets ?? []),
  ];
  const wantSymbols = (arg('symbols') ?? allSymbols.join(',')).split(',');
  const wantKinds = (arg('kinds') ?? 'candles,funding').split(',') as FrozenKind[];

  // Funding is fetched only for the reference coins, intersected with whatever
  // --symbols asked for, so a targeted run does not pull funding it will not use.
  const fundingCoins = (partitionsCfg.symbols?.reference ?? []).filter((c) =>
    wantSymbols.includes(c),
  );

  mkdirSync(OUT_DIR, { recursive: true });

  const entries: FrozenEntry[] = [];
  const problems: string[] = [];
  const startedAt = Date.now();

  for (const partition of wantPartitions) {
    const p = partitionsCfg[partition];
    if (!p || typeof p.start !== 'string') {
      console.error(`unknown partition: ${partition}`);
      problems.push(`unknown partition ${partition}`);
      continue;
    }
    const partitionStartMs = Date.parse(p.start);
    const partitionEndMs = Date.parse(p.end);
    const bounds = { startMs: partitionStartMs, endMs: partitionEndMs };

    console.log(`\n=== ${partition}  ${p.start} .. ${p.end} ===`);

    // --- candles ----------------------------------------------------------
    if (wantKinds.includes('candles')) {
      // WHICH SYMBOLS GET A LEAD-IN, AND WHY NOT ALL OF THEM
      //
      // A signal reads a REFERENCE coin through its own lookback window: a
      // 240-minute spot return needs BTC's price 241 minutes before the first
      // grid minute, which is before the partition start. So the reference
      // files carry the warm-up lead-in and those reads resolve from disk.
      //
      // A TARGET is read at exactly its partition bounds — the engine calls
      // fetchCandles(target, partitionStart, partitionEnd) — so a target file
      // needs no lead-in and gets none. Applying one anyway would be harmless
      // but would invalidate all 24 target files' hashes and force a full
      // re-fetch of the entire dataset for no gain.
      //
      // The asymmetry is therefore tied to how the protocol actually reads data,
      // not to convenience. If a future signal starts reading a target through a
      // lookback, that read would silently lose its first few observations —
      // visible as a changed n_obs, which is exactly what the frozen-vs-live
      // reproduction check in _dbgfrozen.mjs is there to catch.
      const reference = new Set(partitionsCfg.symbols?.reference ?? []);
      const refWin = freezeWindowFor('candles', bounds);
      console.log(
        `  candles: reference symbols (${[...reference].join(', ') || 'none'}) carry a ` +
          `${(bounds.startMs - refWin.startMs) / 60000 | 0}-minute warm-up lead-in; targets ` +
          `are frozen to the exact partition window`,
      );

      for (const symbol of wantSymbols) {
        const win = reference.has(symbol) ? refWin : bounds;
        const t0 = Date.now();
        process.stdout.write(`  ${symbol.padEnd(11)} `);
        const rows = await fetchWindow(symbol, win.startMs, win.endMs, (m) => console.log(`  ${m}`));
        if (rows.length === 0) {
          problems.push(`${symbol}/${partition}: candle fetch returned 0 rows; file NOT written`);
          console.log('     0 candles  — NOT written (empty)');
          continue;
        }
        entries.push(writeFrozenFile(symbol, partition, 'candles', rows));
        console.log(
          `${String(rows.length).padStart(6)} candles  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
        );
      }
    }

    // --- funding ----------------------------------------------------------
    if (wantKinds.includes('funding')) {
      const win = freezeWindowFor('funding', bounds);
      for (const coin of fundingCoins) {
        const t0 = Date.now();
        process.stdout.write(`  ${coin.padEnd(11)} funding `);
        let records: FrozenRow[];
        try {
          const fetched = await fetchFundingHistory(coin, win.startMs);
          // Clamp is what enforces the leak rule. The endpoint has no time
          // range — it always returns the newest settlements first — so without
          // this the file would carry settlements from VALIDATION and
          // LOCKED_TEST into a DISCOVERY-era file.
          records = clampRowsToFreezeWindow(
            fetched.map((r) => [r.fundingTime, r.fundingRate] as FrozenRow),
            win.startMs,
            win.endMs,
          );
        } catch (err) {
          problems.push(
            `${coin}/${partition}: funding fetch failed (${
              err instanceof Error ? err.message : String(err)
            }); file NOT written`,
          );
          console.log('     FAILED — NOT written');
          continue;
        }
        if (records.length === 0) {
          problems.push(`${coin}/${partition}: funding fetch returned 0 rows; file NOT written`);
          console.log('        0 settlements  — NOT written (empty)');
          continue;
        }
        entries.push(writeFrozenFile(coin, partition, 'funding', records));
        console.log(
          `${String(records.length).padStart(6)} settlements  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
        );
      }
    }
  }

  // MERGE into any existing manifest rather than replacing it.
  //
  // This is a bug fix, and the bug was real: a `--symbols ETHUSDT` run used to
  // write a manifest containing only the entries it had just fetched, dropping
  // the other 24 from the record while leaving their .gz files on disk. The
  // effect is quiet and nasty. loadFrozenManifest() no longer lists them, so
  // frozenEntryFor() returns null, so the backtest silently falls through to
  // fetching live data — and frozenDatasetHash() attests to a 3-file dataset
  // while 27 files sit on disk. Every verdict would carry a provenance hash
  // that describes almost none of the data behind it.
  //
  // The key includes `kind` for the same reason it includes the symbol: a
  // partial `--kinds funding` run must not drop the candle entries for the
  // coins it just touched.
  const manifestPath = join(OUT_DIR, 'manifest.json');
  const prior = readManifestEntries(manifestPath);

  const merged = new Map<string, FrozenEntry>();
  for (const e of prior) merged.set(entryKey(e), e);
  for (const e of entries) merged.set(entryKey(e), e);

  const all = [...merged.values()].sort(compareEntries);

  const manifest = {
    manifest_version: 'v1.0',
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    note:
      'Frozen series for every (symbol, partition, kind). CANDLES are 1-minute ' +
      'closes; FUNDING is 8-hourly settlements. Each file covers its partition ' +
      'plus a bounded warm-up lead-in of OLDER data and nothing after the ' +
      'partition end, so reading it cannot reach held-out data. The lead-in is ' +
      'what lets a signal warm up from the committed file instead of the ' +
      'network; see src/data/freezeWindow.ts. sha256 is of the compressed bytes ' +
      'as written. Entries are merged across runs, keyed on (symbol, partition, ' +
      'kind), so a partial --symbols or --kinds fetch never removes another ' +
      'entry from the record.',
    entries: all,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(
    `\nwrote ${entries.length} files to data/frozen/ in ` +
      `${((Date.now() - startedAt) / 60000).toFixed(1)} min`,
  );
  console.log(`manifest now lists ${all.length} (symbol, partition, kind) entries`);

  // Integrity guard: every .gz on disk must appear in the manifest. Without
  // this the failure above is invisible — the files look present, and only the
  // manifest disagrees.
  const orphans = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json.gz'))
    .filter((f) => !all.some((e) => e.file === f));
  if (orphans.length > 0) {
    problems.push(
      `${orphans.length} file(s) on disk are not in the manifest and will be ignored at ` +
        `runtime: ${orphans.join(', ')}`,
    );
  }

  if (problems.length > 0) {
    console.log(`\n${problems.length} PROBLEM(S):`);
    for (const pr of problems) console.log(`  - ${pr}`);
    process.exitCode = 1;
  } else {
    console.log('\nno problems: every file written is in the manifest, none were empty');
  }
}

/** Stable order: symbol, then partition, then kind (candles before funding). */
function compareEntries(a: FrozenEntry, b: FrozenEntry): number {
  if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
  if (a.partition !== b.partition) return a.partition.localeCompare(b.partition);
  return (a.kind ?? 'candles').localeCompare(b.kind ?? 'candles');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
