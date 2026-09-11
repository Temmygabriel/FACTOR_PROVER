/**
 * Backtest engine.
 *
 * Runs entirely inside the DISCOVERY partition. Reads candles, builds a
 * non-overlapping observation grid on the target's own timeline, evaluates the
 * hypothesis's condition, and computes IC / t-stat / p-value / hit-rate
 * against a naive baseline.
 *
 * Two invariants:
 *   - Non-overlapping stride. Consecutive observations never share return data.
 *   - Gap honesty. An observation whose forward window spans a hole larger than
 *     MAX_FILL_MINUTES is dropped, not interpolated across.
 */

import {
  buildPriceSeries,
  fetchCandles,
  indexByTs,
  MAX_FILL_MINUTES,
  type PriceSeries,
} from './data.js';
import { computeSignalBundle, type DataSource } from './signals.js';
import {
  autocorrLag1,
  pearson,
  studentTTwoTailedP,
  tStatFromR,
} from './stats.js';
import { loadGatePolicy, type PartitionName } from '../config.js';
import { COMBINED_SIGNALS, type BacktestResult, type FactorHypothesis, type Observation } from '../types.js';

const MINUTE_MS = 60_000;

export class BacktestTimeout extends Error {
  constructor(ms: number) {
    super(`backtest exceeded ${ms}ms budget`);
    this.name = 'BacktestTimeout';
  }
}

// ---------------------------------------------------------------------------
// Observation grid
// ---------------------------------------------------------------------------

/**
 * Choose non-overlapping timestamps on the target's timeline, spaced at least
 * `forwardMinutes` apart, where the entire forward window is valid under the
 * gap policy.
 */
export function buildObservationGrid(
  series: PriceSeries,
  forwardMinutes: number,
): number[] {
  const idx = indexByTs(series);
  const picked: number[] = [];
  const strideMs = forwardMinutes * MINUTE_MS;

  let lastPicked = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < series.ts.length; i++) {
    const t = series.ts[i]!;
    if (Number.isNaN(t)) continue;
    if (t - lastPicked < strideMs) continue;
    if (!isWindowValid(series, idx, t, forwardMinutes)) continue;

    picked.push(t);
    lastPicked = t;
  }
  return picked;
}

/**
 * Walk the forward window minute by minute. A missing minute is tolerated only
 * if the next available minute is within MAX_FILL_MINUTES; a larger hole
 * invalidates the window.
 */
function isWindowValid(
  series: PriceSeries,
  idx: Map<number, number>,
  startTs: number,
  forwardMinutes: number,
): boolean {
  if (!idx.has(startTs)) return false;
  if (!idx.has(startTs + forwardMinutes * MINUTE_MS)) return false;

  let cursor = startTs;
  let steps = 0;

  while (cursor < startTs + forwardMinutes * MINUTE_MS) {
    if (++steps > forwardMinutes + 64) return false;
    const next = cursor + MINUTE_MS;
    if (idx.has(next)) {
      cursor = next;
      continue;
    }
    // hole — find the next real minute
    const i = idx.get(cursor);
    if (i === undefined) return false;
    let j = i + 1;
    let found: number | null = null;
    while (j < series.ts.length) {
      const cand = series.ts[j]!;
      if (Number.isNaN(cand)) return false; // hard break marker
      if ((cand - cursor) / MINUTE_MS > MAX_FILL_MINUTES) return false;
      found = cand;
      break;
    }
    if (found === null) return false;
    cursor = found;
  }
  return true;
}

/** Percent forward return from `startTs` to `startTs + forwardMinutes`. */
function forwardReturn(
  series: PriceSeries,
  idx: Map<number, number>,
  startTs: number,
  forwardMinutes: number,
): number | null {
  const i = idx.get(startTs);
  const j = idx.get(startTs + forwardMinutes * MINUTE_MS);
  if (i === undefined || j === undefined) return null;
  const a = series.close[i]!;
  const b = series.close[j]!;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / a) * 100;
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

export function conditionHolds(
  hypothesis: FactorHypothesis,
  signalValue: number,
  spotValue: number | null,
): boolean {
  const { operator, threshold } = hypothesis.condition;

  const base = (() => {
    switch (operator) {
      case 'gt':
      case 'pct_change_gt':
        return signalValue > threshold;
      case 'gte':
        return signalValue >= threshold;
      case 'lt':
      case 'pct_change_lt':
        return signalValue < threshold;
      case 'lte':
        return signalValue <= threshold;
      default:
        return false;
    }
  })();

  if (!base) return false;

  // Combined signals need the spot leg to agree in sign with the claim.
  if (COMBINED_SIGNALS.includes(hypothesis.signal)) {
    // A MISSING leg is not a pass. This is the load-bearing line in this
    // function, so here is the evidence for it.
    //
    // `bundle.spotLeg` is an array, and an empty array is truthy, so a spot leg
    // that failed to build still produced a `spotByTs` map containing nothing.
    // `spotByTs.get(t) ?? null` then yielded null, and the check below — which
    // previously read `if (spotValue !== null)` — simply did not run. The
    // hypothesis silently degraded into its funding leg ALONE and reported the
    // result as though both conditions had been tested.
    //
    // Measured, not imagined: with the spot leg absent, `btc_funding_x_spot gt
    // 0.00005 -> RQQQUSDT 60m` selected 352 of 864 grid points — exactly the
    // count the funding condition selects on its own. With the leg present the
    // sign filter halves that to 167. The half-condition figure (IC -0.0035,
    // p 0.948) looked like an ordinary null result and was recorded as one.
    //
    // Returning false here means the observation is dropped, so a combined
    // hypothesis with an unmeasurable spot leg ends at n_obs = 0 and an honest
    // `insufficient_obs` KILL instead of a confident number about half a claim.
    if (spotValue === null) return false;
    const wantPositive = hypothesis.direction === 'positive';
    const spotPositive = spotValue > 0;
    if (spotPositive !== wantPositive) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface RunBacktestOptions {
  hypothesis: FactorHypothesis;
  /** Which partition to read. The loop only ever passes DISCOVERY. */
  partition: PartitionName;
  /** Manual override for the single out-of-sample demo pass. */
  allowLockedTest?: boolean;
}

export interface BacktestOutcome {
  result: BacktestResult;
  observations: Observation[];
  /** True when the run was cut short by the time budget. */
  timedOut: boolean;
  /** Grid size before the condition filter was applied. */
  gridSize: number;
  /**
   * Which source served each signal leg — 'live' means the frozen store did not
   * cover it.
   *
   * Reported on every outcome, including the KILL paths, because provenance is
   * a property of the RUN rather than of the verdict. A run that fell back to
   * the live endpoint produced a number the committed `dataset_sha256` does not
   * describe, and that is true whether the number went on to pass the gate or
   * fail it. Hiding it on the killed path would mean the only runs whose
   * provenance anyone could check are the ones that succeeded.
   */
  signalSources: { signal: DataSource; spot: DataSource | null };
}

export async function runBacktest(opts: RunBacktestOptions): Promise<BacktestOutcome> {
  const policy = loadGatePolicy().data;
  const budgetMs = policy.circuit_breaker.max_backtest_duration_ms;

  const { hypothesis } = opts;
  const fwd = hypothesis.forward_return_minutes;

  // --- Phase 1: data acquisition ------------------------------------------
  //
  // Deliberately OUTSIDE the time budget. These are network calls against a
  // free public API and are cached for the life of the session, so their
  // latency says nothing about the hypothesis. Budgeting them would kill
  // hypotheses for being proposed at a moment when Bitget was slow — a KILL
  // must be a statement about the idea, never about the weather.
  //
  // The budget below covers Phase 2, which is pure computation: the part a
  // malformed hypothesis could actually make run away.
  const { partitionWindow } = await import('../config.js');
  const win = partitionWindow(opts.partition);
  const candles = await fetchCandles(hypothesis.target, win.startMs, win.endMs, {
    partition: opts.partition,
    allowLockedTest: opts.allowLockedTest,
  });
  const series = buildPriceSeries(hypothesis.target, candles);
  const idx = indexByTs(series);

  const grid = buildObservationGrid(series, fwd);

  const bundle = await computeSignalBundle({
    hypothesis,
    gridMs: grid,
    partition: opts.partition,
  });
  const signalByTs = new Map(bundle.points.map((p) => [p.ts, p.value]));
  const spotByTs = new Map((bundle.spotLeg ?? []).map((p) => [p.ts, p.value]));
  const signalSources = bundle.sources;

  // --- Phase 2: adjudication (budgeted) -----------------------------------
  const startedAt = Date.now();

  const observations: Observation[] = [];
  const baselineSignals: number[] = [];

  for (const t of grid) {
    if (Date.now() - startedAt > budgetMs) {
      return {
        result: emptyResult(),
        observations,
        timedOut: true,
        gridSize: grid.length,
        signalSources,
      };
    }

    const sv = signalByTs.get(t);
    if (sv === undefined || !Number.isFinite(sv)) continue;

    // The spot leg is consulted only for combined signals; when it is required
    // and missing, `conditionHolds` returns false and the observation is
    // dropped. The rule lives in the predicate so there is one place to read it.
    const spot = spotByTs.get(t) ?? null;
    if (!conditionHolds(hypothesis, sv, spot)) continue;

    const ret = forwardReturn(series, idx, t, fwd);
    if (ret === null) continue;

    observations.push({ timestamp: t, signal_value: sv, target_return: ret });

    // Naive baseline: the target's own trailing return over the same lookback.
    const base = trailingReturn(series, idx, t, hypothesis.condition.lookback_minutes);
    if (base !== null) baselineSignals.push(base);
  }

  // --- Phase 2b: statistics over surviving events only.
  const minObs = policy.min_obs;
  if (observations.length < minObs) {
    return {
      result: {
        ...emptyResult(),
        n_obs: observations.length,
      },
      observations,
      timedOut: false,
      gridSize: grid.length,
      signalSources,
    };
  }

  const xs = observations.map((o) => o.signal_value);
  const ys = observations.map((o) => o.target_return);

  const { r } = pearson(xs, ys);
  const n = observations.length;
  const t = tStatFromR(r, n);
  const p = studentTTwoTailedP(t, n - 2);

  const wantPositive = hypothesis.direction === 'positive';
  let hits = 0;
  for (const y of ys) {
    if ((y > 0) === wantPositive && y !== 0) hits++;
  }

  // Baseline IC on the same event set (only where the trailing return exists).
  const usableForBaseline = Math.min(baselineSignals.length, ys.length);
  const baselineIc =
    usableForBaseline >= 3
      ? pearson(baselineSignals.slice(0, usableForBaseline), ys.slice(0, usableForBaseline)).r
      : 0;

  return {
    result: {
      ic: r,
      t_stat: t,
      p_value: p,
      hit_rate: hits / n,
      n_obs: n,
      baseline_ic: baselineIc,
      signal_autocorr_lag1: autocorrLag1(xs),
    },
    observations,
    timedOut: false,
    gridSize: grid.length,
    signalSources,
  };
}

function trailingReturn(
  series: PriceSeries,
  idx: Map<number, number>,
  t: number,
  lookbackMinutes: number,
): number | null {
  const i = idx.get(t);
  const j = idx.get(t - lookbackMinutes * MINUTE_MS);
  if (i === undefined || j === undefined) return null;
  const a = series.close[j]!;
  const b = series.close[i]!;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / a) * 100;
}

function emptyResult(): BacktestResult {
  return {
    ic: 0,
    t_stat: 0,
    p_value: 1,
    hit_rate: 0,
    n_obs: 0,
    baseline_ic: 0,
    signal_autocorr_lag1: 0,
  };
}
