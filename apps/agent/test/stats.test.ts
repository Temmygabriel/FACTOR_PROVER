/**
 * The statistical core.
 *
 * These are the numbers the submission's central claim rests on, so they are
 * checked against values published elsewhere rather than against whatever this
 * implementation happens to produce. The t-table rows below are the standard
 * two-tailed critical values; a correct implementation returns the tail
 * probability named in the row.
 */

import { describe, expect, it } from 'vitest';
import {
  autocorrLag1,
  benjaminiHochberg,
  incompleteBeta,
  logGamma,
  pearson,
  studentTTwoTailedP,
  tStatFromR,
} from '../src/backtest/stats.js';

describe('pearson', () => {
  it('returns exactly 1 for a positive linear relationship and -1 for a negative one', () => {
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]).r).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]).r).toBeCloseTo(-1, 12);
  });

  it('matches a hand-computed correlation', () => {
    // r for xs=[1..6], ys=[2,4,5,8,9,12] is 0.99047800...
    expect(pearson([1, 2, 3, 4, 5, 6], [2, 4, 5, 8, 9, 12]).r).toBeCloseTo(0.9904780038426805, 10);
  });

  it('returns 0 when either side has zero variance', () => {
    // A constant signal cannot correlate with anything; returning NaN here
    // would propagate into t, p and the gate.
    expect(pearson([1, 2, 3, 4, 5], [7, 7, 7, 7, 7]).r).toBe(0);
    expect(pearson([3, 3, 3], [1, 2, 3]).r).toBe(0);
  });

  it('reports n as the shorter input length and refuses to correlate fewer than 3 points', () => {
    expect(pearson([1, 2, 3, 4, 5], [1, 2, 3]).n).toBe(3);
    expect(pearson([1, 2], [3, 4])).toEqual({ r: 0, n: 2 });
  });

  it('is symmetric', () => {
    const a = [0.3, -1.2, 4.4, 2.1, -0.5, 1.1];
    const b = [1.5, 0.2, -3.0, 2.2, 0.7, -1.4];
    expect(pearson(a, b).r).toBeCloseTo(pearson(b, a).r, 15);
  });
});

describe('autocorrLag1', () => {
  it('is 1 for a monotone series and 0 for one that is too short to say', () => {
    expect(autocorrLag1([1, 2, 3, 4, 5, 6, 7, 8])).toBeCloseTo(1, 10);
    expect(autocorrLag1([1, 2])).toBe(0);
  });

  it('is not a gate — it only has to be finite and disclosed', () => {
    expect(Number.isFinite(autocorrLag1([1, -1, 1, -1, 1, -1, 1, -1]))).toBe(true);
  });
});

describe('logGamma and incompleteBeta', () => {
  it('matches known log-gamma values', () => {
    expect(logGamma(1)).toBeCloseTo(0, 10);
    expect(logGamma(2)).toBeCloseTo(0, 10);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
  });

  it('I_x(1,1) is the identity on [0,1] and the boundary cases are exact', () => {
    expect(incompleteBeta(1, 1, 0.3)).toBeCloseTo(0.3, 12);
    expect(incompleteBeta(2, 3, 0)).toBe(0);
    expect(incompleteBeta(2, 3, 1)).toBe(1);
  });
});

describe('studentTTwoTailedP', () => {
  /**
   * Rows are the standard two-tailed t-table, to three decimal places.
   * Tolerance is 1e-2 because the published values are themselves rounded —
   * t = 2.228 at df = 10 corresponds to p = 0.050012, not exactly 0.05.
   */
  const TABLE: Array<{ t: number; df: number; p: number }> = [
    { t: 12.706, df: 1, p: 0.05 },
    { t: 4.303, df: 2, p: 0.05 },
    { t: 2.228, df: 10, p: 0.05 },
    { t: 2.06, df: 25, p: 0.05 },
    { t: 2.042, df: 30, p: 0.05 },
    { t: 1.984, df: 100, p: 0.05 },
    { t: 1.962, df: 1000, p: 0.05 },
    { t: 6.314, df: 1, p: 0.1 },
    { t: 1.812, df: 10, p: 0.1 },
    { t: 1.697, df: 30, p: 0.1 },
    { t: 1.66, df: 100, p: 0.1 },
    { t: 63.657, df: 1, p: 0.01 },
    { t: 3.169, df: 10, p: 0.01 },
    { t: 2.75, df: 30, p: 0.01 },
    { t: 2.626, df: 100, p: 0.01 },
  ];

  for (const row of TABLE) {
    it(`t=${row.t} at df=${row.df} gives p ~= ${row.p}`, () => {
      expect(studentTTwoTailedP(row.t, row.df)).toBeCloseTo(row.p, 2);
    });
  }

  it('is two-tailed, so the sign of t does not matter', () => {
    for (const t of [0.5, 1.5, 2.5, 5]) {
      expect(studentTTwoTailedP(-t, 17)).toBeCloseTo(studentTTwoTailedP(t, 17), 15);
    }
  });

  it('converges to the normal distribution for large df', () => {
    // 1.959964 is the familiar 5% normal critical value.
    expect(studentTTwoTailedP(1.959964, 10_000_000)).toBeCloseTo(0.05, 5);
    // At df=1 the t distribution is Cauchy, whose tails are far fatter.
    expect(studentTTwoTailedP(1.959964, 1)).toBeCloseTo(0.3, 2);
  });

  it('has the expected limits', () => {
    expect(studentTTwoTailedP(0, 10)).toBe(1);
    expect(studentTTwoTailedP(1, 1)).toBeCloseTo(0.5, 12); // Cauchy
    expect(studentTTwoTailedP(Infinity, 10)).toBe(0);
    expect(studentTTwoTailedP(5, 0)).toBe(1); // no observations -> no evidence
    expect(studentTTwoTailedP(NaN, 10)).toBe(1);
  });
});

describe('tStatFromR', () => {
  it('matches t = r * sqrt((n-2)/(1-r^2))', () => {
    expect(tStatFromR(0.5, 100)).toBeCloseTo(0.5 * Math.sqrt(98 / 0.75), 12);
    expect(tStatFromR(0.5, 100)).toBeCloseTo(5.71547606649408, 10);
    expect(tStatFromR(-0.5, 100)).toBeCloseTo(-5.71547606649408, 10);
  });

  it('returns 0 when there is nothing to test', () => {
    expect(tStatFromR(0, 100)).toBe(0);
    expect(tStatFromR(0.5, 2)).toBe(0); // df = 0
  });

  it('saturates rather than producing Infinity at |r| = 1', () => {
    // Infinity here would flow into the p-value and then into the log as the
    // string "Infinity"; a large finite sentinel keeps the record readable.
    expect(tStatFromR(1, 100)).toBe(1e6);
    expect(tStatFromR(-1, 100)).toBe(-1e6);
    expect(Number.isFinite(tStatFromR(0.999999, 100))).toBe(true);
  });
});

describe('benjaminiHochberg', () => {
  it('returns an empty result for an empty family', () => {
    expect(benjaminiHochberg([], 0.1)).toEqual({
      reject: [],
      thresholdAtRank: [],
      m: 0,
      kStar: 0,
      cutoff: 0,
    });
  });

  it('rejects nothing when even the smallest p-value misses its own bar', () => {
    const bh = benjaminiHochberg([0.2, 0.2, 0.2], 0.1);
    expect(bh.kStar).toBe(0);
    expect(bh.reject).toEqual([false, false, false]);
    expect(bh.cutoff).toBe(0);
  });

  it('rejects every hypothesis when even the largest p-value clears its own bar', () => {
    const bh = benjaminiHochberg([0.05, 0.05, 0.05], 0.1);
    expect(bh.kStar).toBe(3);
    expect(bh.reject).toEqual([true, true, true]);
    expect(bh.cutoff).toBeCloseTo(0.1, 12);
  });

  it('rejects a prefix of the rank order and nothing after it', () => {
    // Sorted: 0.001, 0.02, 0.5, 0.9 at thresholds 0.025, 0.05, 0.075, 0.10.
    // Ranks 1 and 2 clear; ranks 3 and 4 do not, so k* = 2.
    const bh = benjaminiHochberg([0.001, 0.02, 0.5, 0.9], 0.1);
    expect(bh.m).toBe(4);
    expect(bh.kStar).toBe(2);
    expect(bh.reject).toEqual([true, true, false, false]);
    expect(bh.cutoff).toBeCloseTo(0.05, 12);
  });

  it('reports the threshold each hypothesis faced at its OWN rank, in input order', () => {
    // Input is deliberately unsorted, so a result that indexes by sorted
    // position rather than by input position would come out visibly wrong.
    const bh = benjaminiHochberg([0.9, 0.001, 0.02], 0.1);
    expect(bh.reject).toEqual([false, true, true]);
    expect(bh.thresholdAtRank[1]).toBeCloseTo(1 / 3 * 0.1, 12);
    expect(bh.thresholdAtRank[2]).toBeCloseTo(2 / 3 * 0.1, 12);
    expect(bh.thresholdAtRank[0]).toBeCloseTo(0.1, 12);
  });

  it('is scale-free in q: doubling q cannot reject less', () => {
    const p = [0.004, 0.018, 0.041, 0.09, 0.4];
    const lo = benjaminiHochberg(p, 0.05);
    const hi = benjaminiHochberg(p, 0.1);
    for (let i = 0; i < p.length; i++) {
      if (lo.reject[i] === true) expect(hi.reject[i]).toBe(true);
    }
  });

  /**
   * THE CASE THE BUILD SPEC GETS WRONG.
   *
   * The spec's pseudocode decides each hypothesis independently at its own bar:
   *
   *     adjusted[idx] = (p <= (rank / m) * q)
   *
   * That is not the BH procedure. BH is a STEP-UP: find the LARGEST rank k with
   * p_(k) <= (k/m)*q, then reject every rank <= k. The two differ whenever a
   * p-value misses at its own rank but a LARGER p-value clears at a larger one,
   * which is routine with clustered p-values — and here it is the difference
   * between rejecting everything and rejecting only the worst hypothesis.
   *
   * The spec's version is incoherent in exactly this configuration: it rejects
   * 0.08 while ACCEPTING the two strictly better p-values, 0.06 and 0.07. A
   * procedure that calls the worst result significant and the better ones not
   * cannot be defended, so the standard step-up is what is implemented.
   */
  it('rejects a whole prefix, so it can never keep a better p-value while rejecting a worse one', () => {
    const bh = benjaminiHochberg([0.06, 0.07, 0.08], 0.1);

    // Step-up: rank 3 clears 0.10, so k* = 3 and the entire prefix is rejected.
    expect(bh.kStar).toBe(3);
    expect(bh.reject).toEqual([true, true, true]);

    // The spec's naive per-rank rule, for contrast. Reproduced here rather than
    // imported because it is the thing being refuted.
    const naive = [0.06, 0.07, 0.08].map((p, i) => p <= ((i + 1) / 3) * 0.1);
    expect(naive).toEqual([false, false, true]);

    // 0.08 is the WORST of the three, yet it is the only one the naive rule
    // rejects. That inversion is why the step-up is the implemented procedure.
    expect(naive[2]).toBe(true);
    expect(naive[0]).toBe(false);
  });

  it('is a superset of the naive per-rank rule: step-up never keeps what the naive rule rejects', () => {
    const families: number[][] = [
      [0.06, 0.07, 0.08],
      [0.05, 0.06, 0.08],
      [0.001, 0.02, 0.03, 0.5, 0.9],
      [0.02, 0.07],
      [0.011, 0.012, 0.013, 0.014, 0.015],
    ];
    for (const p of families) {
      const m = p.length;
      const bh = benjaminiHochberg(p, 0.1);
      const sorted = [...p].sort((a, b) => a - b);
      for (let rank = 1; rank <= m; rank++) {
        if (sorted[rank - 1]! <= (rank / m) * 0.1) {
          // Naive rejects this rank; BH must reject at least as much. Count how
          // many of the sorted prefix BH rejects.
          expect(bh.kStar).toBeGreaterThanOrEqual(rank);
        }
      }
    }
  });
});
