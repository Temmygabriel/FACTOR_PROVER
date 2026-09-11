/**
 * The hypothesis schema — the wall a proposal hits before anything else happens.
 *
 * A proposal that fails here is KILLed with `schema_validation_failed` and never
 * reaches the backtest: no data is fetched, no observation is counted, no
 * compute is spent. That is the whole point of validating before running, so the
 * cases that matter most are the ones that would otherwise cost a full backtest
 * to discover — chiefly `btc_funding_rate gt 0.0001`, which is vacuously empty
 * because Bitget caps BTC funding at exactly 0.0001 and 15% of DISCOVERY
 * settlements sit at the cap.
 */

import { describe, expect, it } from 'vitest';
import { formatHypothesisId, stampHypothesis, validateProposal } from '../src/schema/validate.js';
import { FAMILY_WINDOW_BOUNDS, MAX_LOOKBACK_MINUTES } from '../src/types.js';
import type { ProposedHypothesis } from '../src/types.js';

/** A proposal that passes, so each case only names the field it breaks. */
function proposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signal: 'btc_funding_rate',
    experiment_family: 'funding_to_rtoken',
    target: 'RCOINUSDT',
    direction: 'positive',
    condition: { operator: 'gt', threshold: 0.00005, lookback_minutes: 60 },
    forward_return_minutes: 60,
    ...over,
  };
}

function withCondition(over: Record<string, unknown>): Record<string, unknown> {
  return proposal({ condition: { operator: 'gt', threshold: 0.00005, lookback_minutes: 60, ...over } });
}

function errorOf(raw: unknown): string {
  const result = validateProposal(raw);
  if (result.ok) throw new Error(`expected a rejection, got ${JSON.stringify(result.hypothesis)}`);
  return result.error;
}

describe('the happy path', () => {
  it('accepts a well-formed proposal and returns only the schema fields', () => {
    const result = validateProposal(proposal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hypothesis).toEqual({
      signal: 'btc_funding_rate',
      condition: { operator: 'gt', threshold: 0.00005, lookback_minutes: 60 },
      target: 'RCOINUSDT',
      direction: 'positive',
      forward_return_minutes: 60,
      experiment_family: 'funding_to_rtoken',
    });
  });

  it('DROPS any identity field the model supplied', () => {
    // The LLM never supplies the id or the timestamp: an id it chose could
    // collide with another hypothesis's, and a timestamp it chose could be
    // backdated. The returned object is rebuilt field by field, so unknown keys
    // cannot survive — this test is what holds that property.
    const result = validateProposal(
      proposal({ hypothesis_id: 'H-9999', session_id: 'forged', proposed_at: '1999-01-01T00:00:00Z' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hypothesis).not.toHaveProperty('hypothesis_id');
    expect(result.hypothesis).not.toHaveProperty('session_id');
    expect(result.hypothesis).not.toHaveProperty('proposed_at');
  });

  it('rejects at the top level for anything that is not a JSON object', () => {
    expect(errorOf(null)).toMatch(/not a JSON object/);
    expect(errorOf([proposal()])).toMatch(/not a JSON object/);
    expect(errorOf('btc_funding_rate')).toMatch(/not a JSON object/);
    expect(errorOf(42)).toMatch(/not a JSON object/);
    expect(errorOf(undefined)).toMatch(/not a JSON object/);
  });
});

describe('enum membership', () => {
  it('rejects an unknown signal, and lists what is allowed', () => {
    const error = errorOf(proposal({ signal: 'btc_open_interest' }));
    expect(error).toMatch(/is not one of:/);
    expect(error).toMatch(/btc_funding_rate/);
  });

  it('rejects an unknown target', () => {
    expect(errorOf(proposal({ target: 'DOGEUSDT' }))).toMatch(/target "DOGEUSDT" is not one of/);
  });

  it('rejects an unknown direction', () => {
    expect(errorOf(proposal({ direction: 'long' }))).toMatch(/direction "long" is not one of/);
  });

  it('rejects a non-string signal rather than coercing it', () => {
    expect(errorOf(proposal({ signal: 1 }))).toMatch(/not one of/);
    expect(errorOf(proposal({ signal: null }))).toMatch(/not one of/);
  });
});

describe('a signal must be licensed to its family', () => {
  it('rejects a spot signal inside the funding family', () => {
    // Families exist to bound the search space; a signal that crosses them makes
    // the family label a lie and the BH family incoherent.
    const error = errorOf(
      proposal({
        signal: 'btc_spot_return',
        condition: { operator: 'gt', threshold: 0.25, lookback_minutes: 60 },
      }),
    );
    expect(error).toMatch(/signal 'btc_spot_return' is not licensed to family 'funding_to_rtoken'/);
    expect(error).toMatch(/btc_funding_rate/);
  });

  it('rejects a funding signal inside the momentum family', () => {
    expect(errorOf(proposal({ experiment_family: 'btc_momentum_to_rtoken' }))).toMatch(
      /not licensed to family 'btc_momentum_to_rtoken'/,
    );
  });

  it('rejects the combined signal inside either single-leg family', () => {
    expect(
      errorOf(proposal({ signal: 'btc_funding_x_spot', experiment_family: 'funding_to_rtoken' })),
    ).toMatch(/not licensed/);
    expect(
      errorOf(proposal({ signal: 'btc_funding_x_spot', experiment_family: 'btc_momentum_to_rtoken' })),
    ).toMatch(/not licensed/);
  });

  it('accepts the combined signal in its own family, with a combined window', () => {
    const result = validateProposal(
      proposal({
        signal: 'btc_funding_x_spot',
        experiment_family: 'combined_cross_asset',
        condition: { operator: 'gt', threshold: 0.00005, lookback_minutes: 60 },
        forward_return_minutes: 60,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown family before it ever looks at the signal', () => {
    expect(errorOf(proposal({ experiment_family: 'oi_shock_to_rtoken' }))).toMatch(
      /experiment_family "oi_shock_to_rtoken" is not one of/,
    );
  });
});

describe('FINDING 15 — a funding threshold at the cap selects nothing', () => {
  it('rejects btc_funding_rate gt 0.0001', () => {
    // The exact case from DATA_FINDINGS section 9. It looks reasonable and is
    // vacuously empty: Bitget caps BTC funding at 0.0001, so a STRICT `>` at the
    // cap selects zero observations, and the hypothesis would KILL for
    // insufficient_obs without the idea ever being tested.
    const error = errorOf(withCondition({ operator: 'gt', threshold: 0.0001 }));
    expect(error).toMatch(/can never be satisfied/);
    expect(error).toMatch(/capped at 0.0001/);
    expect(error).toMatch(/selects zero observations/);
  });

  it('rejects anything ABOVE the cap as well', () => {
    expect(errorOf(withCondition({ operator: 'gt', threshold: 0.0002 }))).toMatch(
      /can never be satisfied/,
    );
    expect(errorOf(withCondition({ operator: 'gt', threshold: 0.01 }))).toMatch(
      /can never be satisfied/,
    );
  });

  it('allows gt just BELOW the cap, so the rule is not over-broad', () => {
    // Rejecting the whole neighbourhood would be a different bug: 0.00009 is
    // strictly below the cap and does select settlements.
    expect(validateProposal(withCondition({ operator: 'gt', threshold: 0.00009 })).ok).toBe(true);
  });

  it('rejects lt at or below the funding floor', () => {
    expect(errorOf(withCondition({ operator: 'lt', threshold: -0.000125 }))).toMatch(
      /can never be satisfied/,
    );
    expect(errorOf(withCondition({ operator: 'lt', threshold: -0.001 }))).toMatch(
      /can never be satisfied/,
    );
    expect(validateProposal(withCondition({ operator: 'lt', threshold: -0.000124 })).ok).toBe(true);
  });

  it('uses each signal’s OWN range, so a threshold can be legal for one and not the other', () => {
    // -0.00014 is below BTC's measured floor of -0.000125 and above ETH's of
    // -0.00015, so the same `lt` threshold must be refused for one signal and
    // allowed for the other. A single shared range would get one of them wrong.
    expect(validateProposal(withCondition({ operator: 'lt', threshold: -0.00014 })).ok).toBe(false);
    expect(
      validateProposal(
        proposal({
          signal: 'eth_funding_rate',
          condition: { operator: 'lt', threshold: -0.00014, lookback_minutes: 60 },
        }),
      ).ok,
    ).toBe(true);
    // And ETH's own floor is still enforced.
    expect(
      validateProposal(
        proposal({
          signal: 'eth_funding_rate',
          condition: { operator: 'lt', threshold: -0.00015, lookback_minutes: 60 },
        }),
      ).ok,
    ).toBe(false);
  });

  it('applies the same rule to the percentage-change operators', () => {
    // `pct_change_gt` is a strict-above operator too, so the same vacuity
    // argument applies and the same refusal must follow.
    expect(errorOf(withCondition({ operator: 'pct_change_gt', threshold: 0.0001 }))).toMatch(
      /can never be satisfied/,
    );
    expect(errorOf(withCondition({ operator: 'pct_change_lt', threshold: -0.000125 }))).toMatch(
      /can never be satisfied/,
    );
  });

  it('ALLOWS gte at the cap, because gte is not a strict-above operator', () => {
    // The deliberate boundary of the rule: `gte 0.0001` is satisfiable — 15% of
    // DISCOVERY settlements sit at exactly the cap — so refusing it would reject
    // a hypothesis that has plenty of observations. Only the STRICT operators
    // are vacuous here, and only those are refused.
    expect(validateProposal(withCondition({ operator: 'gte', threshold: 0.0001 })).ok).toBe(true);
    expect(validateProposal(withCondition({ operator: 'lte', threshold: -0.000125 })).ok).toBe(true);
  });

  it('does not apply the funding range to a signal that has none', () => {
    // The range table is keyed by signal. Applying BTC's funding range to a spot
    // return would refuse every spot threshold in existence.
    expect(
      validateProposal(
        proposal({
          signal: 'btc_spot_return',
          experiment_family: 'btc_momentum_to_rtoken',
          condition: { operator: 'gt', threshold: 0.5, lookback_minutes: 60 },
          forward_return_minutes: 60,
        }),
      ).ok,
    ).toBe(true);
  });
});

describe('spot-return thresholds are percentages', () => {
  const spot = (threshold: number, operator = 'gt') =>
    proposal({
      signal: 'btc_spot_return',
      experiment_family: 'btc_momentum_to_rtoken',
      direction: operator === 'gt' ? 'positive' : 'negative',
      condition: { operator, threshold, lookback_minutes: 60 },
      forward_return_minutes: 60,
    });

  it('rejects a threshold under 0.01, on either side of zero', () => {
    // "BTC spot return over 0.005%" selects essentially every bar, leaving no
    // contrast to test — the condition is decorative at that size.
    const error = errorOf(spot(0.005));
    expect(error).toMatch(/too small to select a meaningful event set/);
    expect(error).toMatch(/units are percent/);
    expect(errorOf(spot(-0.005, 'lt'))).toMatch(/too small/);
    expect(errorOf(spot(0))).toMatch(/too small/);
    expect(errorOf(spot(0.0099))).toMatch(/too small/);
  });

  it('accepts exactly 0.01 and above', () => {
    // Inclusive: the rule is `|threshold| < 0.01`, so 0.01 itself is allowed.
    expect(validateProposal(spot(0.01)).ok).toBe(true);
    expect(validateProposal(spot(0.1)).ok).toBe(true);
    expect(validateProposal(spot(5)).ok).toBe(true);
  });

  it('applies to the eth spot signal as well', () => {
    expect(
      errorOf(
        proposal({
          signal: 'eth_spot_return',
          experiment_family: 'btc_momentum_to_rtoken',
          condition: { operator: 'gt', threshold: 0.001, lookback_minutes: 60 },
          forward_return_minutes: 60,
        }),
      ),
    ).toMatch(/too small/);
  });

  it('does NOT apply to funding signals, whose units are rates not percent', () => {
    // 0.0001 is a perfectly ordinary funding rate and a catastrophically small
    // percent return. The two rules must not be confused.
    expect(validateProposal(withCondition({ operator: 'gt', threshold: 0.00002 })).ok).toBe(true);
  });

  it('does not apply to the combined signal', () => {
    // The combined signal's threshold applies to the FUNDING leg, so it is a
    // rate and the percent floor does not belong to it.
    expect(
      validateProposal(
        proposal({
          signal: 'btc_funding_x_spot',
          experiment_family: 'combined_cross_asset',
          condition: { operator: 'gt', threshold: 0.00002, lookback_minutes: 60 },
          forward_return_minutes: 60,
        }),
      ).ok,
    ).toBe(true);
  });
});

describe('forward windows are bounded per family', () => {
  it('caps every family at 120 minutes', () => {
    // The original spec allowed 480. Measured against the real DISCOVERY
    // partition an 8h window yields ~70 valid non-overlapping observations,
    // below min_obs = 100, so every such hypothesis would auto-KILL for
    // insufficient data rather than on the merits of the idea.
    for (const family of ['funding_to_rtoken', 'btc_momentum_to_rtoken', 'combined_cross_asset'] as const) {
      expect(FAMILY_WINDOW_BOUNDS[family].max).toBe(120);
    }
  });

  it('rejects a window above the family’s cap', () => {
    expect(errorOf(proposal({ forward_return_minutes: 480 }))).toMatch(
      /outside family 'funding_to_rtoken's preregistered bounds of 15\.\.120/,
    );
    expect(errorOf(proposal({ forward_return_minutes: 121 }))).toMatch(/outside family/);
  });

  it('rejects a window below the family’s floor', () => {
    expect(errorOf(proposal({ forward_return_minutes: 10 }))).toMatch(/outside family/);
    expect(
      errorOf(
        proposal({
          signal: 'btc_spot_return',
          experiment_family: 'btc_momentum_to_rtoken',
          condition: { operator: 'gt', threshold: 0.25, lookback_minutes: 60 },
          forward_return_minutes: 15,
        }),
      ),
    ).toMatch(/bounds of 30\.\.120/);
  });

  it('rejects a non-integer window rather than rounding it', () => {
    // Rounding would silently test a different hypothesis from the one proposed
    // and recorded.
    expect(errorOf(proposal({ forward_return_minutes: 60.5 }))).toMatch(/must be an integer/);
    expect(errorOf(proposal({ forward_return_minutes: '60' }))).toMatch(/must be an integer/);
    expect(errorOf(proposal({ forward_return_minutes: null }))).toMatch(/must be an integer/);
  });

  it('accepts both ends of each family’s range', () => {
    for (const [family, bounds] of Object.entries(FAMILY_WINDOW_BOUNDS)) {
      const signal = family === 'funding_to_rtoken' ? 'btc_funding_rate' : family === 'btc_momentum_to_rtoken' ? 'btc_spot_return' : 'btc_funding_x_spot';
      const threshold = signal === 'btc_spot_return' ? 0.25 : 0.00005;
      for (const forward of [bounds.min, bounds.max]) {
        const result = validateProposal(
          proposal({
            signal,
            experiment_family: family,
            condition: { operator: 'gt', threshold, lookback_minutes: 60 },
            forward_return_minutes: forward,
          }),
        );
        expect(result.ok).toBe(true);
      }
    }
  });
});

describe('lookback_minutes', () => {
  it('requires an integer of at least 1', () => {
    expect(errorOf(withCondition({ lookback_minutes: 0 }))).toMatch(/must be an integer >= 1/);
    expect(errorOf(withCondition({ lookback_minutes: -30 }))).toMatch(/must be an integer >= 1/);
    expect(errorOf(withCondition({ lookback_minutes: 60.5 }))).toMatch(/must be an integer >= 1/);
    expect(errorOf(withCondition({ lookback_minutes: '60' }))).toMatch(/must be an integer >= 1/);
  });

  it('caps at MAX_LOOKBACK_MINUTES, and accepts the cap itself', () => {
    // The cap is shared with the freezer: it is what the candle lead-in is
    // derived from, so permitting a longer lookback would permit a warm-up read
    // the committed data cannot serve.
    expect(MAX_LOOKBACK_MINUTES).toBe(240);
    expect(errorOf(withCondition({ lookback_minutes: MAX_LOOKBACK_MINUTES + 1 }))).toMatch(
      /exceeds the maximum of 240/,
    );
    expect(validateProposal(withCondition({ lookback_minutes: MAX_LOOKBACK_MINUTES })).ok).toBe(true);
    expect(validateProposal(withCondition({ lookback_minutes: 1 })).ok).toBe(true);
  });
});

describe('the condition object', () => {
  it('must be present and must be an object', () => {
    expect(errorOf(proposal({ condition: undefined }))).toMatch(/condition is missing or is not an object/);
    expect(errorOf(proposal({ condition: 'gt 0.0001' }))).toMatch(/condition is missing or is not an object/);
    expect(errorOf(proposal({ condition: [1, 2] }))).toMatch(/condition is missing or is not an object/);
    expect(errorOf(proposal({ condition: null }))).toMatch(/condition is missing or is not an object/);
  });

  it('requires a known operator', () => {
    expect(errorOf(withCondition({ operator: 'equals' }))).toMatch(
      /condition.operator "equals" is not one of/,
    );
    expect(errorOf(withCondition({ operator: undefined }))).toMatch(/condition.operator/);
  });

  it('requires a finite numeric threshold', () => {
    expect(errorOf(withCondition({ threshold: '0.0001' }))).toMatch(/is not a finite number/);
    expect(errorOf(withCondition({ threshold: NaN }))).toMatch(/is not a finite number/);
    expect(errorOf(withCondition({ threshold: Infinity }))).toMatch(/is not a finite number/);
    expect(errorOf(withCondition({ threshold: null }))).toMatch(/is not a finite number/);
  });

  it('accepts a negative, zero or large threshold where the rules permit it', () => {
    expect(validateProposal(withCondition({ threshold: 0 })).ok).toBe(true);
    expect(validateProposal(withCondition({ operator: 'lt', threshold: 0 })).ok).toBe(true);
  });
});

describe('stampHypothesis', () => {
  const valid = validateProposal(proposal());
  const proposed = (valid as { ok: true; hypothesis: ProposedHypothesis }).hypothesis;

  it('attaches the ID, the session and a millisecond-free timestamp', () => {
    // Milliseconds are stripped so the recorded `proposed_at` is stable and
    // matches the format the decision log uses everywhere else.
    const stamped = stampHypothesis(proposed, {
      hypothesisId: 'H-0007',
      sessionId: 'S-2026-09-11',
      now: new Date('2026-09-11T12:34:56.789Z'),
    });
    expect(stamped.hypothesis_id).toBe('H-0007');
    expect(stamped.session_id).toBe('S-2026-09-11');
    expect(stamped.proposed_at).toBe('2026-09-11T12:34:56Z');
  });

  it('carries the proposal through unchanged', () => {
    const stamped = stampHypothesis(proposed, { hypothesisId: 'H-0001', sessionId: 'S' });
    expect(stamped.signal).toBe(proposed.signal);
    expect(stamped.condition).toEqual(proposed.condition);
    expect(stamped.forward_return_minutes).toBe(proposed.forward_return_minutes);
    expect(stamped.experiment_family).toBe(proposed.experiment_family);
  });

  it('relies on validateProposal, not on spread order, for identity safety', () => {
    // In stampHypothesis the system fields are written FIRST and `...proposal`
    // comes after, so a proposal carrying `hypothesis_id` would win. That is not
    // exploitable here because validateProposal is the only producer of a
    // ProposedHypothesis and it rebuilds the object field by field, dropping the
    // key. This test pins BOTH halves of that contract: the spread order as it
    // is, and the validator as the thing that actually stops the collision.
    const smuggled = { ...proposed, hypothesis_id: 'H-9999' } as ProposedHypothesis;
    expect(
      stampHypothesis(smuggled, { hypothesisId: 'H-0001', sessionId: 'S' }).hypothesis_id,
    ).toBe('H-9999');

    const validated = validateProposal(proposal({ hypothesis_id: 'H-9999' }));
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.hypothesis).not.toHaveProperty('hypothesis_id');
  });
});

describe('formatHypothesisId', () => {
  it('zero-pads to four digits so ids sort lexically', () => {
    expect(formatHypothesisId(1)).toBe('H-0001');
    expect(formatHypothesisId(42)).toBe('H-0042');
    expect(formatHypothesisId(999)).toBe('H-0999');
    expect(formatHypothesisId(1000)).toBe('H-1000');
  });

  it('does not truncate past four digits', () => {
    // A session that reaches 10000 hypotheses must not collide with H-1000.
    expect(formatHypothesisId(10_000)).toBe('H-10000');
    expect(formatHypothesisId(10_000)).not.toBe(formatHypothesisId(1000));
  });

  it('is dense, so ids are usable as a sequence', () => {
    const ids = [1, 2, 3, 4, 5].map(formatHypothesisId);
    expect(new Set(ids).size).toBe(5);
    expect([...ids].sort()).toEqual(ids);
  });
});
