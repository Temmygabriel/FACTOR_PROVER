/**
 * Hypothesis schema validation.
 *
 * The LLM proposes; this is the wall the proposal hits before anything else
 * happens. A proposal that fails here is KILLed with `schema_validation_failed`
 * and never reaches the backtest — no data is fetched, no observation is
 * counted, and no compute is spent.
 *
 * This is the ONLY place the executable schema is enforced. Everything
 * downstream is entitled to assume a hypothesis is well-formed, so the checks
 * here are deliberately paranoid: unknown signals, signals from the wrong
 * family, non-integer windows, windows outside the family's preregistered
 * bounds, and thresholds that provably cannot select a single observation.
 *
 * On that last point. `btc_funding_rate gt 0.0001` looks perfectly reasonable
 * and is vacuously empty: Bitget's BTC funding rate is capped at 0.0001, and 15%
 * of DISCOVERY settlements sit at exactly that value, so a strict `>` at the cap
 * selects nothing. Left unchecked it costs a full backtest to discover what a
 * range check knows immediately. See docs/DATA_FINDINGS.md §9.
 */

import {
  DIRECTIONS,
  FAMILY_SIGNALS,
  FAMILY_WINDOW_BOUNDS,
  MAX_LOOKBACK_MINUTES,
  OPERATORS,
  RTOKEN_SYMBOLS,
  SIGNAL_IDS,
  type Direction,
  type ExperimentFamily,
  type FactorHypothesis,
  type Operator,
  type ProposedHypothesis,
  type RTokenSymbol,
  type SignalId,
} from '../types.js';

export type ValidationResult =
  | { ok: true; hypothesis: ProposedHypothesis }
  | { ok: false; error: string };

/**
 * Measured attainable range of each funding-rate signal, from the DISCOVERY
 * partition (156 BTC settlements, 2026-06-15 .. 2026-08-05). A threshold at or
 * beyond the maximum can never be strictly exceeded.
 *
 * These are DATA-DERIVED CONSTANTS, and that is disclosed rather than hidden.
 * They are not used to judge a hypothesis — only to refuse one that is
 * mathematically incapable of selecting an observation. Re-measure if the
 * partitions move.
 */
const FUNDING_RANGE: Record<string, { min: number; max: number }> = {
  btc_funding_rate: { min: -0.000125, max: 0.0001 },
  eth_funding_rate: { min: -0.00015, max: 0.0001 },
};

/** Operators that require the signal to strictly exceed the threshold. */
const STRICT_ABOVE: readonly Operator[] = ['gt', 'pct_change_gt'];
const STRICT_BELOW: readonly Operator[] = ['lt', 'pct_change_lt'];

function isOneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v);
}

/**
 * Validate a raw proposal. Accepts `unknown` because the input is whatever the
 * model returned — parsing JSON proves nothing about its shape.
 */
export function validateProposal(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('proposal is not a JSON object');
  }
  const o = raw as Record<string, unknown>;

  if (!isOneOf<SignalId>(o['signal'], SIGNAL_IDS)) {
    return fail(
      `signal ${JSON.stringify(o['signal'])} is not one of: ${SIGNAL_IDS.join(', ')}`,
    );
  }
  const signal = o['signal'] as SignalId;

  if (!isOneOf<ExperimentFamily>(o['experiment_family'], Object.keys(FAMILY_SIGNALS) as ExperimentFamily[])) {
    return fail(
      `experiment_family ${JSON.stringify(o['experiment_family'])} is not one of: ` +
        Object.keys(FAMILY_SIGNALS).join(', '),
    );
  }
  const family = o['experiment_family'] as ExperimentFamily;

  const allowedSignals = FAMILY_SIGNALS[family];
  if (!allowedSignals.includes(signal)) {
    return fail(
      `signal '${signal}' is not licensed to family '${family}', which may only use: ` +
        allowedSignals.join(', '),
    );
  }

  if (!isOneOf<RTokenSymbol>(o['target'], RTOKEN_SYMBOLS)) {
    return fail(
      `target ${JSON.stringify(o['target'])} is not one of: ${RTOKEN_SYMBOLS.join(', ')}`,
    );
  }
  const target = o['target'] as RTokenSymbol;

  if (!isOneOf<Direction>(o['direction'], DIRECTIONS)) {
    return fail(
      `direction ${JSON.stringify(o['direction'])} is not one of: ${DIRECTIONS.join(', ')}`,
    );
  }
  const direction = o['direction'] as Direction;

  const cond = o['condition'];
  if (typeof cond !== 'object' || cond === null || Array.isArray(cond)) {
    return fail('condition is missing or is not an object');
  }
  const c = cond as Record<string, unknown>;

  if (!isOneOf<Operator>(c['operator'], OPERATORS)) {
    return fail(
      `condition.operator ${JSON.stringify(c['operator'])} is not one of: ${OPERATORS.join(', ')}`,
    );
  }
  const operator = c['operator'] as Operator;

  const threshold = c['threshold'];
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    return fail(`condition.threshold ${JSON.stringify(threshold)} is not a finite number`);
  }

  const lookback = c['lookback_minutes'];
  if (!Number.isInteger(lookback) || (lookback as number) < 1) {
    return fail(
      `condition.lookback_minutes ${JSON.stringify(lookback)} must be an integer >= 1`,
    );
  }
  if ((lookback as number) > MAX_LOOKBACK_MINUTES) {
    return fail(
      `condition.lookback_minutes ${lookback} exceeds the maximum of ${MAX_LOOKBACK_MINUTES}`,
    );
  }

  const fwd = o['forward_return_minutes'];
  const bounds = FAMILY_WINDOW_BOUNDS[family];
  if (!Number.isInteger(fwd)) {
    return fail(`forward_return_minutes ${JSON.stringify(fwd)} must be an integer`);
  }
  if ((fwd as number) < bounds.min || (fwd as number) > bounds.max) {
    return fail(
      `forward_return_minutes ${fwd} is outside family '${family}'s preregistered ` +
        `bounds of ${bounds.min}..${bounds.max}. The bounds are set by measured ` +
        `statistical power, not preference: longer windows do not have enough ` +
        `non-overlapping observations to clear min_obs.`,
    );
  }

  // Thresholds that cannot select anything.
  const range = FUNDING_RANGE[signal];
  if (range) {
    if (STRICT_ABOVE.includes(operator) && threshold >= range.max) {
      return fail(
        `condition.threshold ${threshold} can never be satisfied: '${signal}' is capped ` +
          `at ${range.max} over the DISCOVERY partition, so '${operator} ${threshold}' ` +
          `selects zero observations. The hypothesis would KILL for insufficient_obs ` +
          `without testing the idea.`,
      );
    }
    if (STRICT_BELOW.includes(operator) && threshold <= range.min) {
      return fail(
        `condition.threshold ${threshold} can never be satisfied: '${signal}' bottoms at ` +
          `${range.min} over the DISCOVERY partition, so '${operator} ${threshold}' ` +
          `selects zero observations.`,
      );
    }
  }

  // Spot-return thresholds are percentages. A |threshold| below a few basis
  // points selects nearly every bar, which is not a condition at all.
  if (signal === 'btc_spot_return' || signal === 'eth_spot_return') {
    if (Math.abs(threshold) < 0.01) {
      return fail(
        `condition.threshold ${threshold} is too small to select a meaningful event set ` +
          `for '${signal}', whose units are percent. A threshold under 0.01% admits ` +
          `essentially every bar, leaving no contrast to test.`,
      );
    }
  }

  return {
    ok: true,
    hypothesis: {
      signal,
      condition: {
        operator,
        threshold,
        lookback_minutes: lookback as number,
      },
      target,
      direction,
      forward_return_minutes: fwd as number,
      experiment_family: family,
    },
  };
}

function fail(error: string): ValidationResult {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Identity stamping
// ---------------------------------------------------------------------------

/**
 * Attach the system-owned fields. The LLM never supplies these — an id it chose
 * could collide, and a timestamp it chose could be backdated.
 */
export function stampHypothesis(
  proposal: ProposedHypothesis,
  params: { hypothesisId: string; sessionId: string; now?: Date },
): FactorHypothesis {
  return {
    hypothesis_id: params.hypothesisId,
    session_id: params.sessionId,
    proposed_at: (params.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...proposal,
  };
}

/** `H-0001` for 1. Dense and zero-padded so ids sort lexically. */
export function formatHypothesisId(n: number): string {
  return `H-${String(n).padStart(4, '0')}`;
}
