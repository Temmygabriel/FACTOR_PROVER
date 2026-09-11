/**
 * Signal computation.
 *
 * Each SignalId is turned into a time series on the target's minute grid. The
 * three signal kinds behave differently and are handled differently:
 *
 *  - FUNDING RATES settle every 8 hours and hold constant in between, so they
 *    are expanded into a step function over the minute grid.
 *  - SPOT RETURNS are computed from BTC/ETH 1-minute candles over the
 *    hypothesis's lookback.
 *  - COMBINED signals require two conditions at once. The schema carries only
 *    one operator/threshold pair, so the convention is: the threshold applies
 *    to the funding leg, and the spot leg must agree in sign with the
 *    hypothesis's `direction`. This is documented and disclosed rather than
 *    hidden.
 *
 * DESIGN DECISION — event study, not unconditional factor regression.
 * The hypothesis's `condition` SELECTS the observation set. Observations are
 * taken on a non-overlapping stride on the target's own timeline, the condition
 * is applied, and statistics are computed over the surviving events only. This
 * is what makes every schema field meaningful: `operator` and `threshold`
 * define the event, `direction` defines which way the bet is placed, and
 * `forward_return_minutes` defines the horizon. An unconditional regression
 * would make `operator`/`threshold` decorative.
 */

import { fetchCandles, buildPriceSeries, frozenCandlesFor, indexByTs, type PriceSeries } from './data.js';
import type { FactorHypothesis, SignalId } from '../types.js';
import { assertWithinPartition, type PartitionName, type Window } from '../config.js';
import { loadFrozenFunding } from '../data/frozen.js';
import { fetchFundingHistory, type FundingRecord } from '../data/fundingHistory.js';
import { CANDLE_LEAD_IN_MS, FUNDING_LEAD_IN_MS, MINUTE_MS } from '../data/freezeWindow.js';

export interface SignalPoint {
  /** Unix ms. */
  ts: number;
  value: number;
}

/**
 * Where a leg's data came from.
 *
 * Carried out of `computeSignalBundle` so the caller can tell whether a verdict
 * rests on the committed dataset or on a live fetch. Before this existed, a
 * missing or partial frozen store produced verdicts that looked identical to
 * fully-backed ones while the recorded `dataset_sha256` covered only part of
 * the data behind them.
 */
export type DataSource = 'frozen' | 'live';

/**
 * Funding settlements for a coin, from the frozen store when it holds them.
 *
 * The frozen branch ignores `earliestMs` deliberately: the file covers the
 * partition plus an 8-hour lead-in, which is a superset of anything the caller
 * would have asked for. Falling through to the live endpoint is the degraded
 * path, and it is reported rather than hidden.
 */
async function fundingRecordsFor(params: {
  coin: string;
  partition: PartitionName | undefined;
  earliestMs: number;
}): Promise<{ records: FundingRecord[]; source: DataSource }> {
  if (params.partition) {
    const frozen = loadFrozenFunding(params.coin, params.partition);
    if (frozen) return { records: frozen.records, source: 'frozen' };
  }
  return {
    records: await fetchFundingHistory(params.coin, params.earliestMs),
    source: 'live',
  };
}

/**
 * Candles for a reference coin, from the frozen store when it holds them.
 *
 * `warmupMs` lets the request reach back before the partition start for the
 * lookback window; the frozen files carry that lead-in, so the warm-up read is
 * served from disk instead of the network.
 */
async function referenceCandles(params: {
  coin: string;
  startMs: number;
  endMs: number;
  partition: PartitionName | undefined;
}): Promise<{ candles: Awaited<ReturnType<typeof fetchCandles>>; source: DataSource }> {
  if (params.partition) {
    const frozen = frozenCandlesFor(params.coin, params.partition, params.startMs, params.endMs);
    if (frozen) return { candles: frozen, source: 'frozen' };
  }
  return {
    candles: await fetchCandles(params.coin, params.startMs, params.endMs, {
      partition: params.partition,
      warmupMs: CANDLE_LEAD_IN_MS,
    }),
    source: 'live',
  };
}

/**
 * Expand 8-hourly settlements into a step function on a minute grid.
 * The rate at any minute is the most recent settlement's rate.
 */
export function fundingStepFunction(
  records: FundingRecord[],
  gridMs: readonly number[],
): SignalPoint[] {
  if (records.length === 0) return [];
  const sorted = [...records].sort((a, b) => a.fundingTime - b.fundingTime);
  const out: SignalPoint[] = [];
  let i = 0;
  let current: FundingRecord | null = null;

  for (const t of gridMs) {
    while (i < sorted.length && sorted[i]!.fundingTime <= t) {
      current = sorted[i]!;
      i++;
    }
    if (current) out.push({ ts: t, value: current.fundingRate });
  }
  return out;
}

/** Percentile rank of `value` within `history`. Used for the market summary. */
export function percentileRank(history: readonly number[], value: number): number {
  if (history.length === 0) return 0;
  let below = 0;
  for (const h of history) if (h <= value) below++;
  return below / history.length;
}

// ---------------------------------------------------------------------------
// Spot returns
// ---------------------------------------------------------------------------

/**
 * Percent change over `lookbackMinutes`, on the target grid.
 * Returns NaN where the lookback would cross a hole in the series.
 */
export function spotReturnSeries(
  series: PriceSeries,
  gridMs: readonly number[],
  lookbackMinutes: number,
): SignalPoint[] {
  const idx = indexByTs(series);
  const out: SignalPoint[] = [];

  for (const t of gridMs) {
    const i = idx.get(t);
    if (i === undefined) continue;
    const back = idx.get(t - lookbackMinutes * MINUTE_MS);
    if (back === undefined) continue;

    const now = series.close[i]!;
    const then = series.close[back]!;
    if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) continue;

    out.push({ ts: t, value: ((now - then) / then) * 100 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface SignalBundle {
  /** The signal value at each grid timestamp. */
  points: SignalPoint[];
  /** Extra leg for combined signals: spot return, aligned to the same grid. */
  spotLeg: SignalPoint[] | null;
  /**
   * Where each leg's data came from.
   *
   * `signal` covers the funding step function (or the spot return, for the
   * spot-return signals). `spot` is null when there is no second leg.
   */
  sources: { signal: DataSource; spot: DataSource | null };
}

export async function computeSignalBundle(params: {
  hypothesis: FactorHypothesis;
  /** Target timeline: the timestamps observations are taken at. */
  gridMs: readonly number[];
  partition?: PartitionName;
}): Promise<SignalBundle> {
  const { hypothesis, gridMs } = params;
  const signal: SignalId = hypothesis.signal;

  const window: Window = {
    startMs: Math.min(...gridMs, Date.now()),
    endMs: Math.max(...gridMs, 0),
  };
  if (params.partition && gridMs.length > 0) {
    assertWithinPartition(params.partition, { startMs: window.startMs, endMs: window.endMs });
  }
  if (gridMs.length === 0) {
    return { points: [], spotLeg: null, sources: { signal: 'live', spot: null } };
  }

  const earliest = window.startMs - FUNDING_LEAD_IN_MS;

  // --- funding legs -------------------------------------------------------
  if (signal === 'btc_funding_rate' || signal === 'eth_funding_rate') {
    const coin = signal.startsWith('btc') ? 'BTCUSDT' : 'ETHUSDT';
    const { records, source } = await fundingRecordsFor({
      coin,
      partition: params.partition,
      earliestMs: earliest,
    });
    return {
      points: fundingStepFunction(records, gridMs),
      spotLeg: null,
      sources: { signal: source, spot: null },
    };
  }

  // --- spot return legs ---------------------------------------------------
  if (signal === 'btc_spot_return' || signal === 'eth_spot_return') {
    const coin = signal.startsWith('btc') ? 'BTCUSDT' : 'ETHUSDT';
    const start = window.startMs - hypothesis.condition.lookback_minutes * MINUTE_MS - MINUTE_MS;
    const { candles, source } = await referenceCandles({
      coin,
      startMs: start,
      endMs: window.endMs,
      partition: params.partition,
    });
    const series = buildPriceSeries(coin, candles);
    return {
      points: spotReturnSeries(series, gridMs, hypothesis.condition.lookback_minutes),
      spotLeg: null,
      sources: { signal: source, spot: null },
    };
  }

  // --- combined -----------------------------------------------------------
  const { records, source: fundingSource } = await fundingRecordsFor({
    coin: 'BTCUSDT',
    partition: params.partition,
    earliestMs: earliest,
  });
  const funding = fundingStepFunction(records, gridMs);

  const spotStart = window.startMs - hypothesis.condition.lookback_minutes * MINUTE_MS - MINUTE_MS;
  const { candles: spotCandles, source: spotSource } = await referenceCandles({
    coin: 'BTCUSDT',
    startMs: spotStart,
    endMs: window.endMs,
    partition: params.partition,
  });
  const spotSeries = buildPriceSeries('BTCUSDT', spotCandles);
  const spotLeg = spotReturnSeries(spotSeries, gridMs, hypothesis.condition.lookback_minutes);

  return { points: funding, spotLeg, sources: { signal: fundingSource, spot: spotSource } };
}

export { fetchFundingHistory };
export type { FundingRecord };
