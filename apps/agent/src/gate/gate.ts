/**
 * The deterministic gate.
 *
 * This is where a hypothesis lives or dies, and NOTHING in this file consults a
 * model. Every threshold is read from config/gate_policy.json, which is hashed
 * at session start. The LLM proposes; this decides.
 *
 * THE ONE SUBTLETY THAT MATTERS: BH IS FAMILY-WIDE AND THEREFORE NOT FINAL.
 *
 * The Benjamini-Hochberg correction is computed over every hypothesis attempted
 * this session, so a candidate's verdict depends on hypotheses that did not
 * exist yet when it was first tested. Concretely: as the family grows, k* moves,
 * and a hypothesis that cleared the bar at 40 attempts can stop clearing it at
 * 200. That is not a bug — it is what FDR control means, and pretending
 * otherwise would be exactly the dishonesty this project exists to avoid.
 *
 * So the gate is a PURE FUNCTION of (candidate, every p-value so far, policy),
 * and the loop re-adjudicates all live candidates after each new attempt. A
 * demotion is appended to the decision log as a new entry, so the log shows the
 * verdict changing and why. Nothing is ever rewritten.
 */

import {
  benjaminiHochberg,
  type BHResult,
} from '../backtest/stats.js';
import type { GatePolicy } from '../config.js';
import type {
  BacktestResult,
  FactorHypothesis,
  GateDecision,
  KillReason,
} from '../types.js';

/**
 * Preregistered order in which failing checks are reported as THE reason.
 *
 * Ordered from "the test was not meaningful" outward to "the test was
 * meaningful and the result did not clear the bar". Mirrors
 * `kill_reason_precedence` in gate_policy.json, which is the authoritative copy.
 */
export const DEFAULT_KILL_PRECEDENCE: readonly KillReason[] = [
  'insufficient_obs',
  'ic_below_floor',
  't_stat_below_floor',
  'baseline_not_beaten',
  'p_value_exceeds_bh_threshold',
];

export interface AdjudicationInput {
  hypothesis: FactorHypothesis;
  backtest: BacktestResult;
  /** Index of this hypothesis inside `sessionPValues`. */
  selfIndex: number;
  /**
   * Every p-value attempted this session, INCLUDING this one. Retries, kills,
   * near-duplicates and schema rejections all count. Narrowing this to
   * hypotheses that passed would void the correction.
   */
  sessionPValues: readonly number[];
  policy: GatePolicy;
}

export interface Adjudication {
  decision: GateDecision;
  /** The full BH result, so the caller can adjudicate the rest of the family. */
  bh: BHResult;
  /** Rank of this hypothesis's p-value (1 = smallest). Null if not found. */
  rank: number | null;
}

/**
 * Adjudicate one hypothesis against the whole session's p-values.
 *
 * Pure: same inputs, same output, no clock, no randomness, no I/O.
 */
export function adjudicateHypothesis(input: AdjudicationInput): Adjudication {
  const { backtest, policy, sessionPValues, selfIndex } = input;

  const bh = benjaminiHochberg(sessionPValues, policy.fdr_level);

  const n = backtest.n_obs;
  // Effect sizes are gated on magnitude, so a strongly NEGATIVE IC clears the
  // floor exactly as a positive one does. Direction is the hypothesis's claim;
  // the floors ask only whether there is a detectable relationship at all.
  const absIc = Math.abs(backtest.ic);
  const absT = Math.abs(backtest.t_stat);
  const absBaseline = Math.abs(backtest.baseline_ic);

  const checks = {
    passed_min_obs: n >= policy.min_obs,
    passed_ic_floor: absIc >= policy.min_ic,
    passed_t_stat_floor: absT >= policy.min_t_stat,
    passed_baseline_beat: !policy.require_baseline_beat || absIc > absBaseline,
    passed_bh: bh.reject[selfIndex] === true,
  };

  const reason = firstFailure(checks, policy);

  // The bar this hypothesis actually faced at its own rank. Reported even on a
  // pass, so the UI can show what it had to clear.
  const rank = rankOf(sessionPValues, selfIndex, bh);
  const bhThreshold = rank === null ? 0 : (rank / bh.m) * policy.fdr_level;

  const decision: GateDecision = {
    decision: reason === null ? 'PROMOTE' : 'KILL',
    reason,
    detail: reason === null
      ? describePass(input, bhThreshold, bh)
      : describeFailure(reason, input, bhThreshold, bh),
    bh_adjusted_threshold: bhThreshold,
    raw_p_value: backtest.p_value,
    checks,
  };

  return { decision, bh, rank };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Checks = GateDecision['checks'];

function firstFailure(checks: Checks, policy: GatePolicy): KillReason | null {
  const precedence = readPrecedence(policy);

  const failed: Record<string, boolean> = {
    insufficient_obs: !checks.passed_min_obs,
    ic_below_floor: !checks.passed_ic_floor,
    t_stat_below_floor: !checks.passed_t_stat_floor,
    baseline_not_beaten: !checks.passed_baseline_beat,
    p_value_exceeds_bh_threshold: !checks.passed_bh,
  };

  for (const r of precedence) {
    if (failed[r] === true) return r;
  }
  // Any failed check not named in the preregistered order still kills, so a
  // policy edit that forgets to list a reason cannot silently promote.
  for (const [k, v] of Object.entries(failed)) {
    if (v) return k as KillReason;
  }
  return null;
}

function readPrecedence(policy: GatePolicy): readonly KillReason[] {
  const raw = (policy as Record<string, unknown>)['kill_reason_precedence'];
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_KILL_PRECEDENCE;
  return raw.filter((x): x is KillReason => typeof x === 'string');
}

/** Position of this hypothesis's p-value among the family, 1-based. */
function rankOf(
  sessionPValues: readonly number[],
  selfIndex: number,
  bh: BHResult,
): number | null {
  if (selfIndex < 0 || selfIndex >= sessionPValues.length) return null;
  const mine = sessionPValues[selfIndex]!;
  // Count strictly-smaller values, then add ties by position so equal p-values
  // still get distinct, deterministic ranks.
  let smaller = 0;
  let tiedBefore = 0;
  for (let i = 0; i < sessionPValues.length; i++) {
    if (i === selfIndex) continue;
    const p = sessionPValues[i]!;
    if (p < mine) smaller++;
    else if (p === mine && i < selfIndex) tiedBefore++;
  }
  const rank = smaller + tiedBefore + 1;
  return rank <= bh.m ? rank : null;
}

const f = (x: number, d = 4): string => (Number.isFinite(x) ? x.toFixed(d) : String(x));

function describeFailure(
  reason: KillReason,
  input: AdjudicationInput,
  bhThreshold: number,
  bh: BHResult,
): string {
  const { backtest: b, policy } = input;
  switch (reason) {
    case 'insufficient_obs':
      return (
        `Only ${b.n_obs} valid non-overlapping observations; the preregistered floor is ` +
        `${policy.min_obs}. Nothing is concluded about the idea — the data cannot test it.`
      );
    case 'ic_below_floor':
      return (
        `|IC| = ${f(Math.abs(b.ic))} is below the preregistered floor of ${policy.min_ic}. ` +
        `Any relationship present is too weak to be worth trading.`
      );
    case 't_stat_below_floor':
      return (
        `|t| = ${f(Math.abs(b.t_stat), 3)} is below the preregistered floor of ${policy.min_t_stat}. ` +
        `The measured relationship is not distinguishable from noise.`
      );
    case 'baseline_not_beaten':
      return (
        `|IC| = ${f(Math.abs(b.ic))} does not exceed the naive baseline's |IC| = ` +
        `${f(Math.abs(b.baseline_ic))}. The signal adds nothing over simply using the ` +
        `target's own trailing return.`
      );
    case 'p_value_exceeds_bh_threshold':
      return (
        `p = ${f(b.p_value)} does not clear the Benjamini-Hochberg threshold of ` +
        `${f(bhThreshold)} applied at rank ${rankOf(input.sessionPValues, input.selfIndex, bh) ?? '?'} ` +
        `of ${bh.m} hypotheses attempted this session (FDR level ${policy.fdr_level}). ` +
        `Across this many attempts, a p-value this size is expected by chance.`
      );
    default:
      return `Killed: ${reason}.`;
  }
}

function describePass(
  input: AdjudicationInput,
  bhThreshold: number,
  bh: BHResult,
): string {
  const { backtest: b, policy } = input;
  const rank = rankOf(input.sessionPValues, input.selfIndex, bh);
  return (
    `Cleared every preregistered check: n = ${b.n_obs} (floor ${policy.min_obs}), ` +
    `|IC| = ${f(Math.abs(b.ic))} (floor ${policy.min_ic}), ` +
    `|t| = ${f(Math.abs(b.t_stat), 3)} (floor ${policy.min_t_stat}), ` +
    `baseline |IC| = ${f(Math.abs(b.baseline_ic))}, ` +
    `p = ${f(b.p_value)} vs BH threshold ${f(bhThreshold)} at rank ${rank ?? '?'} of ${bh.m}. ` +
    `This is a survivorship result under FDR control, not a claim of profitability.`
  );
}
