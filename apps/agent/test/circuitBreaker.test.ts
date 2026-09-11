/**
 * The circuit breaker — the loop's emergency stop.
 *
 * The two counter kinds behave differently and the difference is the whole
 * design: DAILY counters reset at the UTC day boundary because they bound
 * spend, and CONSECUTIVE counters reset on success because three failures in a
 * row means the provider is down while three failures spread across an hour with
 * successes between them means nothing at all.
 *
 * The trip itself is the third thing: a trip is NOT cleared by the day rollover.
 * A breaker that reset itself overnight would defeat its own purpose, which is
 * to require a human decision.
 */

import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/circuit/breaker.js';
import { loadGatePolicy } from '../src/config.js';
import type { RTokenSymbol, SignalId } from '../src/types.js';

const POLICY = loadGatePolicy().data;
const R = POLICY.circuit_breaker;

const SHAPE: { signal: SignalId; target: RTokenSymbol } = {
  signal: 'btc_funding_rate',
  target: 'RCOINUSDT',
};

const TARGETS: RTokenSymbol[] = [
  'RCOINUSDT',
  'RNVDAUSDT',
  'RGOOGLUSDT',
  'RAAPLUSDT',
  'RAMZNUSDT',
  'RSPYUSDT',
  'RQQQUSDT',
];

/** A breaker on a clock the test controls. */
function breakerAt(iso: string): { b: CircuitBreaker; set: (next: string) => void } {
  let now = new Date(iso);
  const b = new CircuitBreaker(POLICY, () => now);
  return { b, set: (next: string) => { now = new Date(next); } };
}

describe('the preregistered limits', () => {
  it('are read from gate_policy.json rather than restated here', () => {
    expect(R.max_hypotheses_per_day).toBe(200);
    expect(R.max_promotes_per_day).toBe(10);
    expect(R.max_paper_orders_per_day).toBe(20);
    expect(R.duplicate_signal_target_window).toBe(5);
    expect(R.duplicate_signal_target_threshold).toBe(4);
    expect(R.max_consecutive_llm_failures).toBe(3);
    expect(R.max_log_entries_in_context).toBe(20);
  });

  it('exposes the context-window size the prompt builder needs', () => {
    expect(new CircuitBreaker(POLICY).maxLogEntriesInContext).toBe(R.max_log_entries_in_context);
  });
});

describe('max_hypotheses_per_day', () => {
  it('trips exactly AT the cap, not one past it', () => {
    // `>=`, not `>`. The cap is a budget: the two-hundredth attempt is the last
    // one permitted, and the check runs before the two-hundred-and-first.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_hypotheses_per_day - 1; i++) b.recordHypothesis();
    expect(b.check().tripped).toBe(false);

    b.recordHypothesis();
    const state = b.check();
    expect(state.tripped).toBe(true);
    expect(state.reason).toBe('max_hypotheses_per_day');
    expect(state.detail).toContain(String(R.max_hypotheses_per_day));
    expect(state.detail).toMatch(/daily hypothesis budget exhausted/);
  });

  it('counts INVALID proposals too, since recordHypothesis takes no validity flag', () => {
    // The multiple-testing correction counts every attempt, including kills and
    // schema rejections, so the daily budget must count them the same way.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_hypotheses_per_day; i++) b.recordHypothesis();
    expect(b.currentCounters.hypotheses_today).toBe(R.max_hypotheses_per_day);
  });
});

describe('max_promotes_per_day', () => {
  it('trips at the cap, and is checked after the hypothesis budget', () => {
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_promotes_per_day; i++) b.recordPromote();
    expect(b.check().reason).toBe('max_promotes_per_day');
  });

  it('does not trip one below the cap', () => {
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_promotes_per_day - 1; i++) b.recordPromote();
    expect(b.check().tripped).toBe(false);
  });
});

describe('max_paper_orders_per_day', () => {
  it('trips at the cap', () => {
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_paper_orders_per_day; i++) b.recordPaperOrder();
    expect(b.check().reason).toBe('max_paper_orders_per_day');
  });
});

describe('the daily rollover', () => {
  it('resets the daily counters when the UTC day changes', () => {
    const { b, set } = breakerAt('2026-09-11T23:00:00Z');
    for (let i = 0; i < 50; i++) b.recordHypothesis();
    expect(b.check().tripped).toBe(false);
    expect(b.currentCounters.day).toBe('2026-09-11');

    set('2026-09-12T00:30:00Z');
    expect(b.currentCounters.hypotheses_today).toBe(0);
    expect(b.currentCounters.day).toBe('2026-09-12');
    expect(b.check().tripped).toBe(false);
  });

  it('rolls on a READ, not only on a write', () => {
    // Without rolling in the getters, a status read at 00:30 UTC returns
    // yesterday's counters — the state is right in the loop and stale on every
    // path that REPORTS it, including GET /api/status and the frontend.
    const { b, set } = breakerAt('2026-09-11T23:00:00Z');
    for (let i = 0; i < 50; i++) b.recordHypothesis();
    set('2026-09-12T00:30:00Z');

    // No check(), no record*() — just a read.
    expect(b.currentCounters.hypotheses_today).toBe(0);
    expect(b.currentState.day).toBe('2026-09-12');
  });

  it('A TRIP SURVIVES the rollover — the counters reset, the trip does not', () => {
    // The single most important behaviour in this file. A breaker that cleared
    // itself overnight would silently resume a loop that something went wrong
    // in, which is the exact failure mode it exists to prevent.
    const { b, set } = breakerAt('2026-09-11T23:00:00Z');
    for (let i = 0; i < R.max_hypotheses_per_day; i++) b.recordHypothesis();
    const before = b.check();
    expect(before.tripped).toBe(true);
    expect(before.tripped_at).toBe('2026-09-11T23:00:00Z');

    set('2026-09-12T00:30:00Z');
    const after = b.check();
    expect(after.tripped).toBe(true);
    expect(after.reason).toBe('max_hypotheses_per_day');
    expect(after.tripped_at).toBe('2026-09-11T23:00:00Z');
    expect(after.detail).toBe(before.detail);
    // And the counters DID reset underneath it, so the two behaviours are
    // genuinely independent rather than one masking the other.
    expect(b.currentCounters.hypotheses_today).toBe(0);
  });

  it('keeps tripping after the rollover even though the day has a fresh budget', () => {
    const { b, set } = breakerAt('2026-09-11T23:00:00Z');
    for (let i = 0; i < R.max_hypotheses_per_day; i++) b.recordHypothesis();
    b.check();
    set('2026-09-12T00:30:00Z');
    // Recording on the new day still does not clear it.
    b.recordHypothesis();
    expect(b.check().tripped).toBe(true);
    expect(b.currentCounters.hypotheses_today).toBe(1);
  });

  it('does not roll backwards when the clock goes back within the same day', () => {
    const { b, set } = breakerAt('2026-09-11T12:00:00Z');
    for (let i = 0; i < 5; i++) b.recordHypothesis();
    set('2026-09-11T01:00:00Z');
    expect(b.currentCounters.hypotheses_today).toBe(5);
  });
});

describe('max_consecutive_llm_failures', () => {
  it('trips at the cap, and one below does not', () => {
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_consecutive_llm_failures - 1; i++) b.recordLlmFailure();
    expect(b.check().tripped).toBe(false);

    b.recordLlmFailure();
    expect(b.check().tripped).toBe(true);
    expect(b.check().reason).toBe('max_consecutive_llm_failures');
    expect(b.check().detail).toMatch(/the provider is down/);
  });

  it('does NOT trip on failures spread across successes', () => {
    // The counter is CONSECUTIVE, not total. Twenty failures interleaved with
    // twenty successes must never trip: nothing is wrong with the provider.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < 20; i++) {
      b.recordLlmFailure();
      b.recordLlmSuccess();
    }
    expect(b.check().tripped).toBe(false);
    expect(b.currentCounters.consecutive_llm_failures).toBe(0);
  });

  it('resets on success', () => {
    const b = new CircuitBreaker(POLICY);
    b.recordLlmFailure();
    b.recordLlmFailure();
    b.recordLlmSuccess();
    expect(b.currentCounters.consecutive_llm_failures).toBe(0);
  });

  it('is NOT reset by the clock', () => {
    // The daily counters roll; this one does not. Three failures at 23:59 and
    // three more at 00:01 is six consecutive failures, not two batches of three
    // — the provider is still down.
    const { b, set } = breakerAt('2026-09-11T23:59:00Z');
    b.recordLlmFailure();
    b.recordLlmFailure();
    set('2026-09-12T00:01:00Z');
    b.recordLlmFailure();
    expect(b.currentCounters.consecutive_llm_failures).toBe(3);
    expect(b.check().tripped).toBe(true);
    expect(b.check().reason).toBe('max_consecutive_llm_failures');
  });

  it('is checked after the three daily budgets', () => {
    // Ordering is deliberate: "the day's budget is gone" is a more actionable
    // thing to surface than "the provider is down", because it is a decision the
    // operator can act on without waiting for anyone else.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_consecutive_llm_failures; i++) b.recordLlmFailure();
    for (let i = 0; i < R.max_hypotheses_per_day; i++) b.recordHypothesis();
    expect(b.check().reason).toBe('max_hypotheses_per_day');
  });
});

describe('degenerate_loop', () => {
  it('trips at 4 of the last 5 sharing a signal+target pair', () => {
    // The degeneracy check does not look at one hypothesis, it looks at the
    // RECENT SHAPE of the session. Repeating rather than exploring manufactures
    // a family of correlated tests for BH to reject, and it is better to stop
    // the loop than to let it manufacture them.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.duplicate_signal_target_threshold - 1; i++) b.recordHypothesis(SHAPE);
    expect(b.check().tripped).toBe(false);

    b.recordHypothesis(SHAPE);
    const state = b.check();
    expect(state.tripped).toBe(true);
    expect(state.reason).toBe('degenerate_loop');
    expect(state.detail).toContain('btc_funding_rate -> RCOINUSDT');
    // The window had only four entries at that point, so the detail says four —
    // it reports the window as it stands rather than the configured size.
    expect(state.detail).toContain('4 of the last 4');
    expect(state.detail).toContain('degeneracy threshold of 4 in 5');
  });

  it('does not trip on three of five', () => {
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < 3; i++) b.recordHypothesis(SHAPE);
    b.recordHypothesis({ signal: 'btc_funding_rate', target: 'RNVDAUSDT' });
    b.recordHypothesis({ signal: 'btc_funding_rate', target: 'RGOOGLUSDT' });
    expect(b.check().tripped).toBe(false);
  });

  it('never trips on varied shapes, however many are recorded', () => {
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < 100; i++) {
      b.recordHypothesis({ signal: 'btc_funding_rate', target: TARGETS[i % TARGETS.length]! });
    }
    expect(b.check().tripped).toBe(false);
  });

  it('forgets repeats once the window has slid past them', () => {
    // The window is the LAST five, so three repeats followed by three distinct
    // proposals leaves the window free of them. Without the sliding window the
    // breaker would trip on history it no longer describes.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < 3; i++) b.recordHypothesis({ signal: 'eth_funding_rate', target: 'RSPYUSDT' });
    for (const target of ['RCOINUSDT', 'RNVDAUSDT', 'RGOOGLUSDT'] as RTokenSymbol[]) {
      b.recordHypothesis({ signal: 'eth_funding_rate', target });
    }
    expect(b.check().tripped).toBe(false);
  });

  it('counts by PAIR, so the same signal on different targets is not degenerate', () => {
    const b = new CircuitBreaker(POLICY);
    for (const target of TARGETS.slice(0, 5)) {
      b.recordHypothesis({ signal: 'btc_funding_rate', target });
    }
    expect(b.check().tripped).toBe(false);
  });

  it('counts by pair, so the same target on different signals is not degenerate either', () => {
    const b = new CircuitBreaker(POLICY);
    const signals: SignalId[] = [
      'btc_funding_rate',
      'eth_funding_rate',
      'btc_spot_return',
      'eth_spot_return',
      'btc_funding_x_spot',
    ];
    for (const signal of signals) b.recordHypothesis({ signal, target: 'RCOINUSDT' });
    expect(b.check().tripped).toBe(false);
  });

  it('detects the dominant pair even when it is not the only one in the window', () => {
    const b = new CircuitBreaker(POLICY);
    b.recordHypothesis({ signal: 'btc_funding_rate', target: 'RCOINUSDT' });
    b.recordHypothesis({ signal: 'btc_funding_rate', target: 'RCOINUSDT' });
    b.recordHypothesis({ signal: 'eth_funding_rate', target: 'RSPYUSDT' });
    b.recordHypothesis({ signal: 'btc_funding_rate', target: 'RCOINUSDT' });
    b.recordHypothesis({ signal: 'btc_funding_rate', target: 'RCOINUSDT' });
    const state = b.check();
    expect(state.tripped).toBe(true);
    expect(state.reason).toBe('degenerate_loop');
    expect(state.detail).toContain('btc_funding_rate -> RCOINUSDT');
    expect(state.detail).toContain('4 of the last 5');
  });

  it('ignores hypotheses recorded with no shape', () => {
    // The shape is optional because a proposal can be recorded before it has
    // been parsed. Those records still count against the daily budget but must
    // not fabricate a degeneracy signal.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < 10; i++) b.recordHypothesis();
    expect(b.check().tripped).toBe(false);
    expect(b.currentCounters.hypotheses_today).toBe(10);
  });

  it('is checked only after the daily budgets', () => {
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_hypotheses_per_day; i++) b.recordHypothesis(SHAPE);
    expect(b.check().reason).toBe('max_hypotheses_per_day');
  });
});

describe('check() is idempotent and sticky', () => {
  it('returns the SAME state on repeated calls', () => {
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_hypotheses_per_day; i++) b.recordHypothesis();
    const first = b.check();
    const second = b.check();
    expect(second).toEqual(first);
    expect(second.tripped_at).toBe(first.tripped_at);
  });

  it('does not re-trip with a different reason once tripped', () => {
    // Once tripped the breaker short-circuits, so the FIRST reason is the one
    // recorded — a later, noisier condition cannot overwrite it.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_hypotheses_per_day; i++) b.recordHypothesis();
    b.check();
    for (let i = 0; i < R.max_consecutive_llm_failures; i++) b.recordLlmFailure();
    expect(b.check().reason).toBe('max_hypotheses_per_day');
  });

  it('never reports a reason without a trip', () => {
    const b = new CircuitBreaker(POLICY);
    const state = b.check();
    expect(state.tripped).toBe(false);
    expect(state.reason).toBeNull();
    expect(state.tripped_at).toBeNull();
    expect(state.detail).toBe('');
  });

  it('stamps tripped_at with milliseconds stripped, matching the log', () => {
    const now = new Date('2026-09-11T12:34:56.789Z');
    const b = new CircuitBreaker(POLICY, () => now);
    for (let i = 0; i < R.max_hypotheses_per_day; i++) b.recordHypothesis();
    expect(b.check().tripped_at).toBe('2026-09-11T12:34:56Z');
  });
});

describe('manual reset', () => {
  it('clears the trip and records who asked', () => {
    // Resuming after a trip must be a deliberate human action, so the reset is
    // only ever reachable from the /api/reset endpoint and it names the operator.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_hypotheses_per_day; i++) b.recordHypothesis();
    b.check();

    const after = b.reset('temmy');
    expect(after.tripped).toBe(false);
    expect(after.reason).toBeNull();
    expect(after.tripped_at).toBeNull();
    expect(after.detail).toContain('temmy');
    expect(after.detail).toContain('max_hypotheses_per_day');
  });

  it('does NOT restore spent budget, so it re-trips immediately', () => {
    // A manual resume must not hand back the day's spend. The counters are the
    // budget; clearing the trip is not the same as clearing the day.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_hypotheses_per_day; i++) b.recordHypothesis();
    b.check();
    b.reset('temmy');
    expect(b.currentCounters.hypotheses_today).toBe(R.max_hypotheses_per_day);
    expect(b.check().tripped).toBe(true);
    expect(b.check().reason).toBe('max_hypotheses_per_day');
  });

  it('DOES clear the consecutive-failure counter and the shape window', () => {
    // The operator is asserting the provider situation has been dealt with, so
    // the failure streak goes with it.
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.max_consecutive_llm_failures; i++) b.recordLlmFailure();
    expect(b.check().tripped).toBe(true);

    b.reset('temmy');
    expect(b.currentCounters.consecutive_llm_failures).toBe(0);
    expect(b.check().tripped).toBe(false);
  });

  it('clears degeneracy by emptying the shape window', () => {
    const b = new CircuitBreaker(POLICY);
    for (let i = 0; i < R.duplicate_signal_target_threshold; i++) b.recordHypothesis(SHAPE);
    expect(b.check().reason).toBe('degenerate_loop');

    b.reset('temmy');
    expect(b.check().tripped).toBe(false);
    // A single new proposal must not immediately re-trip on the old window.
    b.recordHypothesis(SHAPE);
    expect(b.check().tripped).toBe(false);
  });

  it('says plainly when the breaker was not tripped', () => {
    const b = new CircuitBreaker(POLICY);
    const after = b.reset('temmy');
    expect(after.detail).toContain('breaker was not tripped');
    expect(after.tripped).toBe(false);
  });

  it('does not reset the daily counters, so the day label is unchanged', () => {
    const { b } = breakerAt('2026-09-11T10:00:00Z');
    for (let i = 0; i < 10; i++) b.recordHypothesis();
    const after = b.reset('temmy');
    expect(after.day).toBe('2026-09-11');
    expect(b.currentCounters.promotes_today).toBe(0);
  });
});
