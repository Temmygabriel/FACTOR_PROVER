/**
 * Circuit breaker — the loop's emergency stop.
 *
 * The spec's framing: an autonomous loop that has gone wrong does not usually
 * crash, it keeps going. It grinds out two hundred variations of one idea, or
 * spends the day's order budget on a signal that stopped working, or hammers a
 * dead provider until the session log is nothing but failures. Each of those is
 * a runaway that looks like normal operation from the inside.
 *
 * So the breaker watches for the specific shapes of runaway and halts the loop
 * cleanly. Halting is not a failure state — it is the system noticing something
 * a human should look at.
 *
 * All thresholds come from config/gate_policy.json's `circuit_breaker` block,
 * which is preregistered and hashed. None is hardcoded here.
 *
 * TWO KINDS OF COUNTER, AND THE DIFFERENCE MATTERS:
 *
 *   DAILY counters (hypotheses, promotes, paper orders) reset at the UTC day
 *   boundary. They bound spend, so their natural period is a day.
 *
 *   CONSECUTIVE counters (LLM failures) reset on success, not on a clock. Three
 *   failures in a row means no model tier could be reached; three failures
 *   spread over an hour with successes between them means nothing at all.
 *
 *   What feeds that counter is deliberately narrow. Only a tier that was called
 *   and failed for a transport reason counts. A missing API key is a deployment
 *   choice, and a 429 is this loop's own request rate — neither is an outage, and
 *   recording either as one halts a session that was working while blaming a
 *   provider that was healthy. See `TierFailureKind` in src/llm/provider.ts.
 *
 * The degeneracy check is the interesting one. It does not look at one
 * hypothesis, it looks at the RECENT SHAPE of the session: if 4 of the last 5
 * proposals share a signal+target pair, the loop is not exploring, it is
 * repeating. That is the exact behaviour the multiple-testing correction exists
 * to punish, and it is better to stop the loop than to let it manufacture a
 * family of correlated tests that BH will then have to reject.
 */

import type { GatePolicy } from '../config.js';
import { loadGatePolicy } from '../config.js';
import type { RTokenSymbol, SignalId } from '../types.js';

export type BreakerTripReason =
  | 'max_hypotheses_per_day'
  | 'max_promotes_per_day'
  | 'max_paper_orders_per_day'
  | 'degenerate_loop'
  | 'max_consecutive_llm_failures'
  | 'manual_reset_required';

export interface BreakerState {
  tripped: boolean;
  reason: BreakerTripReason | null;
  /** Machine-generated, never LLM-authored. */
  detail: string;
  tripped_at: string | null;
  /** UTC date (YYYY-MM-DD) the daily counters currently belong to. */
  day: string;
}

export interface BreakerCounters {
  day: string;
  hypotheses_today: number;
  promotes_today: number;
  paper_orders_today: number;
  consecutive_llm_failures: number;
}

/** One recorded proposal, for the degeneracy window. */
interface Shape {
  signal: SignalId;
  target: RTokenSymbol;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class CircuitBreaker {
  private readonly rules: GatePolicy['circuit_breaker'];
  private readonly now: () => Date;

  private state: BreakerState;
  private counters: BreakerCounters;
  /** Most recent shapes, oldest first. Bounded by duplicate_signal_target_window. */
  private shapes: Shape[] = [];

  constructor(policy?: GatePolicy, now: () => Date = () => new Date()) {
    this.rules = (policy ?? loadGatePolicy().data).circuit_breaker;
    this.now = now;
    this.counters = {
      day: utcDay(this.now()),
      hypotheses_today: 0,
      promotes_today: 0,
      paper_orders_today: 0,
      consecutive_llm_failures: 0,
    };
    this.state = {
      tripped: false,
      reason: null,
      detail: '',
      tripped_at: null,
      day: this.counters.day,
    };
  }

  /**
   * The getters roll the day before reporting.
   *
   * Without this, a read at 00:30 UTC returns yesterday's counters, because the
   * only thing that advances the day is a write or a check. That is the exact
   * shape of bug this project keeps finding: the state is right in the loop and
   * stale on every read path that reports it — including `GET /api/status` and
   * the frontend. Rolling on read is idempotent and costs a string compare.
   */
  get currentState(): BreakerState {
    this.rollDay();
    return { ...this.state };
  }

  get currentCounters(): BreakerCounters {
    this.rollDay();
    return { ...this.counters };
  }

  /** How many log entries the LLM prompt may carry. */
  get maxLogEntriesInContext(): number {
    return this.rules.max_log_entries_in_context;
  }

  /**
   * Roll the daily counters over at the UTC day boundary.
   *
   * Called at the top of every check rather than on a timer, so it cannot be
   * missed by a loop that was paused. A trip is NOT cleared by the rollover: a
   * breaker that reset itself overnight would defeat its own purpose, which is
   * to require a human decision.
   */
  private rollDay(): void {
    const today = utcDay(this.now());
    if (today !== this.counters.day) {
      this.counters.day = today;
      this.counters.hypotheses_today = 0;
      this.counters.promotes_today = 0;
      this.counters.paper_orders_today = 0;
      this.state.day = today;
    }
  }

  /** Record a generated hypothesis (valid or not) and feed the degeneracy window. */
  recordHypothesis(shape?: Shape): void {
    this.rollDay();
    this.counters.hypotheses_today += 1;
    if (shape) {
      this.shapes.push(shape);
      const window = this.rules.duplicate_signal_target_window;
      if (this.shapes.length > window) this.shapes.splice(0, this.shapes.length - window);
    }
  }

  recordPromote(): void {
    this.rollDay();
    this.counters.promotes_today += 1;
  }

  recordPaperOrder(): void {
    this.rollDay();
    this.counters.paper_orders_today += 1;
  }

  recordLlmFailure(): void {
    this.counters.consecutive_llm_failures += 1;
  }

  recordLlmSuccess(): void {
    this.counters.consecutive_llm_failures = 0;
  }

  /**
   * The most common signal+target pair in the window and how often it appears.
   * Exposed so the UI can show how close the session is to tripping, which is
   * more useful than only learning about it after the fact.
   */
  private dominantShape(): { key: string; count: number } | null {
    if (this.shapes.length === 0) return null;
    const counts = new Map<string, number>();
    for (const s of this.shapes) {
      const key = `${s.signal} -> ${s.target}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best: { key: string; count: number } | null = null;
    // Sorted iteration so ties resolve deterministically rather than by
    // whichever key the Map happened to visit first.
    for (const key of [...counts.keys()].sort()) {
      const count = counts.get(key)!;
      if (!best || count > best.count) best = { key, count };
    }
    return best;
  }

  /**
   * Evaluate every rule. Trips the breaker on the first violation found.
   *
   * Ordering is deliberate: spend limits are checked before the shape rules,
   * because "the day's budget is gone" is a more actionable thing to surface
   * than "the last five proposals looked similar".
   */
  check(): BreakerState {
    this.rollDay();
    if (this.state.tripped) return this.currentState;

    const r = this.rules;

    if (this.counters.hypotheses_today >= r.max_hypotheses_per_day) {
      return this.trip(
        'max_hypotheses_per_day',
        `daily hypothesis budget exhausted: ${this.counters.hypotheses_today} of ` +
          `${r.max_hypotheses_per_day} attempted on ${this.counters.day} (UTC)`,
      );
    }

    if (this.counters.promotes_today >= r.max_promotes_per_day) {
      return this.trip(
        'max_promotes_per_day',
        `daily promote budget exhausted: ${this.counters.promotes_today} of ` +
          `${r.max_promotes_per_day} promoted on ${this.counters.day} (UTC)`,
      );
    }

    if (this.counters.paper_orders_today >= r.max_paper_orders_per_day) {
      return this.trip(
        'max_paper_orders_per_day',
        `daily paper-order budget exhausted: ${this.counters.paper_orders_today} of ` +
          `${r.max_paper_orders_per_day} sent on ${this.counters.day} (UTC)`,
      );
    }

    if (this.counters.consecutive_llm_failures >= r.max_consecutive_llm_failures) {
      return this.trip(
        'max_consecutive_llm_failures',
        `${this.counters.consecutive_llm_failures} consecutive iterations in which no ` +
          `model tier could be reached (limit ${r.max_consecutive_llm_failures}); the loop ` +
          `is generating hypotheses it cannot attribute to a model. Rate limits are not ` +
          `counted here: a 429 means this loop asked faster than its budget allows, which ` +
          `is a fact about our pacing and not about the provider`,
      );
    }

    const dominant = this.dominantShape();
    if (dominant && dominant.count >= r.duplicate_signal_target_threshold) {
      return this.trip(
        'degenerate_loop',
        `${dominant.count} of the last ${this.shapes.length} hypotheses share the same ` +
          `signal and target (${dominant.key}), at or above the degeneracy threshold of ` +
          `${r.duplicate_signal_target_threshold} in ${r.duplicate_signal_target_window}. ` +
          `The loop is repeating rather than exploring, which manufactures a family of ` +
          `correlated tests for the multiple-testing correction to reject.`,
      );
    }

    return this.currentState;
  }

  private trip(reason: BreakerTripReason, detail: string): BreakerState {
    this.state = {
      tripped: true,
      reason,
      detail,
      tripped_at: this.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      day: this.counters.day,
    };
    return this.currentState;
  }

  /**
   * Manual reset. The spec requires that resuming after a trip is a deliberate
   * human action, so this is only ever called from the `/api/reset` endpoint and
   * records who asked.
   *
   * Consecutive failures reset with it: the operator is asserting the provider
   * situation has been dealt with. Daily counters do NOT reset, because a manual
   * resume must not restore spent budget.
   */
  reset(by: string): BreakerState {
    const previous = this.state;
    this.counters.consecutive_llm_failures = 0;
    this.shapes = [];
    this.state = {
      tripped: false,
      reason: null,
      detail: previous.tripped
        ? `manually reset by ${by}; previous trip was '${previous.reason}' at ${previous.tripped_at}`
        : `reset by ${by} (breaker was not tripped)`,
      tripped_at: null,
      day: this.counters.day,
    };
    return this.currentState;
  }
}
