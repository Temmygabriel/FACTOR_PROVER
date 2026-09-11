/**
 * Signal computation, and the provenance the bundle reports about itself.
 *
 * The `sources` field exists because a verdict computed from the frozen store and
 * a verdict computed from a live fetch used to be indistinguishable once written
 * to the log — `dataset_sha256` would name a dataset that only partly backs the
 * numbers. Each leg resolves independently (the store is consulted per
 * coin/partition/kind), so the funding leg can come off disk while the spot leg
 * comes off the wire, and one label for the whole bundle would hide that split.
 * The reporting is not cosmetic, so it is tested directly rather than inferred
 * from whatever `points` an unlabelled bundle happens to return.
 *
 * Everything here is pure and offline: the step function, the percentile
 * rank and the spot-return series never touch the network, and the one live-fetch
 * path is served by a stubbed `fetch`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINUTE_MS } from '../src/data/freezeWindow.js';
import { partitionWindow } from '../src/config.js';
import { buildPriceSeries, type Candle } from '../src/backtest/data.js';
import {
  computeSignalBundle,
  fundingStepFunction,
  percentileRank,
  spotReturnSeries,
} from '../src/backtest/signals.js';
import type { FundingRecord } from '../src/data/fundingHistory.js';
import type { FactorHypothesis, SignalId } from '../src/types.js';
import { installFrozenFixtures, type InstalledFixtures } from './helpers/frozenStore.js';

const DISCOVERY = partitionWindow('DISCOVERY');
const EIGHT_HOURS = 8 * 60 * MINUTE_MS;
const BASE = DISCOVERY.startMs + 100 * MINUTE_MS;

let installed: InstalledFixtures | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  installed?.dispose();
  installed = null;
});

function candle(ts: number, close: number): Candle {
  return { ts, open: close, high: close, low: close, close, baseVolume: 1, quoteVolume: 1 };
}

function hypothesis(over: Partial<FactorHypothesis> = {}): FactorHypothesis {
  return {
    hypothesis_id: 'H-0001',
    session_id: 'S-test',
    proposed_at: '2026-09-11T00:00:00Z',
    signal: 'btc_funding_rate',
    condition: { operator: 'gt', threshold: 0.00005, lookback_minutes: 30 },
    target: 'RCOINUSDT',
    direction: 'positive',
    forward_return_minutes: 60,
    experiment_family: 'funding_to_rtoken',
    ...over,
  };
}

const record = (fundingTime: number, fundingRate: number): FundingRecord => ({
  fundingTime,
  fundingRate,
});

describe('fundingStepFunction', () => {
  it('holds the most recent settlement constant across the grid', () => {
    // Funding settles every 8 hours and holds in between. The value at any minute
    // is the last settlement at or before it — not an interpolation, which would
    // invent a rate the exchange never charged.
    const records = [record(0, 0.0001), record(8 * 60 * MINUTE_MS, 0.0002)];
    const grid = [0, MINUTE_MS, 7 * 60 * MINUTE_MS, 8 * 60 * MINUTE_MS, 9 * 60 * MINUTE_MS];
    expect(fundingStepFunction(records, grid)).toEqual([
      { ts: 0, value: 0.0001 },
      { ts: MINUTE_MS, value: 0.0001 },
      { ts: 7 * 60 * MINUTE_MS, value: 0.0001 },
      { ts: 8 * 60 * MINUTE_MS, value: 0.0002 },
      { ts: 9 * 60 * MINUTE_MS, value: 0.0002 },
    ]);
  });

  it('counts a settlement that lands exactly ON a grid timestamp', () => {
    // `<=`, not `<`. A settlement at the observation minute is the value in force
    // at that minute.
    expect(fundingStepFunction([record(MINUTE_MS, 0.5)], [MINUTE_MS])).toEqual([
      { ts: MINUTE_MS, value: 0.5 },
    ]);
  });

  it('omits grid timestamps BEFORE the first settlement', () => {
    // A minute with no funding rate in force yet has no value. Emitting a zero
    // would put a fabricated observation into the backtest.
    const out = fundingStepFunction([record(10 * MINUTE_MS, 0.0001)], [0, 10 * MINUTE_MS]);
    expect(out).toEqual([{ ts: 10 * MINUTE_MS, value: 0.0001 }]);
  });

  it('does not require the records to arrive sorted', () => {
    const out = fundingStepFunction([record(8 * 60 * MINUTE_MS, 2), record(0, 1)], [
      0,
      8 * 60 * MINUTE_MS,
    ]);
    expect(out.map((p) => p.value)).toEqual([1, 2]);
  });

  it('returns nothing for no records, rather than an empty-valued series', () => {
    // An empty array and "every point is zero" must not be the same answer: a
    // fabricated zero would enter the backtest as a real observation.
    expect(fundingStepFunction([], [0, MINUTE_MS])).toEqual([]);
  });

  it('returns nothing for an empty grid', () => {
    expect(fundingStepFunction([record(0, 1)], [])).toEqual([]);
  });

  it('does not mutate the caller’s array', () => {
    const records = [record(8 * 60 * MINUTE_MS, 2), record(0, 1)];
    fundingStepFunction(records, [0, 8 * 60 * MINUTE_MS]);
    expect(records[0]!.fundingRate).toBe(2);
  });
});

describe('percentileRank', () => {
  it('ranks by the fraction of the history at or below the value', () => {
    // `<=`, so ties count toward the rank. The max of a series is therefore
    // always 1.0 and the min is 1/n rather than 0.
    expect(percentileRank([1, 2, 3, 4], 2)).toBe(0.5);
    expect(percentileRank([1, 2, 3, 4], 4)).toBe(1);
    expect(percentileRank([1, 2, 3, 4], 0)).toBe(0);
    expect(percentileRank([1, 2, 3, 4], 1)).toBe(0.25);
  });

  it('returns 0 for an empty history rather than NaN', () => {
    // The market summary is JSON-serialized into the LLM context, and NaN does not
    // survive that round trip — it becomes null, or throws.
    expect(percentileRank([], 5)).toBe(0);
  });

  it('is monotone in the value', () => {
    const history = [3, 1, 4, 1, 5, 9, 2, 6];
    let prev = -1;
    for (const v of [-1, 0, 1, 2, 4, 6, 9, 10]) {
      const r = percentileRank(history, v);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
});

describe('spotReturnSeries', () => {
  // A minute grid of three prints: +10% then +10%.
  const series = buildPriceSeries('BTCUSDT', [
    candle(0, 100),
    candle(MINUTE_MS, 110),
    candle(2 * MINUTE_MS, 121),
  ]);

  it('computes percent change over the lookback on the grid', () => {
    const out = spotReturnSeries(series, [2 * MINUTE_MS], 2);
    expect(out).toHaveLength(1);
    expect(out[0]!.ts).toBe(2 * MINUTE_MS);
    expect(out[0]!.value).toBeCloseTo(21, 10);
  });

  it('returns PERCENT, not a fraction', () => {
    // The schema's spot thresholds (0.01 and up) are only meaningful in percent;
    // a fraction-returning series would make every spot threshold 100x too large
    // and select nothing.
    const out = spotReturnSeries(series, [MINUTE_MS], 1);
    expect(out[0]!.value).toBeCloseTo(10, 10);
  });

  it('skips a grid timestamp the series does not contain', () => {
    // The target trades on its own grid; a BTC print at a minute the target does
    // not have is not an observation.
    expect(spotReturnSeries(series, [MINUTE_MS + 30_000], 1)).toEqual([]);
  });

  it('skips a grid timestamp whose lookback point is missing', () => {
    expect(spotReturnSeries(series, [MINUTE_MS], 1 + 5)).toEqual([]);
  });

  it('skips a zero base price rather than returning Infinity', () => {
    const zeroed = buildPriceSeries('BTCUSDT', [candle(0, 0), candle(MINUTE_MS, 110)]);
    expect(spotReturnSeries(zeroed, [MINUTE_MS], 1)).toEqual([]);
  });

  it('OMITS a point whose lookback crosses a large hole — it does not return NaN', () => {
    // The doc comment on this function says it "returns NaN where the lookback
    // would cross a hole". It does not: it `continue`s, so the point is absent
    // from the array entirely. The distinction matters to the caller, because a
    // NaN would be counted and then dropped by the correlation as a missing pair,
    // while an absent point never becomes an observation at all. Pinned as
    // observed; the comment is the thing that is wrong.
    const holed = buildPriceSeries('BTCUSDT', [
      candle(0, 100),
      candle(10 * MINUTE_MS, 110), // 10-minute gap > MAX_FILL_MINUTES(5)
    ]);
    expect(spotReturnSeries(holed, [10 * MINUTE_MS], 5)).toEqual([]);
    // The far side of the hole is still reachable, though: a lookback that lands
    // on a real print returns a value computed across the gap.
    expect(spotReturnSeries(holed, [10 * MINUTE_MS], 10)[0]!.value).toBeCloseTo(10, 10);
  });

  it('carries a value across a SMALL hole, using the forward-filled price', () => {
    // Filling is what makes a window usable; `observed` is what keeps the fill
    // from being reported as a print. This is the intended behaviour, not a leak.
    const filled = buildPriceSeries('BTCUSDT', [candle(0, 100), candle(3 * MINUTE_MS, 130)]);
    const out = spotReturnSeries(filled, [3 * MINUTE_MS], 3);
    expect(out[0]!.value).toBeCloseTo(30, 10);
  });

  it('returns ascending points in grid order', () => {
    const out = spotReturnSeries(series, [MINUTE_MS, 2 * MINUTE_MS], 1);
    expect(out.map((p) => p.ts)).toEqual([MINUTE_MS, 2 * MINUTE_MS]);
  });
});

describe('computeSignalBundle with an empty grid', () => {
  // The empty grid is the only path that reaches the end of the function today,
  // so it is asserted for every signal kind rather than one.
  const SIGNALS: SignalId[] = [
    'btc_funding_rate',
    'eth_funding_rate',
    'btc_spot_return',
    'eth_spot_return',
    'btc_funding_x_spot',
  ];

  for (const signal of SIGNALS) {
    it(`returns an empty bundle for ${signal} without reading anything`, async () => {
      // No grid means no observations, so there is nothing to go and fetch — and
      // a bundle that reported 'frozen' here would be claiming provenance for data
      // it never read.
      const net = vi.fn(async () => {
        throw new Error('no read should happen for an empty grid');
      });
      vi.stubGlobal('fetch', net);

      const bundle = await computeSignalBundle({ hypothesis: hypothesis({ signal }), gridMs: [] });
      expect(bundle).toEqual({ points: [], spotLeg: null, sources: { signal: 'live', spot: null } });
      expect(net).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// The provenance the bundle reports about itself.
//
// Each leg resolves independently — the store is consulted per (coin, partition,
// kind) — so a combined signal can be half frozen and half live. That split is
// the reason the field exists and is asserted directly rather than inferred from
// the `points` an unlabelled bundle happens to return.
// ---------------------------------------------------------------------------
describe('sources — what the bundle reports about where its numbers came from', () => {
  const grid = [BASE, BASE + MINUTE_MS];

  it('reports the funding leg as FROZEN when the store holds it', async () => {
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'funding',
        rows: [[DISCOVERY.startMs - EIGHT_HOURS, 0.0001]],
      },
    ]);
    const net = vi.fn(async () => {
      throw new Error('the frozen store holds this; nothing should be fetched');
    });
    vi.stubGlobal('fetch', net);

    const bundle = await computeSignalBundle({
      hypothesis: hypothesis({ signal: 'btc_funding_rate' }),
      gridMs: grid,
      partition: 'DISCOVERY',
    });

    expect(bundle.sources).toEqual({ signal: 'frozen', spot: null });
    expect(bundle.points.map((p) => p.value)).toEqual([0.0001, 0.0001]);
    expect(net).not.toHaveBeenCalled();
  });

  it('reports the funding leg as LIVE when the store is empty', async () => {
    // The degraded path is real: an unfrozen coin still gets a verdict, and the
    // log has to say the numbers came off the wire.
    installed = installFrozenFixtures([]);
    // The wire carries STRINGS, keyed — not `[ts, rate]` tuples. A stub with the
    // wrong row shape produces `fundingTime: NaN`, which never satisfies the
    // pagination's `oldest <= earliestMs` stop, so it would page 30 times and
    // still return nothing. This shape is the contract.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: '00000',
          data: [
            {
              fundingTime: String(DISCOVERY.startMs - EIGHT_HOURS),
              fundingRate: '0.0002',
            },
          ],
        }),
      })),
    );

    const bundle = await computeSignalBundle({
      hypothesis: hypothesis({ signal: 'btc_funding_rate' }),
      gridMs: grid,
      partition: 'DISCOVERY',
    });

    expect(bundle.sources).toEqual({ signal: 'live', spot: null });
    expect(bundle.points.map((p) => p.value)).toEqual([0.0002, 0.0002]);
  });

  it('reports BOTH legs of a combined signal, and they can differ', async () => {
    // The partial-provenance case the field was added for: funding from disk,
    // spot off the wire. Reporting the bundle under one source would hide the
    // split, and the verdict's dataset_sha256 would name data that backs only
    // half of it.
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'funding',
        rows: [[DISCOVERY.startMs - EIGHT_HOURS, 0.0001]],
      },
    ]);
    // Only the spot leg fetches, and one chunk is enough: the walk stops as soon
    // as the chunk's oldest print reaches the requested start.
    const net = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        code: '00000',
        data: [
          [BASE - 31 * MINUTE_MS, '90', '90', '90', '90', '1', '1'],
          [BASE - 30 * MINUTE_MS, '100', '100', '100', '100', '1', '1'],
          [BASE, '110', '110', '110', '110', '1', '1'],
          [BASE + MINUTE_MS, '121', '121', '121', '121', '1', '1'],
        ],
      }),
    }));
    vi.stubGlobal('fetch', net);

    const bundle = await computeSignalBundle({
      hypothesis: hypothesis({
        signal: 'btc_funding_x_spot',
        experiment_family: 'combined_cross_asset',
      }),
      gridMs: grid,
      partition: 'DISCOVERY',
    });

    expect(bundle.sources).toEqual({ signal: 'frozen', spot: 'live' });
    expect(net).toHaveBeenCalled();
    // The first grid minute's lookback point is a real print 30 minutes back; the
    // second minute's would need one 29 minutes back, which is inside the gap, so
    // it is not an observation.
    expect(bundle.spotLeg).toEqual([{ ts: BASE, value: 10 }]);
  });

  it('reports the spot leg as FROZEN when the store holds the candles too', async () => {
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'funding',
        rows: [[DISCOVERY.startMs - EIGHT_HOURS, 0.0001]],
      },
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        // Must reach back over the 30-minute lookback from the first grid point.
        // The leading print is what makes the far side of that lookback a real
        // observation rather than a hole: a gap over MAX_FILL_MINUTES is left
        // empty, and `spotReturnSeries` skips any grid minute whose lookback point
        // it cannot find.
        rows: [
          [BASE - 31 * MINUTE_MS, 90],
          [BASE - 30 * MINUTE_MS, 100],
          [BASE, 110],
          [BASE + MINUTE_MS, 121],
        ],
      },
    ]);
    const net = vi.fn(async () => {
      throw new Error('both legs are frozen; nothing should be fetched');
    });
    vi.stubGlobal('fetch', net);

    const bundle = await computeSignalBundle({
      hypothesis: hypothesis({
        signal: 'btc_funding_x_spot',
        condition: { operator: 'gt', threshold: 0.00005, lookback_minutes: 30 },
      }),
      gridMs: grid,
      partition: 'DISCOVERY',
    });

    expect(bundle.sources).toEqual({ signal: 'frozen', spot: 'frozen' });
    expect(bundle.points.map((p) => p.value)).toEqual([0.0001, 0.0001]);
    // Only the first grid minute has a real 30-minute lookback point inside the
    // frozen file; the second's is absent, so it is not an observation.
    expect(bundle.spotLeg).toEqual([{ ts: BASE, value: 10 }]);
    expect(net).not.toHaveBeenCalled();
  });
});

describe('the partition gate applies to signal reads too', () => {
  it('refuses a grid outside the partition even when the store holds the data', async () => {
    // Provenance reporting must not become a way around the partition gate: a
    // frozen read of held-out minutes is still a read of held-out minutes.
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'funding',
        rows: [[DISCOVERY.startMs - EIGHT_HOURS, 0.0001]],
      },
    ]);
    await expect(
      computeSignalBundle({
        hypothesis: hypothesis({ signal: 'btc_funding_rate' }),
        gridMs: [DISCOVERY.endMs + MINUTE_MS],
        partition: 'DISCOVERY',
      }),
    ).rejects.toThrow(/falls outside the DISCOVERY partition/);
  });
});
