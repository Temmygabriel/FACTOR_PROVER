/**
 * The deterministic gate.
 *
 * Two properties carry the weight here:
 *
 *  1. THE FLOORS ARE MAGNITUDE-BASED. A strongly NEGATIVE IC clears `min_ic`
 *     exactly as a positive one does — direction is the hypothesis's claim, and
 *     the floors ask only whether there is a detectable relationship at all.
 *  2. BH IS FAMILY-WIDE AND THEREFORE NOT FINAL. The same candidate with the
 *     same p-value is PROMOTED in a five-hypothesis session and KILLED in a
 *     two-hundred-hypothesis one. That is what FDR control means, and it is the
 *     single most important behaviour in the file: a gate that decided once and
 *     never revisited would be reporting a correction it had not applied.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_KILL_PRECEDENCE, adjudicateHypothesis } from '../src/gate/gate.js';
import { loadGatePolicy, type GatePolicy } from '../src/config.js';
import type { BacktestResult, FactorHypothesis, KillReason } from '../src/types.js';

const POLICY = loadGatePolicy().data;

/** A backtest that clears every check, so a case only names what it breaks. */
function bt(over: Partial<BacktestResult> = {}): BacktestResult {
  return {
    ic: 0.2,
    t_stat: 5,
    p_value: 0.001,
    hit_rate: 0.6,
    n_obs: 500,
    baseline_ic: 0.05,
    signal_autocorr_lag1: 0.1,
    ...over,
  };
}

const HYPOTHESIS: FactorHypothesis = {
  hypothesis_id: 'H-0001',
  session_id: 'S-test',
  proposed_at: '2026-09-11T00:00:00Z',
  signal: 'btc_funding_rate',
  condition: { operator: 'gt', threshold: 0.00005, lookback_minutes: 60 },
  target: 'RCOINUSDT',
  direction: 'positive',
  forward_return_minutes: 60,
  experiment_family: 'funding_to_rtoken',
};

function adjudicate(
  backtest: BacktestResult,
  sessionPValues: number[] = [backtest.p_value],
  selfIndex = 0,
  policy: GatePolicy = POLICY,
) {
  return adjudicateHypothesis({ hypothesis: HYPOTHESIS, backtest, selfIndex, sessionPValues, policy });
}

describe('the preregistered thresholds', () => {
  it('are read from gate_policy.json rather than restated here', () => {
    expect(POLICY.fdr_level).toBe(0.1);
    expect(POLICY.min_ic).toBe(0.04);
    expect(POLICY.min_t_stat).toBe(2.0);
    expect(POLICY.min_obs).toBe(100);
    expect(POLICY.require_baseline_beat).toBe(true);
    expect(POLICY.multiple_testing_scope).toBe('family_wide');
  });

  it('names the kill precedence, and the code default matches the file', () => {
    // The two copies exist on purpose — the code default is what runs when the
    // preregistered order is missing or malformed — so they must agree, or a
    // policy edit silently changes which reason gets reported.
    expect(POLICY.kill_reason_precedence).toEqual([...DEFAULT_KILL_PRECEDENCE]);
  });
});

describe('a candidate that clears everything', () => {
  it('is PROMOTED with no reason', () => {
    const { decision } = adjudicate(bt());
    expect(decision.decision).toBe('PROMOTE');
    expect(decision.reason).toBeNull();
    expect(decision.checks).toEqual({
      passed_min_obs: true,
      passed_ic_floor: true,
      passed_t_stat_floor: true,
      passed_baseline_beat: true,
      passed_bh: true,
    });
  });

  it('reports the bar it had to clear at its own rank', () => {
    // Shown even on a pass, so the record says what the hypothesis faced rather
    // than only that it survived.
    const { decision, rank } = adjudicate(bt(), [0.001, 0.2, 0.4]);
    expect(rank).toBe(1);
    expect(decision.bh_adjusted_threshold).toBeCloseTo((1 / 3) * 0.1, 12);
  });

  it('says in the detail that a pass is survivorship, not profitability', () => {
    // The one piece of copy that stops a PROMOTE being read as a trading signal.
    const { decision } = adjudicate(bt());
    expect(decision.detail).toMatch(/survivorship result under FDR control/);
    expect(decision.detail).toMatch(/not a claim of profitability/);
  });
});

describe('every kill reason, in `kill_reason_precedence` order', () => {
  const CASES: Array<{ reason: KillReason; backtest: BacktestResult; pValues: number[] }> = [
    { reason: 'insufficient_obs', backtest: bt({ n_obs: POLICY.min_obs - 1 }), pValues: [0.001] },
    { reason: 'ic_below_floor', backtest: bt({ ic: POLICY.min_ic - 0.001 }), pValues: [0.001] },
    {
      reason: 't_stat_below_floor',
      backtest: bt({ t_stat: POLICY.min_t_stat - 0.1 }),
      pValues: [0.001],
    },
    { reason: 'baseline_not_beaten', backtest: bt({ baseline_ic: 0.9 }), pValues: [0.001] },
    { reason: 'p_value_exceeds_bh_threshold', backtest: bt({ p_value: 0.5 }), pValues: [0.5] },
  ];

  for (const c of CASES) {
    it(`reports ${c.reason}`, () => {
      const { decision } = adjudicate(c.backtest, c.pValues);
      expect(decision.decision).toBe('KILL');
      expect(decision.reason).toBe(c.reason);
      expect(decision.raw_p_value).toBe(c.backtest.p_value);
    });
  }

  it('covers exactly the five checks the gate performs — no more, no fewer', () => {
    // If a sixth check is ever added without a precedence entry, the loop below
    // is where the omission becomes visible.
    const named = new Set<string>(DEFAULT_KILL_PRECEDENCE);
    for (const c of CASES) expect(named.has(c.reason)).toBe(true);
    expect(named.size).toBe(5);
  });
});

describe('when several checks fail, the FIRST in the preregistered order is named', () => {
  it('prefers insufficient_obs over everything downstream', () => {
    // "The data cannot test this idea" is a different statement from "the idea
    // failed", and it takes priority: a 3-observation sample says nothing about
    // the signal, whatever its IC happens to be.
    const { decision } = adjudicate(
      bt({ n_obs: 3, ic: 0, t_stat: 0, baseline_ic: 0.9, p_value: 0.9 }),
      [0.9],
    );
    expect(decision.reason).toBe('insufficient_obs');
  });

  it('prefers ic_below_floor over the three checks after it', () => {
    const { decision } = adjudicate(
      bt({ ic: 0.001, t_stat: 0.1, baseline_ic: 0.9, p_value: 0.9 }),
      [0.9],
    );
    expect(decision.reason).toBe('ic_below_floor');
  });

  it('prefers t_stat_below_floor over baseline and BH', () => {
    const { decision } = adjudicate(
      bt({ ic: 0.05, t_stat: 0.1, baseline_ic: 0.9, p_value: 0.9 }),
      [0.9],
    );
    expect(decision.reason).toBe('t_stat_below_floor');
  });

  it('prefers baseline_not_beaten over BH', () => {
    const { decision } = adjudicate(bt({ ic: 0.05, t_stat: 5, baseline_ic: 0.9, p_value: 0.9 }), [
      0.9,
    ]);
    expect(decision.reason).toBe('baseline_not_beaten');
  });

  it('still records EVERY check that failed, not only the named one', () => {
    // The named reason is the headline; the checks block is the full evidence. A
    // reader must be able to see that the sample was too small AND that the IC
    // was weak AND that BH rejected it, not just the first of those.
    const { decision } = adjudicate(
      bt({ n_obs: 3, ic: 0, t_stat: 0, baseline_ic: 0.9, p_value: 0.9 }),
      [0.9],
    );
    expect(decision.checks).toEqual({
      passed_min_obs: false,
      passed_ic_floor: false,
      passed_t_stat_floor: false,
      passed_baseline_beat: false,
      passed_bh: false,
    });
  });

  it('follows a re-ordered precedence from the policy when one is supplied', () => {
    // The order is preregistered DATA, not code. Reversing it must change which
    // reason is reported for the same failing candidate.
    const reversed: GatePolicy = {
      ...POLICY,
      kill_reason_precedence: [...DEFAULT_KILL_PRECEDENCE].reverse(),
    };
    const { decision } = adjudicate(
      bt({ n_obs: 3, ic: 0, t_stat: 0, baseline_ic: 0.9, p_value: 0.9 }),
      [0.9],
      0,
      reversed,
    );
    expect(decision.reason).toBe('p_value_exceeds_bh_threshold');
  });

  it('falls back to the code default when the policy has no precedence list', () => {
    const stripped = { ...POLICY } as GatePolicy;
    delete (stripped as Record<string, unknown>)['kill_reason_precedence'];
    const { decision } = adjudicate(bt({ n_obs: 3, ic: 0 }), [0.001], 0, stripped);
    expect(decision.reason).toBe('insufficient_obs');
  });

  it('still kills on a failed check the precedence list forgot to name', () => {
    // A policy edit that omits a reason must not silently promote. The fallback
    // scan exists for exactly that, and this is the test that holds it.
    const partial = { ...POLICY, kill_reason_precedence: ['insufficient_obs'] } as GatePolicy;
    const { decision } = adjudicate(bt({ ic: POLICY.min_ic - 0.001 }), [0.001], 0, partial);
    expect(decision.decision).toBe('KILL');
    expect(decision.reason).toBe('ic_below_floor');
  });
});

describe('the floors are MAGNITUDE-based', () => {
  it('lets a strongly NEGATIVE IC clear min_ic', () => {
    // The floors ask whether there is a detectable relationship, not which way
    // it points. Direction is the hypothesis's own claim, tested separately.
    const { decision } = adjudicate(bt({ ic: -0.5, t_stat: -8 }));
    expect(decision.decision).toBe('PROMOTE');
    expect(decision.checks.passed_ic_floor).toBe(true);
    expect(decision.checks.passed_t_stat_floor).toBe(true);
  });

  it('measures the baseline comparison on magnitude too', () => {
    // A large negative baseline must NOT be beaten by a small positive IC, and a
    // large negative IC must beat a small positive baseline.
    const { decision: lose } = adjudicate(bt({ ic: 0.05, baseline_ic: -0.5 }));
    expect(lose.reason).toBe('baseline_not_beaten');

    const { decision: win } = adjudicate(bt({ ic: -0.5, baseline_ic: 0.05 }));
    expect(win.decision).toBe('PROMOTE');
  });

  it('refuses a tie with the baseline, because the claim is that the signal ADDS', () => {
    const { decision } = adjudicate(bt({ ic: 0.2, baseline_ic: 0.2 }));
    expect(decision.reason).toBe('baseline_not_beaten');
  });

  it('treats min_obs as a floor on the count, inclusive', () => {
    expect(adjudicate(bt({ n_obs: POLICY.min_obs })).decision.checks.passed_min_obs).toBe(true);
    expect(adjudicate(bt({ n_obs: POLICY.min_obs - 1 })).decision.checks.passed_min_obs).toBe(false);
  });

  it('treats the floors as inclusive at the boundary', () => {
    // Exactly at the floor clears. The alternative would make the preregistered
    // number a number the gate refuses to honour.
    expect(adjudicate(bt({ ic: POLICY.min_ic })).decision.checks.passed_ic_floor).toBe(true);
    expect(adjudicate(bt({ t_stat: POLICY.min_t_stat })).decision.checks.passed_t_stat_floor).toBe(true);
  });

  it('skips the baseline check entirely when the policy does not require it', () => {
    const lax = { ...POLICY, require_baseline_beat: false } as GatePolicy;
    const { decision } = adjudicate(bt({ ic: 0.05, baseline_ic: 0.9, t_stat: 5 }), [0.001], 0, lax);
    expect(decision.checks.passed_baseline_beat).toBe(true);
    expect(decision.decision).toBe('PROMOTE');
  });
});

describe('BH IS FAMILY-WIDE, SO THE SAME CANDIDATE IS PROMOTED AND THEN KILLED', () => {
  /**
   * One candidate, one p-value, four family sizes. Nothing about the candidate
   * changes; only the number of hypotheses attempted alongside it does, and that
   * is enough to flip the verdict.
   *
   * The mechanism: BH's bar at rank 1 is q/m. At p = 0.001 that bar is cleared
   * while m <= 100 and missed once m = 200. The candidate never gets worse — the
   * session just tried more things, and a p-value that size stops being
   * surprising once two hundred attempts have been made.
   */
  const CANDIDATE_P = 0.001;

  function familyOf(m: number): number[] {
    // The candidate is rank 1; every other attempt is unremarkable. This is the
    // honest shape of a real session: one strong-looking result among many
    // ordinary ones.
    return [CANDIDATE_P, ...Array.from({ length: m - 1 }, () => 0.9)];
  }

  for (const m of [5, 20, 60]) {
    it(`PROMOTES at m = ${m} (bar ${(0.1 / m).toFixed(6)})`, () => {
      const pValues = familyOf(m);
      const { decision, rank } = adjudicate(bt({ p_value: CANDIDATE_P }), pValues, 0);
      expect(rank).toBe(1);
      expect(decision.bh_adjusted_threshold).toBeCloseTo((1 / m) * POLICY.fdr_level, 12);
      expect(decision.checks.passed_bh).toBe(true);
      expect(decision.decision).toBe('PROMOTE');
      expect(decision.reason).toBeNull();
    });
  }

  it('KILLS the identical candidate at m = 200, for the BH reason and nothing else', () => {
    const pValues = familyOf(200);
    const { decision } = adjudicate(bt({ p_value: CANDIDATE_P }), pValues, 0);

    // Every other check still passes — this is not a demotion caused by a
    // weakened candidate, it is caused purely by the size of the family.
    expect(decision.checks).toEqual({
      passed_min_obs: true,
      passed_ic_floor: true,
      passed_t_stat_floor: true,
      passed_baseline_beat: true,
      passed_bh: false,
    });
    expect(decision.decision).toBe('KILL');
    expect(decision.reason).toBe('p_value_exceeds_bh_threshold');
  });

  it('states in the detail that the family size is why', () => {
    // The KILL has to be legible as a correction, not as a bad result, or the
    // recorded verdict misrepresents what happened.
    const { decision } = adjudicate(bt({ p_value: CANDIDATE_P }), familyOf(200), 0);
    expect(decision.detail).toMatch(/of 200 hypotheses attempted this session/);
    expect(decision.detail).toMatch(/expected by chance/);
    expect(decision.raw_p_value).toBe(CANDIDATE_P);
  });

  it('is monotone: a candidate that fails at m also fails at every larger family', () => {
    // The bar tightens as the family grows, so a BH failure is absorbing. If
    // this ever inverts, the correction is not being applied over the whole
    // family and every verdict past that point is unsound.
    for (const m of [200, 400, 1000]) {
      const { decision } = adjudicate(bt({ p_value: CANDIDATE_P }), familyOf(m), 0);
      expect(decision.checks.passed_bh).toBe(false);
    }
  });

  it('does not let a candidate borrow another hypothesis’s rank', () => {
    // selfIndex selects which family member this is. Reading the wrong slot —
    // or the sorted position instead of the input position — would let a
    // candidate pass on a neighbour's threshold.
    const pValues = [0.9, CANDIDATE_P, 0.9];
    expect(adjudicate(bt({ p_value: 0.9 }), pValues, 0).decision.checks.passed_bh).toBe(false);
    expect(adjudicate(bt({ p_value: CANDIDATE_P }), pValues, 1).decision.checks.passed_bh).toBe(true);
  });

  it('uses the policy’s fdr_level rather than a hardcoded 0.1', () => {
    // At q = 0.01 the bar at rank 1 of 20 is 0.0005, which p = 0.001 misses.
    const strict = { ...POLICY, fdr_level: 0.01 } as GatePolicy;
    const pValues = familyOf(20);
    expect(adjudicate(bt({ p_value: CANDIDATE_P }), pValues, 0).decision.checks.passed_bh).toBe(true);
    expect(
      adjudicate(bt({ p_value: CANDIDATE_P }), pValues, 0, strict).decision.checks.passed_bh,
    ).toBe(false);
  });
});

describe('purity and edge cases', () => {
  it('is a pure function of its inputs', () => {
    const input = {
      hypothesis: HYPOTHESIS,
      backtest: bt(),
      selfIndex: 0,
      sessionPValues: [0.001, 0.2],
      policy: POLICY,
    };
    const a = adjudicateHypothesis(input);
    const b = adjudicateHypothesis(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('handles a selfIndex outside the family without claiming a rank', () => {
    const { rank, decision } = adjudicate(bt(), [0.001], 7);
    expect(rank).toBeNull();
    expect(decision.bh_adjusted_threshold).toBe(0);
    // Still adjudicated on the other four checks; a bookkeeping bug must not
    // turn into a promotion.
    expect(decision.decision).toBe('KILL');
  });

  it('gives an empty family no rank and no BH pass', () => {
    const { decision, rank } = adjudicate(bt(), [], 0);
    expect(rank).toBeNull();
    expect(decision.checks.passed_bh).toBe(false);
    expect(decision.reason).toBe('p_value_exceeds_bh_threshold');
  });

  it('ranks ties deterministically by position', () => {
    // Two identical p-values must still get distinct ranks, and the earlier one
    // must get the better rank — otherwise the verdict depends on array order.
    const pValues = [0.001, 0.001, 0.5];
    expect(adjudicate(bt({ p_value: 0.001 }), pValues, 0).rank).toBe(1);
    expect(adjudicate(bt({ p_value: 0.001 }), pValues, 1).rank).toBe(2);
    expect(adjudicate(bt({ p_value: 0.5 }), pValues, 2).rank).toBe(3);
  });
});
