/**
 * Verdict derivation and tone.
 *
 * The wire format has two decision values (PROMOTE, KILL) plus CIRCUIT_BREAK,
 * and the design spec has four stamp states (PROMOTED, KILLED, RETIRED,
 * AUTO-KILLED). This file is the single place where one becomes the other, so
 * that no component decides for itself how to label a row — a second decision
 * site is how two screens end up disagreeing about the same entry.
 */

import type { DecisionRow, PromotedFactor } from './types';

export type Verdict =
  | 'PROMOTED'
  | 'KILLED'
  | 'RETIRED'
  | 'AUTO-KILLED'
  /** A halt of the loop, not a verdict on a factor. See the tone note below. */
  | 'CIRCUIT BREAK';

/**
 * Tone per verdict. These are the only class strings that may differ between
 * verdicts anywhere in the product, and each is a complete literal so the
 * Tailwind JIT emits it.
 *
 * `promoted` and `killed` are the two institutional tones from the palette and
 * they are applied identically — same border, same text, same 6% fill. Neither
 * is brighter, thicker or larger than the other. `retired` is the neutral dark
 * grey for a factor that lived and decayed.
 *
 * CIRCUIT BREAK takes the retired grey rather than the killed red. Spec §7 does
 * give the nav chip's circuit-break state the killed red, and that chip does use
 * it; but a stamp is a verdict on a hypothesis, and a circuit break is a halt of
 * the loop, so stamping a row red would tell a reader that a factor was killed
 * when what actually happened is that the loop stopped. Reserved colours only
 * mean something while they mean one thing.
 */
export const VERDICT_TONE: Record<Verdict, { text: string; border: string; fill: string }> = {
  PROMOTED: { text: 'text-promoted', border: 'border-promoted', fill: 'bg-promoted/[0.06]' },
  KILLED: { text: 'text-killed', border: 'border-killed', fill: 'bg-killed/[0.06]' },
  'AUTO-KILLED': { text: 'text-killed', border: 'border-killed', fill: 'bg-killed/[0.06]' },
  RETIRED: { text: 'text-retired', border: 'border-retired', fill: 'bg-retired/[0.06]' },
  'CIRCUIT BREAK': { text: 'text-retired', border: 'border-retired', fill: 'bg-retired/[0.06]' },
};

/**
 * A row whose hypothesis never reached the backtest is AUTO-KILLED, not KILLED.
 * The distinction is the whole point of showing it at all: an auto-kill says the
 * schema wall stopped a malformed proposal before any compute was spent, which
 * is a statement about the generator, whereas a gate kill is a statement about
 * the market.
 */
export function verdictForDecision(row: DecisionRow): Verdict {
  if (row.decision === 'PROMOTE') return 'PROMOTED';
  if (row.decision === 'CIRCUIT_BREAK') return 'CIRCUIT BREAK';
  const schemaDied =
    Boolean(row.schema_error) || row.reason === 'schema_validation_failed';
  return schemaDied ? 'AUTO-KILLED' : 'KILLED';
}

/** A promoted factor is PROMOTED while it is paper-tracked and RETIRED after. */
export function verdictForFactor(factor: PromotedFactor): Verdict {
  return factor.status === 'retired' ? 'RETIRED' : 'PROMOTED';
}

/** Kills of any kind. Used for counts and grouping, never for styling. */
export function isKill(verdict: Verdict): boolean {
  return verdict === 'KILLED' || verdict === 'AUTO-KILLED';
}

/**
 * Whether this row has gate evidence to render.
 *
 * A row killed by the schema wall never reached the backtest, so its metrics
 * block is empty in the contract's terms and would render as "IC 0.000, 0 of 5
 * checks met" — which reads as a tested factor that scored zero rather than as
 * an untested one. The stamp says the same thing either way; what changes is
 * whether the evidence block is shown at all, and showing none is more honest
 * than showing zeros.
 *
 * A CIRCUIT_BREAK entry is here for the same reason and one more. Its metrics
 * are literal placeholders — `log/decisions.ts` writes zeros with
 * `raw_p_value: 1` and `bh_adjusted_threshold: 0` because no test produced
 * anything — so rendering them would print "p 1.000, BH 0.0000, obs 0" as
 * though a backtest had run and found nothing. There is no row it could be
 * confused with that is more misleading: a stopped loop would look like a
 * measured result. The contract's own note on this (`api/rows.ts`) says the UI
 * keys off `decision === 'CIRCUIT_BREAK'` to render it as its own kind of row,
 * and this is that.
 */
export function hasGateEvidence(row: DecisionRow): boolean {
  const verdict = verdictForDecision(row);
  return verdict !== 'AUTO-KILLED' && verdict !== 'CIRCUIT BREAK';
}
