/**
 * The frozen partition store.
 *
 * WHY THIS EXISTS
 * ---------------
 * Bitget's public candle API is slow to page through at 1-minute granularity:
 * the deep-history endpoint caps at 200 rows per request, so one symbol's
 * DISCOVERY window costs ~330 requests and several minutes. Doing that at
 * application start-up is not viable, and doing it per hypothesis is absurd.
 *
 * The partitions are FROZEN — the whole protocol depends on that. So the data
 * inside them is frozen too. It is fetched once, written to disk, hashed, and
 * committed. Runtime reads a file.
 *
 * This is a strengthening, not a workaround. "We fetched live at run time" is
 * weak evidence of a preregistered protocol; "here is a committed dataset with
 * a sha256 recorded in every decision log entry" is strong evidence.
 *
 * TWO KINDS OF FILE
 * -----------------
 * A verdict rests on two series, and freezing only one of them is worse than
 * freezing neither, because the recorded `dataset_sha256` would then attest to
 * data that did not produce the number:
 *
 *   candles   `SYMBOL__PARTITION.json.gz`          [ts, close]
 *   funding   `SYMBOL__PARTITION.funding.json.gz`  [fundingTime, fundingRate]
 *
 * Funding was the later addition. Before it, the candle files were frozen while
 * every funding rate was still fetched live on each backtest — so the provenance
 * hash covered the price legs and silently missed the funding legs behind most
 * verdicts. Both kinds are now frozen, and `frozenDatasetHash` covers both.
 *
 * WINDOW RULE
 * -----------
 * Each file covers its partition plus a bounded LEAD-IN of older data, so that
 * a signal's warm-up reads come from the committed file rather than the
 * network. Nothing after the partition end is ever stored. See
 * src/data/freezeWindow.ts for why the two bounds are asymmetric.
 *
 * The window is enforced TWICE: once by what the freezer writes, and again here
 * on load. The load-time check is not redundant with the writer — it is the one
 * that survives a hand-edited file, and it is the check that would have caught
 * the live-fetch fallback this store was built to eliminate.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Candle } from '../backtest/data.js';
import { loadPartitions, type PartitionName } from '../config.js';
import type { FundingRecord } from './fundingHistory.js';
import { leadInForKind, type FrozenKind } from './freezeWindow.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolves from dist/data/ or src/data/ alike. */
export function frozenDir(): string {
  return join(HERE, '..', '..', 'data', 'frozen');
}

export interface FrozenEntry {
  symbol: string;
  partition: PartitionName;
  /**
   * Which series this file holds.
   *
   * Optional because entries written before funding was frozen do not carry it;
   * absent means 'candles'. Read it through `entryKind()`, never directly.
   */
  kind?: FrozenKind;
  /** Window the file covers, unix ms. For a lead-in'd file this predates the partition. */
  startMs: number;
  endMs: number;
  /** Number of rows stored. */
  rows: number;
  /** sha256 of the COMPRESSED file bytes, as committed. */
  sha256: string;
  file: string;
  fetched_at: string;
  source: string;
}

export interface FrozenManifest {
  manifest_version: string;
  generated_at: string;
  entries: FrozenEntry[];
}

/** [unixMs, value] — the only two fields the protocol needs. */
type FrozenRow = [number, number];

/** Absent `kind` means candles: the only kind that existed before this field. */
export function entryKind(e: FrozenEntry): FrozenKind {
  return e.kind === 'funding' ? 'funding' : 'candles';
}

let manifestCache: FrozenManifest | null = null;

export function loadFrozenManifest(): FrozenManifest | null {
  if (manifestCache) return manifestCache;
  const path = join(frozenDir(), 'manifest.json');
  if (!existsSync(path)) return null;
  manifestCache = JSON.parse(readFileSync(path, 'utf8')) as FrozenManifest;
  return manifestCache;
}

/** Test seam. */
export function __setFrozenManifestForTest(m: FrozenManifest | null): void {
  manifestCache = m;
}

export function frozenEntryFor(
  symbol: string,
  partition: PartitionName,
  kind: FrozenKind = 'candles',
): FrozenEntry | null {
  const m = loadFrozenManifest();
  if (!m) return null;
  return (
    m.entries.find(
      (e) => e.symbol === symbol && e.partition === partition && entryKind(e) === kind,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Load-time window enforcement
// ---------------------------------------------------------------------------

/**
 * Refuse to serve a file whose contents reach outside the window it may cover.
 *
 * Two distinct failures, reported separately because they mean different things:
 *
 *   - a row AFTER the partition end is held-out data. This is the failure that
 *     invalidates the protocol, so it is checked first and named as such.
 *   - a row before the permitted lead-in means the file's contents and the
 *     window rules disagree. Not a leak, but it means the freezer and the
 *     reader are working from different definitions, which is how the leak
 *     class of bug starts.
 */
function assertRowsWithinFreezeWindow(
  symbol: string,
  partition: PartitionName,
  kind: FrozenKind,
  rows: ReadonlyArray<readonly [number, number]>,
): void {
  const p = loadPartitions().data[partition];
  const partitionStartMs = Date.parse(p.start);
  const partitionEndMs = Date.parse(p.end);
  const leadInMs = leadInForKind(kind);
  const lowerBound = partitionStartMs - leadInMs;

  let afterEnd = 0;
  let beforeLeadIn = 0;
  let firstAfterEnd: number | null = null;

  for (const r of rows) {
    if (r[0] > partitionEndMs) {
      afterEnd++;
      if (firstAfterEnd === null) firstAfterEnd = r[0];
    } else if (r[0] < lowerBound) {
      beforeLeadIn++;
    }
  }

  if (afterEnd > 0) {
    throw new Error(
      `Frozen ${kind} file for ${symbol}/${partition} contains ${afterEnd} row(s) AFTER the ` +
        `partition end ${p.end} (first at ${new Date(firstAfterEnd!).toISOString()}). ` +
        `That is held-out data inside a DISCOVERY-era file; every result derived from ` +
        `this store is invalid until the file is rebuilt.`,
    );
  }
  if (beforeLeadIn > 0) {
    throw new Error(
      `Frozen ${kind} file for ${symbol}/${partition} contains ${beforeLeadIn} row(s) more than ` +
        `${leadInMs / 60_000} minute(s) before the partition start ${p.start}. The file exceeds ` +
        `its permitted warm-up lead-in, so its contents and the window rules disagree — ` +
        `rebuild it with scripts/prefetch.ts.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Candle files
// ---------------------------------------------------------------------------

export interface FrozenLoadResult {
  candles: Candle[];
  entry: FrozenEntry;
  /** sha256 of the compressed bytes, re-verified at load. */
  sha256: string;
}

/**
 * Decompressed series, keyed `kind|symbol|partition`.
 *
 * A DISCOVERY candle file holds ~75k rows for BTC and ~43k for an rToken.
 * Inflating and re-parsing that on every hypothesis would dominate the run, so
 * it is inflated once per process and reused. Funding files are three orders of
 * magnitude smaller but go through the same cache for the same reason: one
 * implementation, one place to get it right.
 */
const inflatedCache = new Map<string, unknown>();

/** Test seam. */
export function __clearFrozenCache(): void {
  inflatedCache.clear();
}

/**
 * Read and hash-verify a frozen file, returning its rows.
 *
 * Throws if the bytes on disk do not hash to what the manifest recorded. A
 * mismatch means the dataset was edited after it was frozen, which invalidates
 * every result derived from it — so this fails loudly rather than silently
 * returning tampered data.
 */
function loadRows(
  symbol: string,
  partition: PartitionName,
  kind: FrozenKind,
): { rows: FrozenRow[]; entry: FrozenEntry; sha256: string } | null {
  const entry = frozenEntryFor(symbol, partition, kind);
  if (!entry) return null;

  const path = join(frozenDir(), entry.file);
  if (!existsSync(path)) return null;

  const raw = readFileSync(path);
  const sha256 = 'sha256:' + createHash('sha256').update(raw).digest('hex');
  if (sha256 !== entry.sha256) {
    throw new Error(
      `Frozen dataset hash mismatch for ${symbol}/${partition} (${kind}). ` +
        `Manifest records ${entry.sha256} but the file hashes to ${sha256}. ` +
        `The dataset was modified after it was frozen; results from it are not ` +
        `comparable to the preregistration.`,
    );
  }

  const rows = JSON.parse(gunzipSync(raw).toString('utf8')) as FrozenRow[];
  if (!Array.isArray(rows)) {
    throw new Error(`Frozen file ${entry.file} does not contain an array of rows`);
  }
  assertRowsWithinFreezeWindow(symbol, partition, kind, rows);

  if (typeof entry.rows === 'number' && entry.rows !== rows.length) {
    throw new Error(
      `Frozen file ${entry.file} holds ${rows.length} rows but the manifest records ` +
        `${entry.rows}. The manifest and the file disagree; rebuild it with ` +
        `scripts/rebuild-manifest.ts.`,
    );
  }

  return { rows, entry, sha256 };
}

export function loadFrozenCandles(
  symbol: string,
  partition: PartitionName,
): FrozenLoadResult | null {
  const key = `candles|${symbol}|${partition}`;
  const cached = inflatedCache.get(key) as FrozenLoadResult | undefined;
  if (cached) return cached;

  const loaded = loadRows(symbol, partition, 'candles');
  if (!loaded) return null;

  const result: FrozenLoadResult = {
    candles: loaded.rows.map(([ts, close]) => ({
      ts,
      open: close,
      high: close,
      low: close,
      close,
      baseVolume: 0,
      quoteVolume: 0,
    })),
    entry: loaded.entry,
    sha256: loaded.sha256,
  };

  inflatedCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Funding files
// ---------------------------------------------------------------------------

export interface FrozenFundingResult {
  records: FundingRecord[];
  entry: FrozenEntry;
  sha256: string;
}

/**
 * Load a frozen funding series for a coin.
 *
 * Returns null when the pair was never frozen, which is the signal to fall back
 * to the live endpoint. That fallback is deliberate — the store should degrade,
 * not fail — but it is the path that makes `dataset_sha256` incomplete, so
 * `frozenCoverage()` below exists to report which series a session is actually
 * backed by rather than leaving it to be assumed.
 */
export function loadFrozenFunding(
  symbol: string,
  partition: PartitionName,
): FrozenFundingResult | null {
  const key = `funding|${symbol}|${partition}`;
  const cached = inflatedCache.get(key) as FrozenFundingResult | undefined;
  if (cached) return cached;

  const loaded = loadRows(symbol, partition, 'funding');
  if (!loaded) return null;

  const result: FrozenFundingResult = {
    records: loaded.rows.map(([fundingTime, fundingRate]) => ({ fundingTime, fundingRate })),
    entry: loaded.entry,
    sha256: loaded.sha256,
  };

  inflatedCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Dataset identity
// ---------------------------------------------------------------------------

/**
 * A single sha256 over every frozen entry, in a stable order.
 *
 * Recorded in each decision log entry as `dataset_sha256`, so any later edit to
 * any frozen partition file is detectable from the log alone.
 *
 * `kind` is part of the canonical string AND part of the sort key. Both matter:
 * two files can share a (symbol, partition) pair — BTCUSDT/DISCOVERY exists as
 * both candles and funding — and without the kind in the string the two would
 * produce identical lines, making the hash depend on which happened to sort
 * first rather than on what the files contain.
 */
export function frozenDatasetHash(): string | null {
  const m = loadFrozenManifest();
  if (!m || m.entries.length === 0) return null;

  const canonical = [...m.entries]
    .sort((a, b) => {
      if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
      if (a.partition !== b.partition) return a.partition.localeCompare(b.partition);
      return entryKind(a).localeCompare(entryKind(b));
    })
    .map((e) => `${e.symbol}|${e.partition}|${entryKind(e)}|${e.sha256}`)
    .join('\n');

  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface FrozenCoverage {
  /** Pairs present in the store, e.g. ['BTCUSDT|DISCOVERY|candles', ...]. */
  present: string[];
  /** Pairs a session needs but the store does not hold. */
  missing: string[];
  /** True when nothing is missing — the hash describes the whole session. */
  complete: boolean;
}

/**
 * Report whether the store covers the series a session will actually read.
 *
 * This is what turns "we have a dataset hash" into "the hash describes the data
 * behind these verdicts". A session that silently falls back to live funding
 * still writes a `dataset_sha256`; this is how the status endpoint can say the
 * provenance is partial instead of implying it is whole.
 */
export function frozenCoverage(params: {
  symbols: readonly string[];
  partitions: readonly PartitionName[];
}): FrozenCoverage {
  const present: string[] = [];
  const missing: string[] = [];

  for (const symbol of params.symbols) {
    for (const partition of params.partitions) {
      for (const kind of ['candles', 'funding'] as const) {
        const key = `${symbol}|${partition}|${kind}`;
        if (frozenEntryFor(symbol, partition, kind)) present.push(key);
        else missing.push(key);
      }
    }
  }

  return { present, missing, complete: missing.length === 0 };
}
