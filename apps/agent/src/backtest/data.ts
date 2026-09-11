/**
 * Bitget market data fetching, with partition enforcement and explicit gap policy.
 *
 * Three things here are load-bearing and must not be "simplified" later:
 *
 *  1. PARTITION ENFORCEMENT. Every candle request is checked against the frozen
 *     partition window before it leaves the process. The backtest can only ever
 *     read DISCOVERY data. This is what makes the held-out partitions real.
 *
 *  2. BACKWARD PAGINATION. The candles endpoint paginates BACKWARD from
 *     `endTime` and IGNORES `startTime`. Measured directly:
 *
 *       startTime=2026-06-15&endTime=2026-08-05&limit=1000
 *         -> the LAST 1000 minutes of the range (Aug 5 04:51 .. Aug 5 23:59)
 *       startTime=2026-06-15 only  (no endTime), limit=1000
 *         -> the most recent 1000 minutes overall (Sep 10), startTime ignored
 *       endTime=2026-07-01 only, limit=1000
 *         -> the 1000 minutes ending at Jul 1 (Jun 30 05:40 .. Jun 30 23:59)
 *
 *     So a single request over a 52-day window silently returns 16 hours of
 *     it. We walk BACKWARD: request with endTime=cursor, take the oldest row
 *     returned, then set cursor to that row minus one minute. See
 *     docs/DATA_FINDINGS.md section 7.
 *
 *  3. THE GAP POLICY. Measured on real RCOINUSDT data: the raw 1-minute series
 *     contains many small 1-5 minute holes. If a forward window required every
 *     single minute to be literally present, almost no observation would ever be
 *     valid and the engine would auto-KILL everything for insufficient_obs.
 *     So: gaps <= MAX_FILL_MINUTES are forward-filled and the observation stays
 *     valid; larger gaps break the window.
 */

import {
  assertWithinPartition,
  partitionWindow,
  type PartitionName,
  type Window,
} from '../config.js';
import { loadFrozenCandles } from '../data/frozen.js';

const BASE = 'https://api.bitget.com';
const MAX_CANDLES_PER_REQUEST = 1000;
const GRANULARITY_MS = 60_000;

/** Gaps at or below this are forward-filled. Above it, the window breaks. */
export const MAX_FILL_MINUTES = 5;

/** Pause between paginated requests. 80ms ~= 12 req/s, inside the public limit. */
const CHUNK_DELAY_MS = 80;

/**
 * Session-lifetime candle cache.
 *
 * Every hypothesis in a session backtests against the SAME frozen partition, so
 * without this a 50-hypothesis session would re-download ~40k candles per
 * hypothesis. Keyed on the exact window, so a request can only ever be served
 * data that was fetched for that identical window.
 */
const candleCache = new Map<string, Candle[]>();

/** Test seam — drops cached candles so a suite can re-measure fetches. */
export function __clearCandleCache(): void {
  candleCache.clear();
}

export interface Candle {
  /** Unix ms, bucket open time. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  quoteVolume: number;
}

export class BitgetError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BitgetError';
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch one chunk ENDING at `endMs`.
 *
 * `startTime` is deliberately not sent: it is ignored by this endpoint, and
 * omitting it keeps the request honest about what it actually does.
 *
 * Retries on 5xx and network errors with backoff — the free tier occasionally
 * returns 503, and the loop should ride that out rather than dying mid-session.
 */
async function requestChunk(
  symbol: string,
  endMs: number,
  attempts = 3,
): Promise<Candle[]> {
  const url =
    `${BASE}/api/v2/spot/market/candles?symbol=${encodeURIComponent(symbol)}` +
    `&granularity=1min&endTime=${endMs}&limit=${MAX_CANDLES_PER_REQUEST}`;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        if (res.status >= 500 && attempt < attempts) {
          await sleep(400 * attempt);
          continue;
        }
        throw new BitgetError(`Bitget returned HTTP ${res.status} for ${symbol}`, res.status);
      }
      const body = (await res.json()) as { code?: string; msg?: string; data?: string[][] };
      if (body.code && body.code !== '00000') {
        throw new BitgetError(`Bitget error ${body.code}: ${body.msg ?? 'unknown'}`, undefined);
      }
      const rows = body.data ?? [];
      return rows.map((r) => ({
        ts: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        baseVolume: Number(r[5]),
        quoteVolume: Number(r[6]),
      }));
    } catch (err) {
      lastErr = err;
      if (err instanceof BitgetError && err.status && err.status < 500) throw err;
      if (attempt < attempts) await sleep(400 * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new BitgetError('unknown fetch failure');
}

export interface FetchOptions {
  /** When set, the request is asserted to lie inside this partition. */
  partition?: PartitionName;
  /**
   * Warm-up the request may reach back BEFORE the partition start, in ms.
   *
   * Only meaningful with `partition`, and capped — see src/data/freezeWindow.ts
   * for why the start bound is relaxable and the end bound is not. Pass the
   * lead-in the frozen files actually carry (`CANDLE_LEAD_IN_MS`), so the
   * warm-up read is served from the committed dataset rather than the network.
   */
  warmupMs?: number;
  /** Bypass for the one manual LOCKED_TEST read. Never set this in loop code. */
  allowLockedTest?: boolean;
}

/**
 * Frozen candles clipped to a window, or null when the pair is not frozen.
 *
 * Exported because a caller sometimes needs to know WHICH source answered, not
 * just what the answer was. `fetchCandles` hides that deliberately — the whole
 * point of the store is that reading it is transparent — but the provenance
 * claim cannot be checked by a caller who cannot see it. So the lookup is its
 * own function, `fetchCandles` uses it, and a caller that needs the distinction
 * asks directly instead of inferring it from the manifest.
 *
 * THE WARM-UP RULE, AND WHY IT RETURNS NULL INSTEAD OF A SHORT ARRAY
 * -----------------------------------------------------------------
 * A request that reaches back before the partition start is asking for WARM-UP:
 * a spot return at the first grid minute needs a price from `lookback` minutes
 * earlier, which is before the partition began. Frozen files carry a lead-in so
 * those reads resolve from disk.
 *
 * When a file does NOT carry enough lead-in to serve such a request, the honest
 * answer is null — never a clipped array. A clipped array is the dangerous
 * outcome: it is a *valid-looking* candle list that is simply missing its first
 * few minutes, so `spotReturnSeries` silently drops the observations that
 * needed them and the backtest returns a different n_obs than the same
 * hypothesis measured against live data. Nothing errors. That is the silent
 * partial read this function exists to refuse.
 *
 * A shortfall at the start when the request is NOT reaching back for warm-up is
 * a different thing entirely: that is an ordinary data gap at the partition
 * boundary, the file is the best available answer, and it is returned as-is.
 */
export function frozenCandlesFor(
  symbol: string,
  partition: PartitionName,
  startMs: number,
  endMs: number,
): Candle[] | null {
  const frozen = loadFrozenCandles(symbol, partition);
  if (!frozen || frozen.candles.length === 0) return null;

  const { startMs: partitionStartMs } = partitionWindow(partition);
  const isWarmupRead = startMs < partitionStartMs;
  if (isWarmupRead && frozen.candles[0]!.ts > startMs) {
    // The file exists but cannot serve this read. Fall through so the caller
    // uses the live endpoint and reports 'live' — a visible provenance gap beats
    // an invisible numeric one.
    return null;
  }

  return frozen.candles.filter((c) => c.ts >= startMs && c.ts <= endMs);
}

/**
 * Fetch 1-minute candles for a symbol across a window, walking BACKWARD in
 * chunks from `endMs` and de-duplicating.
 *
 * Returned candles are clamped to [startMs, endMs] so a caller can never
 * receive a print from outside the requested window, whatever the API does.
 */
export async function fetchCandles(
  symbol: string,
  startMs: number,
  endMs: number,
  opts: FetchOptions = {},
): Promise<Candle[]> {
  if (endMs <= startMs) throw new BitgetError('endMs must be greater than startMs');

  if (opts.partition) {
    assertWithinPartition(opts.partition, { startMs, endMs }, opts.warmupMs ?? 0);
  }
  if (opts.partition === 'LOCKED_TEST' && !opts.allowLockedTest) {
    throw new BitgetError('LOCKED_TEST read requires explicit allowLockedTest');
  }

  const cacheKey = `${symbol}|${startMs}|${endMs}`;
  const hit = candleCache.get(cacheKey);
  if (hit) return hit;

  // Frozen store first. Partition data is committed and hashed, so this is both
  // instant and structurally safe: a DISCOVERY file contains only DISCOVERY
  // (plus a bounded warm-up lead-in of older data), so reading it cannot reach
  // held-out data. Falls through to the API when a (symbol, partition) pair has
  // not been frozen — a fallback that is visible to callers via
  // `frozenCandlesFor`, because it is the fallback that makes a session's
  // provenance partial.
  if (opts.partition) {
    const frozen = frozenCandlesFor(symbol, opts.partition, startMs, endMs);
    if (frozen) {
      candleCache.set(cacheKey, frozen);
      return frozen;
    }
  }

  const byTs = new Map<number, Candle>();
  let cursor = endMs;
  let guard = 0;

  for (;;) {
    if (++guard > 10_000) throw new BitgetError('pagination guard tripped — aborting');

    const chunk = await requestChunk(symbol, cursor);
    if (chunk.length === 0) break;

    chunk.sort((a, b) => a.ts - b.ts);
    for (const c of chunk) {
      if (c.ts >= startMs && c.ts <= endMs) byTs.set(c.ts, c);
    }

    const oldest = chunk[0]!.ts;
    // Reached the start of the requested window, or ran off the end of history.
    if (oldest <= startMs) break;
    if (chunk.length < MAX_CANDLES_PER_REQUEST) break;

    const next = oldest - GRANULARITY_MS;
    if (next >= cursor) break; // no forward progress; stop rather than spin
    cursor = next;

    await sleep(CHUNK_DELAY_MS); // stay well inside the public rate limit
  }

  const out = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  candleCache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// The stored series: prices plus an explicit validity mask.
// ---------------------------------------------------------------------------

export interface PriceSeries {
  symbol: string;
  /** Sorted unix ms. */
  ts: number[];
  /** Close price at each timestamp, forward-filled across small gaps. */
  close: number[];
  /**
   * True where the minute was forward-filled rather than observed, or where the
   * gap policy broke the series. Consumers must not span a `false`.
   */
  observed: boolean[];
  /** Index of the first real observation. */
  startMs: number;
  endMs: number;
}

/**
 * Turn a raw candle list into a price series with the gap policy applied.
 *
 * Forward-filling is recorded in `observed` so downstream code can tell a real
 * print from a carried-forward price. That distinction matters: filling makes a
 * window usable, but claiming filled minutes were observed would be dishonest.
 */
export function buildPriceSeries(symbol: string, candles: Candle[]): PriceSeries {
  if (candles.length === 0) {
    return { symbol, ts: [], close: [], observed: [], startMs: 0, endMs: 0 };
  }

  const sorted = [...candles].sort((a, b) => a.ts - b.ts);
  const ts: number[] = [];
  const close: number[] = [];
  const observed: boolean[] = [];

  let prevTs = sorted[0]!.ts;
  let prevClose = sorted[0]!.close;
  ts.push(prevTs);
  close.push(prevClose);
  observed.push(true);

  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i]!;
    const gapMinutes = Math.round((c.ts - prevTs) / GRANULARITY_MS);

    if (gapMinutes > 1) {
      if (gapMinutes - 1 <= MAX_FILL_MINUTES) {
        // Small hole: carry the last price forward, flagged as not observed.
        for (let k = 1; k < gapMinutes; k++) {
          ts.push(prevTs + k * GRANULARITY_MS);
          close.push(prevClose);
          observed.push(false);
        }
      } else {
        // Large hole: leave it empty. The window logic below will not cross it.
        ts.push(NaN);
        close.push(NaN);
        observed.push(false);
      }
    }

    ts.push(c.ts);
    close.push(c.close);
    observed.push(true);
    prevTs = c.ts;
    prevClose = c.close;
  }

  return { symbol, ts, close, observed, startMs: sorted[0]!.ts, endMs: sorted[sorted.length - 1]!.ts };
}

/** Index map for O(1) timestamp lookup. */
export function indexByTs(series: PriceSeries): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < series.ts.length; i++) {
    const t = series.ts[i]!;
    if (!Number.isNaN(t)) m.set(t, i);
  }
  return m;
}
