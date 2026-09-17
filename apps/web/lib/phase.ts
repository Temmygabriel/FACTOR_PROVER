/**
 * Whether the loop can be started from a given phase.
 *
 * WHY THIS IS A PHASE QUESTION AND NOT AN ATTEMPT-COUNT QUESTION.
 *
 * The start control used to live inside the empty bench, and the empty bench
 * renders only when `stats.hypotheses_attempted === 0`. The session header's
 * button rendered only for `running` and `paused`. Those two conditions do not
 * meet: from `stopped` with one or more attempts behind it, neither control was
 * rendered, and the loop could not be started again from the interface at all —
 * one run and the product was a dead end, with no error and nothing on screen
 * saying why.
 *
 * The attempt count answers "has this process done any work", which is a
 * different question from "can this process be asked to do work". Both are worth
 * showing, and only the phase answers the second one.
 *
 * `halted_by_circuit_breaker` is deliberately excluded. A breaker halt is a
 * decision that a person has to make, and the way back is the attributed reset in
 * the circuit-breaker panel — not a start button that would immediately halt
 * again on the same trip.
 */
import type { SessionPhase } from './types';

export function canStartSession(phase: SessionPhase | null): boolean {
  if (phase === null) return false;
  return phase === 'idle' || phase === 'stopped' || phase === 'error';
}
