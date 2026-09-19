/**
 * Execution Guard — the last thing between a promoted factor and a real order.
 *
 * SPEC RULE 4: no order reaches Bitget Agent Hub unless it passes all five
 * checks, in sequence, in a standalone module with no LLM involvement.
 *
 * The design principle that governs this file: A REFUSAL MUST BE THE CHEAP
 * OUTCOME. Every ambiguous case refuses. Every unverifiable case refuses. The
 * guard has no "probably fine" branch, because the cost of a wrongly refused
 * paper order is a line in a log, and the cost of a wrongly sent one is the
 * claim the whole submission rests on.
 *
 * The five checks, and the specific way each can be got wrong:
 *
 *   CHECK 1 — Paper trading flag. `BITGET_PAPER_TRADING` must be exactly the
 *   string "true". Not truthy, not case-insensitive, not trimmed. This is the
 *   one check whose failure means real money, so it is checked FIRST, before
 *   anything that touches the network, and it is checked against the raw env
 *   value rather than a parsed boolean — a deployment that sets
 *   BITGET_PAPER_TRADING=1 is a deployment that has not thought about it, and
 *   "1" is not an instruction to trade.
 *
 *   CHECK 2 — Position cap. Open positions plus this order must not exceed the
 *   cap. Note the asymmetry with CHECK 3: exceeding the position cap REFUSES,
 *   because you cannot fix "too many positions" by shrinking the order you were
 *   about to add.
 *
 *   CHECK 3 — Size cap. Per spec, this CLIPS rather than refuses, and logs the
 *   clip. A clip changes the order, so the amended order is what gets returned
 *   and what gets sent — never the original.
 *
 *   CHECK 4 — Price sanity. The order's entry price must be within the band of
 *   the live price. A failure here usually means the signal is stale rather than
 *   that the price moved, which is why the refusal says so. If the live price
 *   cannot be fetched, the check REFUSES: an unverifiable price is not a passed
 *   check.
 *
 *   CHECK 5 — Confirmation. The Agent Hub call is issued without confirmation
 *   first; if the SDK answers `confirmationRequired`, the system re-issues with
 *   explicit confirmation. The spec requires the re-issuance to be logged
 *   separately, so the outcome carries both attempts rather than just the
 *   final one — the two-step dance is part of the evidence, not a detail.
 *
 * The guard is a pure function of its inputs plus three injected dependencies
 * (clock, price source, position count), so every branch above is testable
 * without a network and without an exchange account.
 */

import { loadGatePolicy, type GatePolicy } from '../config.js';
import { fetchSpotPrice, type PriceQuote } from './prices.js';

// ---------------------------------------------------------------------------
// Order intent
// ---------------------------------------------------------------------------

export type OrderSide = 'buy' | 'sell';

export interface OrderIntent {
  symbol: string;
  side: OrderSide;
  /**
   * Order size in USDT. This is the notional, not a quantity — the guard caps
   * notional because that is the number a human sets a limit on.
   */
  notional_usdt: number;
  /** The price the signal implies. Checked against the live price in CHECK 4. */
  entry_price: number;
  /** Provenance, so an order in the log can be traced to the verdict behind it. */
  factor_id: string;
  hypothesis_id: string;
}

/**
 * Build the order a promotion implies.
 *
 * EXTRACTED SO THERE IS ONE OF THESE. The session loop and the execution drill
 * both need to turn a promoted hypothesis into an order intent, and if each
 * built its own the drill would be demonstrating a flow subtly different from
 * the one that runs. A drill that reconstructs its own subject proves nothing
 * about the subject.
 *
 * The direction convention lives here too: a `negative` hypothesis expects the
 * target to fall, so it sells. That mapping is not obvious enough to be
 * duplicated, and getting it backwards would invert every simulated P&L.
 */
export function orderIntentFor(params: {
  hypothesis_id: string;
  factor_id: string;
  target: string;
  direction: 'positive' | 'negative';
  notional_usdt: number;
  entry_price: number;
}): OrderIntent {
  return {
    symbol: params.target,
    side: params.direction === 'positive' ? 'buy' : 'sell',
    notional_usdt: params.notional_usdt,
    entry_price: params.entry_price,
    factor_id: params.factor_id,
    hypothesis_id: params.hypothesis_id,
  };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type GuardCheckName =
  | 'CHECK_1_PAPER_TRADING_FLAG'
  | 'CHECK_2_POSITION_CAP'
  | 'CHECK_3_SIZE_CAP'
  | 'CHECK_4_PRICE_SANITY'
  | 'CHECK_5_CONFIRMATION';

export type GuardRefusal =
  | 'paper_trading_flag_not_true'
  | 'position_cap_exceeded'
  | 'order_notional_invalid'
  | 'live_price_unavailable'
  | 'price_outside_sanity_band'
  | 'entry_price_invalid'
  | 'agent_hub_refused';

export interface GuardCheckResult {
  check: GuardCheckName;
  passed: boolean;
  /** Machine-generated, never LLM-authored. */
  detail: string;
  /**
   * Set when the check AMENDED the order instead of refusing it. The amended
   * order is what the guard returns and what must be sent.
   */
  amendment?: { field: keyof OrderIntent; from: number; to: number };
}

/** One call to Agent Hub, recorded so the two-phase confirm is auditable. */
export interface HubAttempt {
  phase: 'initial' | 'confirmed';
  requested_confirm_flag: boolean;
  confirmation_required: boolean;
  accepted: boolean;
  order_id: string | null;
  detail: string;
}

export interface GuardOutcome {
  allowed: boolean;
  /** The order as it stands AFTER any amendment. Never send the input instead. */
  order: OrderIntent;
  checks: GuardCheckResult[];
  refused_at: GuardCheckName | null;
  refused_reason: GuardRefusal | null;
  detail: string;
  /** Present only when the order actually reached Agent Hub. */
  hub_attempts: HubAttempt[];
}

// ---------------------------------------------------------------------------
// Dependencies — all injectable so the guard is testable offline
// ---------------------------------------------------------------------------

export interface AgentHubClient {
  /**
   * Place a paper order.
   *
   * `confirm: false` is the first, unconfirmed attempt: an SDK implementing the
   * spec's two-phase flow answers with `confirmationRequired: true` and places
   * nothing. `confirm: true` is the re-issuance that actually places it.
   */
  placeOrder(
    order: OrderIntent,
    opts: { confirm: boolean },
  ): Promise<{
    confirmationRequired: boolean;
    accepted: boolean;
    orderId: string | null;
    detail: string;
  }>;
}

export interface GuardDeps {
  /** Number of paper positions currently open. */
  getOpenPositions: () => number;
  /** Live price source. Defaults to the real Bitget ticker. */
  getPrice?: (symbol: string) => Promise<PriceQuote>;
  /** Agent Hub client. Omitted when running with no execution configured. */
  hub?: AgentHubClient;
  /** Clock, for deterministic tests. */
  now?: () => Date;
  /** Environment accessor. Defaults to process.env, injectable for tests. */
  env?: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export class ExecutionGuard {
  private readonly policy: GatePolicy['execution_guard'];
  private readonly deps: GuardDeps;

  constructor(deps: GuardDeps, policy?: GatePolicy) {
    this.deps = deps;
    this.policy = (policy ?? loadGatePolicy().data).execution_guard;
  }

  /**
   * Run all five checks in sequence and, if they pass, send the order.
   *
   * Checks are sequential and the first failure stops the sequence — that is
   * what the spec means by "in sequence". A later check never runs against an
   * order an earlier check refused, so a refusal can never be masked by a
   * subsequent pass.
   */
  async evaluate(intent: OrderIntent): Promise<GuardOutcome> {
    const checks: GuardCheckResult[] = [];
    // The working order. CHECK 3 may amend it; everything downstream sees the
    // amended version, and the caller is told to send THIS one.
    let order: OrderIntent = { ...intent };
    const hubAttempts: HubAttempt[] = [];

    const refuse = (
      check: GuardCheckName,
      reason: GuardRefusal,
      detail: string,
    ): GuardOutcome => {
      checks.push({ check, passed: false, detail });
      return {
        allowed: false,
        order,
        checks,
        refused_at: check,
        refused_reason: reason,
        detail,
        hub_attempts: hubAttempts,
      };
    };

    // --- CHECK 1: paper trading flag ---------------------------------------
    //
    // Raw comparison against the exact string. `env` is read here rather than at
    // construction so that a flag flipped at runtime is honoured on the next
    // order rather than cached from process start.
    const env = this.deps.env ?? process.env;
    const flag = env['BITGET_PAPER_TRADING'];
    if (flag !== 'true') {
      return refuse(
        'CHECK_1_PAPER_TRADING_FLAG',
        'paper_trading_flag_not_true',
        `BITGET_PAPER_TRADING must be exactly the string "true"; it is ` +
          `${flag === undefined ? 'unset' : JSON.stringify(flag)}. Every order is refused. ` +
          `This check runs first and cannot be bypassed, because it is the only one ` +
          `standing between a paper order and a live one.`,
      );
    }
    checks.push({
      check: 'CHECK_1_PAPER_TRADING_FLAG',
      passed: true,
      detail: 'BITGET_PAPER_TRADING === "true"',
    });

    // --- order sanity (not a spec check, but a precondition for 2 and 3) ----
    if (!Number.isFinite(order.notional_usdt) || order.notional_usdt <= 0) {
      return refuse(
        'CHECK_3_SIZE_CAP',
        'order_notional_invalid',
        `order notional ${JSON.stringify(order.notional_usdt)} is not a positive number`,
      );
    }
    if (!Number.isFinite(order.entry_price) || order.entry_price <= 0) {
      return refuse(
        'CHECK_4_PRICE_SANITY',
        'entry_price_invalid',
        `entry price ${JSON.stringify(order.entry_price)} is not a positive number`,
      );
    }

    // --- CHECK 2: position cap ---------------------------------------------
    const open = this.deps.getOpenPositions();
    const cap = this.policy.max_open_positions;
    if (open + 1 > cap) {
      return refuse(
        'CHECK_2_POSITION_CAP',
        'position_cap_exceeded',
        `${open} open position(s) plus this order would exceed the cap of ${cap}. ` +
          `Refused rather than clipped: shrinking this order does not free a slot, ` +
          `so a smaller order would still breach the cap.`,
      );
    }
    checks.push({
      check: 'CHECK_2_POSITION_CAP',
      passed: true,
      detail: `${open} open + 1 = ${open + 1} <= cap ${cap}`,
    });

    // --- CHECK 3: size cap (CLIPS, does not refuse) -------------------------
    const maxNotional = this.policy.max_order_usdt;
    if (order.notional_usdt > maxNotional) {
      const from = order.notional_usdt;
      order = { ...order, notional_usdt: maxNotional };
      checks.push({
        check: 'CHECK_3_SIZE_CAP',
        passed: true,
        detail:
          `order notional ${from} USDT exceeded the cap of ${maxNotional} USDT and was ` +
          `CLIPPED to ${maxNotional} USDT. The clipped order is the one that will be ` +
          `sent; the original size is recorded here.`,
        amendment: { field: 'notional_usdt', from, to: maxNotional },
      });
    } else {
      checks.push({
        check: 'CHECK_3_SIZE_CAP',
        passed: true,
        detail: `notional ${order.notional_usdt} <= cap ${maxNotional} USDT`,
      });
    }

    // --- CHECK 4: live price sanity ----------------------------------------
    //
    // A failure to FETCH refuses. An unverifiable price is not a passed check,
    // and the guard must never fall back to "assume it is fine".
    const getPrice = this.deps.getPrice ?? fetchSpotPrice;
    let quote: PriceQuote;
    try {
      quote = await getPrice(order.symbol);
    } catch (err) {
      return refuse(
        'CHECK_4_PRICE_SANITY',
        'live_price_unavailable',
        `could not obtain a live price for ${order.symbol}, so the entry price cannot ` +
          `be sanity-checked: ${err instanceof Error ? err.message : String(err)}. ` +
          `An unverifiable price is not a passed check.`,
      );
    }

    const bandPct = this.policy.price_sanity_band_pct;
    const deviationPct = Math.abs(order.entry_price - quote.price) / quote.price * 100;
    if (deviationPct > bandPct) {
      return refuse(
        'CHECK_4_PRICE_SANITY',
        'price_outside_sanity_band',
        `entry price ${order.entry_price} deviates ${deviationPct.toFixed(3)}% from the ` +
          `live price ${quote.price} (band ${bandPct}%). A gap this size usually means ` +
          `the signal is STALE rather than that the market moved — the order is refused ` +
          `and the factor is flagged.`,
      );
    }
    checks.push({
      check: 'CHECK_4_PRICE_SANITY',
      passed: true,
      detail:
        `entry ${order.entry_price} vs live ${quote.price} ` +
        `(${deviationPct.toFixed(3)}% <= ${bandPct}%)`,
    });

    // --- CHECK 5: confirmation ---------------------------------------------
    if (!this.policy.require_confirm) {
      checks.push({
        check: 'CHECK_5_CONFIRMATION',
        passed: true,
        detail:
          'require_confirm is false in policy. The two-phase confirm is NOT skipped: the ' +
          'flag states whether confirmation is REQUIRED, and the guard does not read it as ' +
          'permission to place an order with less confirmation than the spec describes. ' +
          'With a hub configured the unconfirmed call is still issued first and the ' +
          're-issuance still happens. Recorded here because a setting that is waived ' +
          'silently reads identically to one that was never seen — a later CHECK_5 record ' +
          'describes what actually happened.',
      });
    }

    if (!this.deps.hub) {
      // No executor configured. The order is fully validated and would be sent;
      // saying so is the honest outcome, and pretending it was placed would not be.
      checks.push({
        check: 'CHECK_5_CONFIRMATION',
        passed: true,
        detail:
          'no Agent Hub client configured — order validated but NOT sent. Set ' +
          'BITGET_API_KEY / _SECRET / _PASSPHRASE to enable paper execution.',
      });
      return {
        allowed: true,
        order,
        checks,
        refused_at: null,
        refused_reason: null,
        detail:
          `all five checks passed; order NOT sent (no Agent Hub client). ` +
          `Validated notional ${order.notional_usdt} USDT on ${order.symbol}.`,
        hub_attempts: hubAttempts,
      };
    }

    // Phase 1: unconfirmed. Per the spec this is expected to come back asking
    // for confirmation and to place nothing.
    const initial = await this.deps.hub.placeOrder(order, { confirm: false });
    hubAttempts.push({
      phase: 'initial',
      requested_confirm_flag: false,
      confirmation_required: initial.confirmationRequired,
      accepted: initial.accepted,
      order_id: initial.orderId,
      detail: initial.detail,
    });

    if (!initial.confirmationRequired && !initial.accepted) {
      return refuse(
        'CHECK_5_CONFIRMATION',
        'agent_hub_refused',
        `Agent Hub neither accepted nor asked for confirmation on the initial call: ` +
          `${initial.detail}`,
      );
    }

    // Phase 2: re-issue with explicit confirmation, and log it separately.
    if (initial.confirmationRequired) {
      const confirmed = await this.deps.hub.placeOrder(order, { confirm: true });
      hubAttempts.push({
        phase: 'confirmed',
        requested_confirm_flag: true,
        confirmation_required: confirmed.confirmationRequired,
        accepted: confirmed.accepted,
        order_id: confirmed.orderId,
        detail: confirmed.detail,
      });

      if (!confirmed.accepted) {
        return refuse(
          'CHECK_5_CONFIRMATION',
          'agent_hub_refused',
          `Agent Hub refused the confirmed order: ${confirmed.detail}`,
        );
      }

      checks.push({
        check: 'CHECK_5_CONFIRMATION',
        passed: true,
        detail:
          `two-phase confirm completed: initial call requested confirmation, ` +
          `re-issuance accepted with order id ${confirmed.orderId ?? '(none)'}`,
      });

      return {
        allowed: true,
        order,
        checks,
        refused_at: null,
        refused_reason: null,
        detail: `all five checks passed; order placed as ${confirmed.orderId ?? '(no id)'}`,
        hub_attempts: hubAttempts,
      };
    }

    // Accepted on the first call without asking. Legal, but it means the client
    // does not implement the two-phase flow the spec describes, so it is said
    // out loud rather than reported as a normal success.
    checks.push({
      check: 'CHECK_5_CONFIRMATION',
      passed: true,
      detail:
        `Agent Hub accepted the order on the FIRST call without requesting confirmation ` +
        `(order id ${initial.orderId ?? '(none)'}). The spec's two-phase confirm did not ` +
        `occur; recorded as a deviation rather than as a normal pass.`,
    });
    return {
      allowed: true,
      order,
      checks,
      refused_at: null,
      refused_reason: null,
      detail:
        `all five checks passed; order placed as ${initial.orderId ?? '(no id)'} ` +
        `(single-phase — confirmation was not requested)`,
      hub_attempts: hubAttempts,
    };
  }
}
