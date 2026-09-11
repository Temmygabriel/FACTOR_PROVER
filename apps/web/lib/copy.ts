/**
 * The dual vocabulary, in one place.
 *
 * The design spec asks for technical labels with plain-language tooltips
 * (§6 Screen 2). Every translation the product makes between a machine value and
 * an English sentence lives here, for one reason: the wording is where a kill
 * gets editorialised. A single file of sentences can be read and checked; a
 * sentence written inline at the point of failure cannot.
 *
 * The wording rules, from spec §9:
 *   - A kill is something the gate DID. "the gate killed it", never "it failed".
 *   - Never "rejected", "failed", "bad signal", "unsuccessful", "no data".
 *   - Always say what was not affected, not just what went wrong.
 */

import type { KillReason } from './types';
import type { Verdict } from './verdict';

/**
 * Why an entry was killed, in one sentence a reader outside the project can
 * follow. The floors quoted are the preregistered ones (gate_policy.json v1.0)
 * and the same constants are rendered as the bar in the stamp, so the sentence
 * and the check row cannot disagree.
 */
export const KILL_REASON_PLAIN: Record<KillReason, string> = {
  insufficient_obs:
    'fewer than 100 valid observations — too few to test, so the gate killed it on the evidence available rather than on the idea',
  ic_below_floor:
    'the correlation was weaker than the preregistered floor of 0.04, so the signal did not move with the forward return',
  t_stat_below_floor:
    'the t-statistic was below the preregistered floor of 2.0, so at this sample size the result is not distinguishable from chance',
  baseline_not_beaten:
    'the factor did not outperform a naive baseline that uses the previous period’s return as the signal',
  p_value_exceeds_bh_threshold:
    'the p-value did not survive the Benjamini-Hochberg correction applied across every hypothesis attempted this session',
  lookback_bias_detected:
    'the signal’s own past values predicted it, so the test was measuring the lookback window rather than the market',
  duplicate_family:
    'an earlier hypothesis in this session already tested this signal and target pair',
  schema_validation_failed:
    'the hypothesis did not conform to the required structure, so no backtest was run and no gate decision was reached',
};

/** The short tag used where a sentence will not fit. Spec §6 Screen 2. */
export const KILL_REASON_TAG: Record<KillReason, string> = {
  p_value_exceeds_bh_threshold: 'p > BH',
  insufficient_obs: 'n < 100',
  baseline_not_beaten: 'no base',
  schema_validation_failed: 'schema',
  ic_below_floor: 'IC < 0.04',
  t_stat_below_floor: 't < 2.0',
  lookback_bias_detected: 'lookback',
  duplicate_family: 'duplicate',
};

export const KILL_REASON_TOOLTIP: Record<KillReason, string> = {
  p_value_exceeds_bh_threshold:
    'Did not survive multiple-testing correction across all hypotheses attempted this session.',
  insufficient_obs: 'Too few data points to test reliably.',
  baseline_not_beaten: 'Did not outperform a naive prior-period return signal.',
  schema_validation_failed: 'Hypothesis did not conform to required structure.',
  ic_below_floor: 'Correlation below the preregistered floor of 0.04.',
  t_stat_below_floor: 'Below the preregistered t-statistic floor of 2.0.',
  lookback_bias_detected: 'The signal predicted itself; the test measured the lookback.',
  duplicate_family: 'An earlier hypothesis tested the same signal and target pair.',
};

/** Falls back to the raw value so an unseen reason renders as itself. */
export function killReasonPlain(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return KILL_REASON_PLAIN[reason as KillReason] ?? `killed: ${reason}`;
}

export function killReasonTag(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return KILL_REASON_TAG[reason as KillReason] ?? reason;
}

export function killReasonTooltip(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return KILL_REASON_TOOLTIP[reason as KillReason] ?? reason;
}

/** What each stamp label means, for the legend under the leaderboard. */
export const VERDICT_MEANING: Record<Verdict, string> = {
  PROMOTED: 'the factor cleared the preregistered statistical gate',
  KILLED: 'the factor did not survive multiple-testing correction',
  RETIRED: 'the factor was promoted but its edge has decayed',
  'AUTO-KILLED': 'the hypothesis did not conform to the required schema',
  'CIRCUIT BREAK': 'the loop halted itself; no verdict was reached on a factor',
};

/**
 * Technical signal names, and what they actually are. The signal enum is the
 * vocabulary the gate reasons in; a reader should not have to learn it.
 */
export const SIGNAL_PLAIN: Record<string, string> = {
  btc_funding_rate:
    'the funding payment on Bitget’s BTC perpetual — positive means longs pay shorts',
  eth_funding_rate: 'the funding payment on Bitget’s ETH perpetual',
  btc_spot_return: 'the change in BTC spot price over the lookback window',
  eth_spot_return: 'the change in ETH spot price over the lookback window',
  btc_funding_x_spot: 'a conjunction: a BTC funding condition AND a BTC spot move together',
};

export const OPERATOR_PLAIN: Record<string, string> = {
  gt: 'greater than',
  lt: 'less than',
  gte: 'at least',
  lte: 'at most',
  pct_change_gt: 'percentage change greater than',
  pct_change_lt: 'percentage change less than',
};

/** Column headers, with the spec's tooltip copy (§6 Screen 2). */
export const COLUMN_TIPS = {
  ic: 'How consistently this signal predicted direction. 0 = no relationship. Above 0.04 is meaningful here.',
  t: 'Statistical confidence. Above 2.0 means the result is unlikely to be random chance.',
  obs: 'Number of valid data points used in the test. Below 100 = not enough evidence to test.',
  p: 'The raw probability of seeing a relationship this strong by chance alone, before correcting for how many hypotheses were tested.',
  bh: 'The threshold this p-value had to clear, after the Benjamini-Hochberg correction over every hypothesis attempted this session. It falls as the session attempts more hypotheses.',
  baseline:
    'What a naive signal achieves on the same data — using the previous period’s return to predict the next. A factor has to beat this to count.',
  pnl: 'Paper profit and loss in USDT. No real funds are involved at any point.',
  decay:
    'How fast the factor’s edge halves, once enough forward data exists to fit it. A short half-life means the effect fades quickly.',
  window: 'How far ahead the forward return is measured, from the moment the condition is met.',
  lookback: 'How far back the condition looks to decide whether it has been met.',
};

/**
 * The five gate checks, in the preregistered precedence order (lib/policy.ts),
 * with the label and the sentence explaining what the row is comparing.
 */
export const CHECK_ROWS = {
  passed_min_obs: {
    label: 'observations',
    tip: 'Independent observations available for this hypothesis. The floor is 100; below it the gate kills on insufficient evidence.',
  },
  passed_ic_floor: {
    label: 'IC',
    tip: 'Correlation between the signal and the forward return. The floor is 0.04.',
  },
  passed_t_stat_floor: {
    label: 't-statistic',
    tip: 'How far the IC sits from zero, in standard errors. The floor is 2.0.',
  },
  passed_baseline_beat: {
    label: 'baseline IC',
    tip: 'What a naive prior-period-return signal scores on the same data. The factor has to beat it.',
  },
  passed_bh: {
    label: 'p-value',
    tip: 'Compared against the Benjamini-Hochberg threshold at this family size, not against a fixed 0.05.',
  },
} as const;

/** The tagline from spec §9. No profitability claim, no superlative. */
export const TAGLINE =
  'Factor Prover tests cross-asset hypotheses against Bitget market data and issues a verdict on each one. It shows every kill.';

/**
 * The null-result framing from spec §9, used when the session has promoted
 * nothing. The counts are filled by the caller; this is not a fallback, it is
 * the honest statement a zero-promote session should make.
 */
export function nullResultCopy(attempted: number, fdrLevel: number): string[] {
  return [
    'No factors promoted in this session.',
    `${attempted} ${
      attempted === 1 ? 'hypothesis was' : 'hypotheses were'
    } tested. All of them died at the Benjamini-Hochberg correction applied across all ${attempted} tests at FDR level ${fdrLevel.toFixed(
      2,
    )}.`,
    'This is a result. A factor miner that promotes everything is broken. The gate is working.',
  ];
}
