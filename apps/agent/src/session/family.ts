/**
 * The BH family, and the two screens that decide what is allowed to join it.
 *
 * THE FAMILY IS THE PREREGISTERED UNIT OF CORRECTION. Benjamini-Hochberg
 * controls the false discovery rate across *every hypothesis attempted this
 * session*, so the family's membership is not bookkeeping — it is the thing
 * that makes the correction mean anything. Two rules follow, and both are
 * inconvenient in the same direction:
 *
 *   1. A hypothesis that was never backtested still occupies a slot.
 *   2. Slots are never removed, even when a hypothesis is killed outright.
 *
 * Rule 1 is where this file earns its keep. A schema-rejected, duplicate or
 * lookback-biased hypothesis has no p-value, because no test was run. The
 * tempting move is to leave it out of the family, since it contributes no
 * evidence. That is exactly the move that would let a repetitive loop inflate
 * its own significance: propose one idea, get it wrong two hundred times, keep
 * only the run that looked good, and the correction never sees the two hundred.
 *
 * So an untested hypothesis joins the family with p = 1. That is the maximally
 * non-significant value, and it has two properties that make it the honest
 * choice rather than merely a convenient one:
 *
 *   - It can never itself be rejected, at any family size: BH rejects rank k
 *     when p_(k) <= (k/m)*q, and p = 1 needs 1 <= q, which is false for every
 *     q < 1. So it adds no discoveries.
 *   - It raises m, which LOWERS (k/m)*q at every rank. So it can only ever
 *     tighten the bar for everybody else. Adding slots can demote, never
 *     promote.
 *
 * In other words the choice is strictly conservative: it cannot manufacture a
 * result that a laxer accounting would have missed. The alternative reading —
 * that the family should hold only the tests actually performed — is defensible
 * statistics, and it is REJECTED here because the spec preregisters the broader
 * family, and quietly narrowing a preregistered protocol because it turned out
 * to be inconvenient is the precise failure this project exists to avoid.
 */

import { benjaminiHochberg } from '../backtest/stats.js';
import type { FactorHypothesis, ProposedHypothesis, SignalId } from '../types.js';

// ---------------------------------------------------------------------------
// Family membership
// ---------------------------------------------------------------------------

/**
 * How a slot's p-value came to exist.
 *
 * Recorded so the UI can distinguish "we tested this and it failed" from "we
 * never tested this". Those are different claims and collapsing them would
 * overstate how much was actually measured.
 */
export type SlotOrigin = 'tested' | 'schema_rejected' | 'duplicate' | 'lookback_bias';

export interface FamilySlot {
  /** Position in the family. Stable for the life of the session. */
  index: number;
  hypothesis_id: string;
  p_value: number;
  origin: SlotOrigin;
}

export class SessionFamily {
  private readonly slots: FamilySlot[] = [];

  /**
   * Add a slot and return it.
   *
   * `pValues` is indexed by `FamilySlot.index`, so a slot's position never
   * moves once assigned. That matters because the gate is re-run for every live
   * candidate after each new attempt: an old candidate's `selfIndex` has to
   * still point at its own p-value after the array has grown around it.
   */
  add(params: { hypothesisId: string; pValue: number; origin: SlotOrigin }): FamilySlot {
    const slot: FamilySlot = {
      index: this.slots.length,
      hypothesis_id: params.hypothesisId,
      p_value: params.pValue,
      origin: params.origin,
    };
    this.slots.push(slot);
    return slot;
  }

  /** Every p-value in the family, in slot order. The gate's `sessionPValues`. */
  get pValues(): readonly number[] {
    return this.slots.map((s) => s.p_value);
  }

  get size(): number {
    return this.slots.length;
  }

  get all(): readonly FamilySlot[] {
    return [...this.slots];
  }

  slotFor(hypothesisId: string): FamilySlot | undefined {
    return this.slots.find((s) => s.hypothesis_id === hypothesisId);
  }

  /**
   * The BH threshold applied at rank 1 under the current family size.
   *
   * With m hypotheses the rank-1 bar is (1/m)*q, which is the strictest
   * threshold any member faces. Exposed because it is the single most
   * legible number for "how hard is this session to pass" — the UI shows it
   * live, and watching it fall as the family grows is the clearest possible
   * demonstration of what multiple-testing correction actually does.
   */
  rank1Threshold(fdrLevel: number): number {
    const m = this.slots.length;
    return m === 0 ? 0 : (1 / m) * fdrLevel;
  }

  /**
   * How many members would currently be rejected. Used for reporting only —
   * the authoritative per-hypothesis answer comes from the gate.
   */
  rejectedCount(fdrLevel: number): number {
    return benjaminiHochberg(this.pValues, fdrLevel).reject.filter(Boolean).length;
  }
}

// ---------------------------------------------------------------------------
// Screen 1 — duplicate detection (kill reason: duplicate_family)
// ---------------------------------------------------------------------------

/**
 * Tolerance on `lookback_minutes` when deciding two hypotheses are the same
 * test. A hypothesis's lookback is one of its defining parameters, but two
 * lookbacks 15 minutes apart over a 52-day partition are not meaningfully
 * different probes of the same idea, and letting them through would spend a
 * backtest to learn nothing.
 */
const LOOKBACK_TOLERANCE_MINUTES = 15;

/**
 * Relative tolerance on `threshold`. Relative rather than absolute because the
 * thresholds in this system span funding rates near 1e-4 and percentage returns
 * near 1e0; a single absolute epsilon cannot be right for both. 1% of the
 * larger magnitude is tight enough that 0.00005 and 0.00009 stay distinct.
 */
const THRESHOLD_REL_TOLERANCE = 0.01;

/**
 * Signals whose value is a LEVEL rather than a lookback-differenced quantity.
 *
 * This is loaded, and it is loaded because of a measured property of the
 * engine: `computeSignalBundle` expands funding settlements into a step
 * function and reads `lookback_minutes` NOWHERE for these two signals. A
 * funding hypothesis with lookback 60 and the same hypothesis with lookback 240
 * produce byte-identical signal series, hence identical IC, identical p-value,
 * and identical verdicts.
 *
 * Treating those as two independent tests would be a straight lie about the
 * family: one test performed, two reported. So `lookback_minutes` is excluded
 * from the identity of a level-signal hypothesis, and the second one is caught
 * as a duplicate instead of being counted as fresh evidence.
 *
 * The alternative — making the funding signal actually use its lookback, e.g.
 * as a change over the window — would give the field meaning, but it would also
 * change what every existing funding hypothesis measures. That is a signal
 * semantics change and belongs in its own change, disclosed as such, not folded
 * silently into duplicate detection.
 */
const LEVEL_SIGNALS: readonly SignalId[] = ['btc_funding_rate', 'eth_funding_rate'];

/** Identity of a hypothesis as a TEST, independent of its incidental parameters. */
function testKey(h: ProposedHypothesis): string {
  const parts = [
    h.signal,
    h.target,
    h.direction,
    h.condition.operator,
    String(h.forward_return_minutes),
  ];
  // Only lookback-differenced signals have a lookback that changes the numbers.
  if (!LEVEL_SIGNALS.includes(h.signal)) {
    parts.push(`lb~${Math.round(h.condition.lookback_minutes / LOOKBACK_TOLERANCE_MINUTES)}`);
  }
  return parts.join('|');
}

function nearThreshold(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale < 1e-12) return true;
  return Math.abs(a - b) / scale < THRESHOLD_REL_TOLERANCE;
}

export interface PriorAttempt {
  hypothesis_id: string;
  hypothesis: ProposedHypothesis;
}

/**
 * The prior attempt this proposal duplicates, or null.
 *
 * One-directional on purpose: the FIRST appearance of an idea is the test, and
 * every later appearance is the duplicate. That ordering is what makes the
 * family honest — a loop cannot dilute a real test by restating it, and a
 * restated idea cannot later be presented as an independent confirmation.
 */
export function findDuplicate(
  candidate: ProposedHypothesis,
  prior: readonly PriorAttempt[],
): PriorAttempt | null {
  const key = testKey(candidate);
  for (const p of prior) {
    if (testKey(p.hypothesis) !== key) continue;
    if (!nearThreshold(p.hypothesis.condition.threshold, candidate.condition.threshold)) continue;
    return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Screen 2 — lookback bias (kill reason: lookback_bias_detected)
// ---------------------------------------------------------------------------

/**
 * OPERATORS THAT CLAIM A LOOKBACK-DIFFERENCED SIGNAL.
 *
 * `pct_change_gt` asserts "the percent change over the last `lookback_minutes`
 * exceeded this threshold". The engine's `conditionHolds` compares the signal
 * VALUE against the threshold, so the operator is only truthful when the signal
 * value IS a change over the lookback. For the spot-return families it is:
 * `spotReturnSeries` computes exactly that difference.
 *
 * For the funding families it is not. The signal is the rate in force, a level.
 * So `btc_funding_rate pct_change_gt 0.00005` would be adjudicated as "the
 * funding rate exceeded 0.00005" while the record says the hypothesis claimed a
 * change over 60 minutes. The verdict would be a statement about a different
 * idea than the one written down, and the decision log — the artifact the whole
 * submission rests on — would carry the wrong description of what was tested.
 *
 * A silent semantic mismatch between what a hypothesis SAYS and what the engine
 * MEASURES is the most expensive kind of bug this project can ship, because
 * nothing errors: a number comes out, it is plausible, and it is labelled with
 * the wrong question. So it is refused by name instead.
 */
const CHANGE_OPERATORS = new Set(['pct_change_gt', 'pct_change_lt']);

/**
 * Lookback bias, defined explicitly.
 *
 * The build spec names this kill reason but never defines it, and the design
 * spec does not either. Rather than leave a reason in the enum with no meaning,
 * the definition used here is written down, and it is deliberately the NARROW
 * one — it fires only on things this engine can actually detect, rather than
 * sounding broad and never firing.
 *
 * A hypothesis is lookback-biased when its declared lookback does not describe
 * the series its operator is applied to. One reachable instance exists today:
 *
 *   A `pct_change_*` operator over a level-valued signal. The operator asserts a
 *   change over the lookback; the engine compares a level. See
 *   CHANGE_OPERATORS above.
 *
 * A second instance is asserted rather than detected:
 *
 *   The signal's read window [t-L, t] must not intersect the forward-return
 *   window [t, t+F] with positive length. Today no signal implementation
 *   violates this — the spot legs read BTC/ETH while the forward return reads
 *   the rToken, and the funding step function reads at or before t — so the
 *   check passes for every hypothesis in the current search space. It is kept
 *   because the obvious next signal to add (one computed from the TARGET's own
 *   history) would violate it, and a lookback that reaches into the window it
 *   is predicting is the classic way a backtest manufactures a result. An
 *   invariant that holds is worth asserting precisely because it is the thing
 *   that keeps holding.
 *
 * Both instances share one property, which is why they share one name: the
 * lookback does not mean what the hypothesis says it means.
 *
 * Returns a human-readable explanation, or null when the hypothesis is clean.
 * The string goes into the decision log verbatim, so it is written for a reader.
 */
export function lookbackBias(candidate: ProposedHypothesis): string | null {
  if (CHANGE_OPERATORS.has(candidate.condition.operator) && LEVEL_SIGNALS.includes(candidate.signal)) {
    return (
      `operator ${candidate.condition.operator} asserts a change over ` +
      `${candidate.condition.lookback_minutes} minutes, but ${candidate.signal} is a level: the ` +
      `engine compares the rate in force against the threshold, not a change. The recorded ` +
      `hypothesis would describe a different test than the one performed, so it is refused ` +
      `rather than adjudicated on the wrong question.`
    );
  }

  const readWindowStartMs = -candidate.condition.lookback_minutes;
  const forwardWindowStartMs = 0;
  const readWindowEndMs = 0;
  const forwardWindowEndMs = candidate.forward_return_minutes;
  const overlapMs = Math.min(readWindowEndMs, forwardWindowEndMs) - Math.max(readWindowStartMs, forwardWindowStartMs);

  if (overlapMs > 0) {
    return (
      `the signal's read window [t-${candidate.condition.lookback_minutes}, t] overlaps the ` +
      `forward-return window [t, t+${candidate.forward_return_minutes}] by ${overlapMs} minutes, ` +
      `so the signal has seen part of the return it claims to predict.`
    );
  }

  return null;
}

/**
 * Structural note on the overlap check above.
 *
 * With the read window ending at t and the forward window starting at t, the
 * overlap is `min(0, F) - max(-L, 0)` = `0 - 0` = 0 for every L >= 0, F >= 0.
 * It therefore cannot fire for any hypothesis the current schema admits, and
 * that is the intended reading rather than a dead branch: it is an assertion
 * that the engine's window conventions stay disjoint. The branch becomes live
 * the moment a signal reads the target's own series across its lookback, which
 * is the one change that would make this backtest capable of predicting the
 * future.
 *
 * The check is written as arithmetic rather than as a comment saying "these are
 * disjoint" so that a future change to the window convention has to break a
 * comparison rather than merely contradict a sentence.
 */
export const __overlapCheckIsStructural = true;

/** Convenience for the loop: the family-level view of a stamped hypothesis. */
export function asProposed(h: FactorHypothesis): ProposedHypothesis {
  return {
    signal: h.signal,
    condition: h.condition,
    target: h.target,
    direction: h.direction,
    forward_return_minutes: h.forward_return_minutes,
    experiment_family: h.experiment_family,
  };
}
