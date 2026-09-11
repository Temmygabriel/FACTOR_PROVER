/**
 * The Execution Guard — the last thing between a promoted factor and an order.
 *
 * The tests are organised around the asymmetry the design rests on, because it is
 * the part a later "simplification" would most plausibly break:
 *
 *   REFUSE  what cannot be verified (no flag, no slot, no price, no acceptance)
 *   CLIP    what is merely too big (CHECK 3, and only CHECK 3)
 *
 * Every dependency is injected — clock, env, position count, price source and
 * Agent Hub client — so nothing here opens a socket. The real `fetchSpotPrice`
 * is never reached; a test that let it through would be a test that hits Bitget.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExecutionGuard,
  type AgentHubClient,
  type GuardDeps,
  type OrderIntent,
} from '../src/execution/guard.js';
import { loadGatePolicy, type GatePolicy } from '../src/config.js';

const POLICY = loadGatePolicy().data;
const G = POLICY.execution_guard;
const ENV = { BITGET_PAPER_TRADING: 'true' };

const ORDER: OrderIntent = {
  symbol: 'RCOINUSDT',
  side: 'buy',
  notional_usdt: 50,
  entry_price: 100,
  factor_id: 'F-001',
  hypothesis_id: 'H-0001',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A price source that always answers `price`, never touching the network. */
function priceAt(
  price: number,
): (symbol: string) => Promise<{ symbol: string; price: number; raw: string; fetched_at: string }> {
  return async (symbol: string) => ({
    symbol,
    price,
    raw: String(price),
    fetched_at: '2026-09-11T00:00:00Z',
  });
}

/** The spec's two-phase hub: refuses the unconfirmed call, accepts the confirmed one. */
function twoPhaseHub(orderId = 'PAPER-777'): { calls: Array<{ confirm: boolean; notional: number }> } & AgentHubClient {
  const calls: Array<{ confirm: boolean; notional: number }> = [];
  const hub: AgentHubClient = {
    async placeOrder(order, { confirm }) {
      calls.push({ confirm, notional: order.notional_usdt });
      return confirm
        ? { confirmationRequired: false, accepted: true, orderId, detail: 'accepted' }
        : {
            confirmationRequired: true,
            accepted: false,
            orderId: null,
            detail: 'confirmation required',
          };
    },
  };
  return { calls, ...hub };
}

/** A guard with a signed-off flag, an empty book and a live price, unless overridden. */
function guard(over: Partial<GuardDeps> = {}, policy: GatePolicy = POLICY): ExecutionGuard {
  return new ExecutionGuard(
    { getOpenPositions: () => 0, getPrice: priceAt(100), env: { ...ENV }, ...over },
    policy,
  );
}

describe('the preregistered execution policy', () => {
  it('is read from gate_policy.json rather than restated here', () => {
    expect(G.max_open_positions).toBe(3);
    expect(G.max_order_usdt).toBe(100);
    expect(G.price_sanity_band_pct).toBe(2.0);
    expect(G.require_paper_trading_flag).toBe(true);
    expect(G.require_confirm).toBe(true);
  });
});

describe('CHECK 1 — the paper trading flag', () => {
  // Every one of these is a value a deployment might plausibly set and then
  // believe. A truthy-but-not-"true" value that passed would be the single most
  // dangerous bug in the project, so the list is deliberately pedantic: if any
  // one of them is ever relaxed, this loop is where it shows up.
  const REJECTED: Array<string | undefined> = [
    undefined,
    '',
    'false',
    'TRUE',
    'True',
    '1',
    '0',
    'yes',
    'true ',
    ' true',
    'true\n',
  ];

  for (const value of REJECTED) {
    it(`refuses ${JSON.stringify(value)}`, async () => {
      const out = await guard({ env: { BITGET_PAPER_TRADING: value } }).evaluate(ORDER);
      expect(out.allowed).toBe(false);
      expect(out.refused_at).toBe('CHECK_1_PAPER_TRADING_FLAG');
      expect(out.refused_reason).toBe('paper_trading_flag_not_true');
      expect(out.detail).toMatch(/must be exactly the string "true"/);
    });
  }

  it('names the offending value in the refusal', async () => {
    // "It refuses" is not enough for an operator to act on; the record has to say
    // what the deployment actually set.
    const out = await guard({ env: { BITGET_PAPER_TRADING: 'TRUE' } }).evaluate(ORDER);
    expect(out.detail).toContain(JSON.stringify('TRUE'));
  });

  it('says "unset" rather than printing undefined when the variable is missing', async () => {
    // `undefined` in a log reads like a bug in the logger; "unset" reads like a
    // missing configuration, which is what it is.
    const out = await guard({ env: {} }).evaluate(ORDER);
    expect(out.detail).toContain('unset');
    expect(out.detail).not.toContain('undefined');
  });

  it('accepts exactly the string "true"', async () => {
    const out = await guard().evaluate(ORDER);
    expect(out.checks[0]).toEqual({
      check: 'CHECK_1_PAPER_TRADING_FLAG',
      passed: true,
      detail: 'BITGET_PAPER_TRADING === "true"',
    });
  });

  it('runs BEFORE anything that touches the network', async () => {
    // The ordering is the safety property. A refusal that still leaked a price
    // request would mean the check is a report rather than a gate.
    let priceAsked = false;
    const out = await guard({
      env: {},
      getPrice: async (s) => {
        priceAsked = true;
        return priceAt(100)(s);
      },
    }).evaluate(ORDER);
    expect(out.allowed).toBe(false);
    expect(priceAsked).toBe(false);
  });

  it('reads the environment at evaluate() time, so a runtime flip is honoured', async () => {
    // The flag is read per order rather than cached at construction: an operator
    // who fixes the deployment should not have to restart the process.
    const env: Record<string, string | undefined> = { BITGET_PAPER_TRADING: 'false' };
    const g = guard({ env });
    expect((await g.evaluate(ORDER)).refused_at).toBe('CHECK_1_PAPER_TRADING_FLAG');

    env['BITGET_PAPER_TRADING'] = 'true';
    expect((await g.evaluate(ORDER)).refused_at).not.toBe('CHECK_1_PAPER_TRADING_FLAG');
  });

  it('falls back to process.env when no env is injected', async () => {
    vi.stubEnv('BITGET_PAPER_TRADING', 'true');
    const g = new ExecutionGuard({ getOpenPositions: () => 0, getPrice: priceAt(100) }, POLICY);
    expect((await g.evaluate(ORDER)).checks[0]!.passed).toBe(true);
  });

  it('cannot be disabled by the policy flag — the check is not optional', async () => {
    // `require_paper_trading_flag` is a declaration that the gate is required, not
    // a switch that turns it off. Flipping it must leave the guard refusing,
    // because the fail-safe direction for "am I allowed to trade for real" is
    // always "no".
    const lax = { ...POLICY, execution_guard: { ...G, require_paper_trading_flag: false } };
    const out = await guard({ env: {} }, lax as GatePolicy).evaluate(ORDER);
    expect(out.allowed).toBe(false);
    expect(out.refused_at).toBe('CHECK_1_PAPER_TRADING_FLAG');
  });
});

describe('CHECK 2 — the position cap REFUSES, it does not clip', () => {
  it('admits at the cap minus one and refuses AT the cap', async () => {
    // `open + 1 > cap` refuses, so with a cap of 3 the third order is the last one
    // that fits and the fourth is refused.
    const at = await guard({ getOpenPositions: () => G.max_open_positions - 1 }).evaluate(ORDER);
    expect(at.allowed).toBe(true);

    const over = await guard({ getOpenPositions: () => G.max_open_positions }).evaluate(ORDER);
    expect(over.allowed).toBe(false);
    expect(over.refused_at).toBe('CHECK_2_POSITION_CAP');
    expect(over.refused_reason).toBe('position_cap_exceeded');
  });

  it('refuses a ONE-CENT order when the book is full', async () => {
    // The asymmetry with CHECK 3 in one test: a smaller order does not free a
    // slot, so shrinking is not a remedy and the guard must not pretend it is.
    const hub = twoPhaseHub();
    const out = await guard({ getOpenPositions: () => G.max_open_positions, hub }).evaluate({
      ...ORDER,
      notional_usdt: 0.01,
    });
    expect(out.allowed).toBe(false);
    expect(out.refused_at).toBe('CHECK_2_POSITION_CAP');
    expect(hub.calls).toHaveLength(0);
  });

  it('explains that clipping would not help', async () => {
    const out = await guard({ getOpenPositions: () => 99 }).evaluate(ORDER);
    expect(out.detail).toMatch(/Refused rather than clipped/);
    expect(out.detail).toContain(String(G.max_open_positions));
  });
});

describe('CHECK 3 — the size cap CLIPS, and the clipped order is the one that ships', () => {
  it('allows an oversized order and returns the CLIPPED notional', async () => {
    const out = await guard().evaluate({ ...ORDER, notional_usdt: G.max_order_usdt + 500 });
    expect(out.allowed).toBe(true);
    expect(out.order.notional_usdt).toBe(G.max_order_usdt);
  });

  it('records the clip as an amendment carrying the original size', async () => {
    // Without the `from` value the log would show a 100 USDT order where the
    // session asked for 600, and no reader could tell a clip from a small order.
    const out = await guard().evaluate({ ...ORDER, notional_usdt: 600 });
    const amended = out.checks.find((c) => c.amendment);
    expect(amended?.check).toBe('CHECK_3_SIZE_CAP');
    expect(amended?.amendment).toEqual({
      field: 'notional_usdt',
      from: 600,
      to: G.max_order_usdt,
    });
    expect(amended?.passed).toBe(true);
  });

  it('leaves an at-cap order untouched and unamended', async () => {
    // The boundary is inclusive: exactly the cap is not a clip.
    const out = await guard().evaluate({ ...ORDER, notional_usdt: G.max_order_usdt });
    expect(out.order.notional_usdt).toBe(G.max_order_usdt);
    expect(out.checks.some((c) => c.amendment)).toBe(false);
  });

  it('does not mutate the caller’s intent object', async () => {
    // The returned order is a copy; a caller holding the original must not find it
    // silently rewritten to a different size.
    const intent: OrderIntent = { ...ORDER, notional_usdt: 99999 };
    const out = await guard().evaluate(intent);
    expect(intent.notional_usdt).toBe(99999);
    expect(out.order.notional_usdt).toBe(G.max_order_usdt);
  });

  it('sends the CLIPPED notional to the hub, never the requested one', async () => {
    // THE test for this check. The amendment is evidence; the transmitted order is
    // the thing that costs money.
    const hub = twoPhaseHub();
    await guard({ hub }).evaluate({ ...ORDER, notional_usdt: 99999 });
    expect(hub.calls.length).toBeGreaterThan(0);
    expect(hub.calls.every((c) => c.notional === G.max_order_usdt)).toBe(true);
  });

  for (const bad of [0, -5, NaN, Infinity, -Infinity]) {
    it(`refuses the non-positive / non-finite notional ${JSON.stringify(bad)}`, async () => {
      // A NaN notional compared against the cap is false, so without this
      // precondition a NaN order would sail through the clip untouched.
      const out = await guard().evaluate({ ...ORDER, notional_usdt: bad });
      expect(out.allowed).toBe(false);
      expect(out.refused_reason).toBe('order_notional_invalid');
      expect(out.refused_at).toBe('CHECK_3_SIZE_CAP');
    });
  }
});

describe('CHECK 4 — the price band, and the refusal to guess', () => {
  const BAND = G.price_sanity_band_pct;

  const CASES: Array<{ entry: number; live: number; allowed: boolean; label: string }> = [
    { entry: 100, live: 100, allowed: true, label: 'exact match' },
    { entry: 100 * (1 + BAND / 200), live: 100, allowed: true, label: 'half the band' },
    { entry: 100 * (1 + BAND / 100), live: 100, allowed: true, label: 'exactly at the band edge' },
    { entry: 100 * (1 - BAND / 100), live: 100, allowed: true, label: 'exactly at the lower edge' },
    { entry: 100 * (1 + BAND / 100) + 0.01, live: 100, allowed: false, label: 'just above the band' },
    { entry: 100 * (1 - BAND / 100) - 0.01, live: 100, allowed: false, label: 'just below the band' },
    { entry: 200, live: 100, allowed: false, label: 'far above' },
    { entry: 1, live: 100, allowed: false, label: 'far below' },
  ];

  for (const c of CASES) {
    it(`${c.allowed ? 'admits' : 'refuses'} entry ${c.entry.toFixed(4)} against a live ${c.live} — ${c.label}`, async () => {
      const out = await guard({ getPrice: priceAt(c.live) }).evaluate({ ...ORDER, entry_price: c.entry });
      expect(out.allowed).toBe(c.allowed);
    });
  }

  it('uses a centred band, not a one-sided one', async () => {
    // A stale signal can be stale in either direction. A band that only caught
    // upward gaps would admit a price the market has since halved.
    const out = await guard({ getPrice: priceAt(100) }).evaluate({ ...ORDER, entry_price: 50 });
    expect(out.refused_reason).toBe('price_outside_sanity_band');
  });

  it('REFUSES when the live price cannot be fetched', async () => {
    // "Unverifiable" is not "fine". This is the branch the whole file exists for.
    const out = await guard({
      getPrice: async () => {
        throw new Error('network down');
      },
    }).evaluate(ORDER);
    expect(out.allowed).toBe(false);
    expect(out.refused_at).toBe('CHECK_4_PRICE_SANITY');
    expect(out.refused_reason).toBe('live_price_unavailable');
    expect(out.detail).toContain('network down');
    expect(out.detail).toMatch(/unverifiable price is not a passed check/);
  });

  it('survives a non-Error throw', async () => {
    const out = await guard({
      getPrice: async () => {
        throw 'socket closed';
      },
    }).evaluate(ORDER);
    expect(out.refused_reason).toBe('live_price_unavailable');
    expect(out.detail).toContain('socket closed');
  });

  it('says a band breach usually means a STALE SIGNAL, not a moved market', async () => {
    // The distinction changes what the operator does next: one is a data problem,
    // the other is a market event.
    const out = await guard({ getPrice: priceAt(100) }).evaluate({ ...ORDER, entry_price: 200 });
    expect(out.detail).toMatch(/STALE/);
    expect(out.detail).toContain('2%');
  });

  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    it(`refuses the non-positive / non-finite entry price ${JSON.stringify(bad)}`, async () => {
      // A zero entry price would produce an infinite deviation; a NaN one would
      // produce a NaN comparison that is false and therefore silently a pass.
      const out = await guard({ getPrice: priceAt(100) }).evaluate({ ...ORDER, entry_price: bad });
      expect(out.allowed).toBe(false);
      expect(out.refused_reason).toBe('entry_price_invalid');
      expect(out.refused_at).toBe('CHECK_4_PRICE_SANITY');
    });
  }
});

describe('CHECK 5 — the two-phase confirmation', () => {
  it('records BOTH attempts separately when the hub implements the flow', async () => {
    // The spec requires the re-issuance to be logged in its own right. A single
    // "accepted" line would hide whether the two-step dance happened at all.
    const hub = twoPhaseHub();
    const out = await guard({ hub }).evaluate(ORDER);

    expect(out.allowed).toBe(true);
    expect(out.hub_attempts).toHaveLength(2);
    expect(out.hub_attempts[0]).toMatchObject({
      phase: 'initial',
      requested_confirm_flag: false,
      confirmation_required: true,
      accepted: false,
      order_id: null,
    });
    expect(out.hub_attempts[1]).toMatchObject({
      phase: 'confirmed',
      requested_confirm_flag: true,
      confirmation_required: false,
      accepted: true,
      order_id: 'PAPER-777',
    });
    expect(out.checks.find((c) => c.check === 'CHECK_5_CONFIRMATION')?.detail).toContain('PAPER-777');
    expect(out.detail).toContain('PAPER-777');
  });

  it('sends the FIRST call unconfirmed and the second confirmed, in that order', async () => {
    const hub = twoPhaseHub();
    await guard({ hub }).evaluate(ORDER);
    expect(hub.calls.map((c) => c.confirm)).toEqual([false, true]);
  });

  it('refuses the order when the CONFIRMED call is refused', async () => {
    const hub: AgentHubClient = {
      async placeOrder(_o: OrderIntent, { confirm }: { confirm: boolean }) {
        return confirm
          ? { confirmationRequired: false, accepted: false, orderId: null, detail: 'insufficient balance' }
          : { confirmationRequired: true, accepted: false, orderId: null, detail: 'confirm needed' };
      },
    };
    const out = await guard({ hub }).evaluate(ORDER);
    expect(out.allowed).toBe(false);
    expect(out.refused_at).toBe('CHECK_5_CONFIRMATION');
    expect(out.refused_reason).toBe('agent_hub_refused');
    expect(out.detail).toContain('insufficient balance');
    // Both attempts are still evidence, including the one that failed.
    expect(out.hub_attempts).toHaveLength(2);
  });

  it('refuses a hub response that is neither accepted nor asking for confirmation', async () => {
    // A malformed response is not a partial success. There is no branch here that
    // reads "it did not say no".
    const hub: AgentHubClient = {
      async placeOrder() {
        return { confirmationRequired: false, accepted: false, orderId: null, detail: 'weird' };
      },
    };
    const out = await guard({ hub }).evaluate(ORDER);
    expect(out.allowed).toBe(false);
    expect(out.refused_reason).toBe('agent_hub_refused');
    expect(out.detail).toContain('weird');
    expect(out.hub_attempts).toHaveLength(1);
  });

  it('allows a hub that accepts on the first call, but records it as a DEVIATION', async () => {
    // Legal, but it means the client does not implement the two-phase flow the
    // spec describes. Reporting that as a clean pass would misdescribe the run.
    const hub: AgentHubClient = {
      async placeOrder() {
        return { confirmationRequired: false, accepted: true, orderId: 'PAPER-1', detail: 'ok' };
      },
    };
    const out = await guard({ hub }).evaluate(ORDER);
    expect(out.allowed).toBe(true);
    expect(out.hub_attempts).toHaveLength(1);
    expect(out.hub_attempts[0]!.phase).toBe('initial');
    const c5 = out.checks.find((c) => c.check === 'CHECK_5_CONFIRMATION');
    expect(c5?.detail).toMatch(/deviation/);
    expect(out.detail).toMatch(/single-phase/);
  });

  it('validates but does NOT send when no hub is configured', async () => {
    // "We would have traded" and "we traded" are different claims, and only one of
    // them is true here.
    const out = await guard().evaluate(ORDER);
    expect(out.allowed).toBe(true);
    expect(out.hub_attempts).toHaveLength(0);
    expect(out.detail).toContain('NOT sent');
    expect(out.checks.find((c) => c.check === 'CHECK_5_CONFIRMATION')?.detail).toMatch(
      /validated but NOT sent/,
    );
  });

  it('names a paper order id when the hub does not supply one', async () => {
    const hub = twoPhaseHub();
    const noId: AgentHubClient = {
      async placeOrder(o: OrderIntent, opts: { confirm: boolean }) {
        const r = await hub.placeOrder(o, opts);
        return { ...r, orderId: null };
      },
    };
    const out = await guard({ hub: noId }).evaluate(ORDER);
    expect(out.allowed).toBe(true);
    expect(out.detail).toContain('(no id)');
  });

  it('notes the skipped two-phase flow when the policy disables require_confirm', async () => {
    // `require_confirm: false` is recorded rather than silent — a skipped check
    // that is not logged reads identically to a passed one. Note what the code
    // actually does, though: the detail says the flow is "SKIPPED … sent in a
    // single confirmed call", but with a hub present the guard still issues the
    // unconfirmed call first. The note is right that the check was waived; the
    // sentence overstates the effect.
    const lax = { ...POLICY, execution_guard: { ...G, require_confirm: false } };
    const hub = twoPhaseHub();
    const out = await guard({ hub }, lax as GatePolicy).evaluate(ORDER);
    const c5 = out.checks.find((c) => c.check === 'CHECK_5_CONFIRMATION');
    expect(c5?.detail).toMatch(/require_confirm is false in policy/);
    expect(out.allowed).toBe(true);
    expect(hub.calls.map((c) => c.confirm)).toEqual([false, true]);
  });
});

describe('the checks run IN SEQUENCE and the first failure stops the rest', () => {
  it('reports only CHECK 1 when the flag is bad, the book is full and the order is huge', async () => {
    const out = await guard({ getOpenPositions: () => 99, env: {} }).evaluate({
      ...ORDER,
      notional_usdt: 99999,
    });
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]!.check).toBe('CHECK_1_PAPER_TRADING_FLAG');
    expect(out.refused_at).toBe('CHECK_1_PAPER_TRADING_FLAG');
  });

  it('reports CHECK 1 and CHECK 2, and no CHECK 3, when the book is full', async () => {
    // A later check never runs against an order an earlier one refused, so a
    // refusal can never be masked by a subsequent pass.
    const out = await guard({ getOpenPositions: () => 99 }).evaluate({
      ...ORDER,
      notional_usdt: 99999,
    });
    expect(out.checks.map((c) => c.check)).toEqual(['CHECK_1_PAPER_TRADING_FLAG', 'CHECK_2_POSITION_CAP']);
    expect(out.refused_at).toBe('CHECK_2_POSITION_CAP');
  });

  it('stops at CHECK 4 with CHECK 3 already recorded', async () => {
    const out = await guard({
      getPrice: async () => {
        throw new Error('down');
      },
    }).evaluate({ ...ORDER, notional_usdt: 500 });
    expect(out.checks.map((c) => c.check)).toEqual([
      'CHECK_1_PAPER_TRADING_FLAG',
      'CHECK_2_POSITION_CAP',
      'CHECK_3_SIZE_CAP',
      'CHECK_4_PRICE_SANITY',
    ]);
    // The clip happened before the refusal, and it is still recorded — the order
    // shown to the operator is the one that was about to be sent.
    expect(out.order.notional_usdt).toBe(G.max_order_usdt);
    expect(out.checks[2]!.amendment?.to).toBe(G.max_order_usdt);
  });

  it('labels the notional precondition CHECK_3_SIZE_CAP even though it runs before CHECK 2', async () => {
    // The precondition is not one of the spec's five checks; it is filed under the
    // size-cap check it protects. The consequence to know about is that a
    // notional refusal produces a sequence with no CHECK_2 entry at all.
    const out = await guard().evaluate({ ...ORDER, notional_usdt: NaN });
    expect(out.checks.map((c) => c.check)).toEqual(['CHECK_1_PAPER_TRADING_FLAG', 'CHECK_3_SIZE_CAP']);
    expect(out.checks[1]!.passed).toBe(false);
  });

  it('labels the entry-price precondition CHECK_4_PRICE_SANITY', async () => {
    const out = await guard().evaluate({ ...ORDER, entry_price: NaN });
    expect(out.checks.map((c) => c.check)).toEqual(['CHECK_1_PAPER_TRADING_FLAG', 'CHECK_4_PRICE_SANITY']);
  });

  it('reports all five checks in order on a clean two-phase pass', async () => {
    const out = await guard({ hub: twoPhaseHub() }).evaluate(ORDER);
    expect(out.checks.map((c) => c.check)).toEqual([
      'CHECK_1_PAPER_TRADING_FLAG',
      'CHECK_2_POSITION_CAP',
      'CHECK_3_SIZE_CAP',
      'CHECK_4_PRICE_SANITY',
      'CHECK_5_CONFIRMATION',
    ]);
    expect(out.checks.every((c) => c.passed)).toBe(true);
    expect(out.refused_at).toBeNull();
    expect(out.refused_reason).toBeNull();
  });
});

describe('the outcome shape', () => {
  it('never reports a refusal reason without a refusal point', async () => {
    const out = await guard({ env: {} }).evaluate(ORDER);
    expect(out.refused_at).not.toBeNull();
    expect(out.refused_reason).not.toBeNull();
  });

  it('never reports a refusal point on an allowed order', async () => {
    const out = await guard().evaluate(ORDER);
    expect(out.refused_at).toBeNull();
    expect(out.refused_reason).toBeNull();
  });

  it('does not call the hub at all when an earlier check refuses', async () => {
    const hub = twoPhaseHub();
    await guard({ hub, getOpenPositions: () => G.max_open_positions }).evaluate(ORDER);
    expect(hub.calls).toHaveLength(0);
  });

  it('is deterministic for the same inputs', async () => {
    // No clock, no randomness, no network: the same order and the same injected
    // deps must produce a byte-identical outcome, because the outcome is hashed
    // into the decision log.
    const a = await guard({ hub: twoPhaseHub() }).evaluate(ORDER);
    const b = await guard({ hub: twoPhaseHub() }).evaluate(ORDER);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('honours injected policy limits rather than the committed file', async () => {
    // The limits are DATA. A guard that read the constants directly could not be
    // exercised at its boundary without editing the preregistration.
    const tight = {
      ...POLICY,
      execution_guard: { ...G, max_open_positions: 1, max_order_usdt: 10, price_sanity_band_pct: 0.5 },
    };
    const out = await guard({ getOpenPositions: () => 1 }, tight as GatePolicy).evaluate(ORDER);
    expect(out.refused_at).toBe('CHECK_2_POSITION_CAP');

    // The same 50 USDT order that the committed policy admits is over a 10 USDT
    // cap, so it clips to the injected limit and not to the file's 100.
    const clipped = await guard({}, tight as GatePolicy).evaluate(ORDER);
    expect(clipped.allowed).toBe(true);
    expect(clipped.order.notional_usdt).toBe(10);
  });
});
