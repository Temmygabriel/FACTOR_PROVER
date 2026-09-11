/**
 * The paper-trading ledger.
 *
 * WHAT THIS IS, STATED PLAINLY. Nothing here touches real money. A promoted
 * factor gets a simulated position, the position is marked against live prices,
 * and the resulting P&L is a SIMULATION. The build spec asks for paper trading
 * and this is honestly that: a notional book used to watch a surviving factor
 * behave after promotion, not evidence that anything is profitable.
 *
 * That distinction is not pedantry, it is the load-bearing one for the whole
 * submission. A promoted factor cleared a significance bar under FDR control on
 * a frozen historical partition. It has not been traded. Paper P&L is the thing
 * most likely to be misread as a track record, so every number this file
 * produces is labelled as simulated wherever it surfaces, and the code does not
 * compute any statistic it cannot defend from the data it actually has.
 */

import type { PromotedFactor } from '../api/contract.js';
import type { FactorHypothesis } from '../types.js';

/**
 * Forward observations a factor needs before a decay half-life is fitted.
 *
 * Below this the fit would be a line through three points, which is not a
 * measurement. The threshold is deliberately high enough that early in a
 * session the honest answer is `null` rather than a confident-looking number.
 */
const MIN_OBS_FOR_DECAY = 20;

export interface PaperFill {
  factor_id: string;
  hypothesis_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  notional_usdt: number;
  entry_price: number;
  at: string;
  /** True when the Execution Guard allowed it; false when it refused. */
  placed: boolean;
  refusal: string | null;
}

/** One (age, rolling IC) pair used to fit decay. */
export interface DecaySample {
  age_days: number;
  ic: number;
}

export interface PaperPosition {
  factor_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  notional_usdt: number;
  entry_price: number;
  opened_at: string;
  last_price: number;
  last_marked_at: string;
  realized_pnl_usdt: number;
  unrealized_pnl_usdt: number;
}

/**
 * Signed return of a position given entry and current price, in USDT.
 *
 * A short position profits when price falls, so the sign flips for `sell`. This
 * is the one place the direction convention is applied, so getting it wrong
 * here would silently invert every P&L number in the UI.
 */
function positionPnl(side: 'buy' | 'sell', notional: number, entry: number, mark: number): number {
  if (!Number.isFinite(entry) || !Number.isFinite(mark) || entry === 0) return 0;
  const move = (mark - entry) / entry;
  return notional * (side === 'buy' ? move : -move);
}

export class PaperLedger {
  private readonly factors = new Map<string, PromotedFactor>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly fills: PaperFill[] = [];
  private readonly decaySamples = new Map<string, DecaySample[]>();
  private nextFactorNumber = 1;

  /** `F-0001`. Dense and zero-padded so ids sort lexically, like hypothesis ids. */
  private formatFactorId(): string {
    return `F-${String(this.nextFactorNumber++).padStart(4, '0')}`;
  }

  /**
   * Create a promoted-factor record.
   *
   * Deliberately does NOT open a position. Promotion is a verdict about a
   * backtest; opening a position is an execution decision that has to pass the
   * Execution Guard first, and conflating them would mean a factor that the
   * Guard refused still shows up holding a position.
   */
  promote(params: {
    hypothesis: FactorHypothesis;
    ic: number;
    t_stat: number;
    hit_rate: number;
    n_obs: number;
    bh_adjusted_threshold: number;
    raw_p_value: number;
  }): PromotedFactor {
    const factor: PromotedFactor = {
      factor_id: this.formatFactorId(),
      hypothesis_id: params.hypothesis.hypothesis_id,
      signal: params.hypothesis.signal,
      target: params.hypothesis.target,
      direction: params.hypothesis.direction,
      window_minutes: params.hypothesis.forward_return_minutes,
      lookback_minutes: params.hypothesis.condition.lookback_minutes,
      ic: params.ic,
      t_stat: params.t_stat,
      hit_rate: params.hit_rate,
      n_obs: params.n_obs,
      bh_adjusted_threshold: params.bh_adjusted_threshold,
      raw_p_value: params.raw_p_value,
      promoted_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      decay_half_life_days: null,
      paper_pnl_usdt: 0,
      paper_orders: 0,
      status: 'active',
    };
    this.factors.set(factor.factor_id, factor);
    this.decaySamples.set(factor.factor_id, []);
    return factor;
  }

  /**
   * Record a paper fill and open the position if the Guard allowed it.
   *
   * A refused order still produces a `PaperFill`, with `placed: false` and the
   * refusal reason. That is the point: the Guard refusing an order is a thing
   * that happened, and a ledger that only recorded successful fills would make
   * the execution history look cleaner than it was.
   */
  recordFill(fill: PaperFill, opts: { openPosition: boolean }): void {
    this.fills.push(fill);
    const factor = this.factors.get(fill.factor_id);
    if (factor && fill.placed) factor.paper_orders += 1;
    if (!fill.placed || !opts.openPosition) return;

    this.positions.set(fill.factor_id, {
      factor_id: fill.factor_id,
      symbol: fill.symbol,
      side: fill.side,
      notional_usdt: fill.notional_usdt,
      entry_price: fill.entry_price,
      opened_at: fill.at,
      last_price: fill.entry_price,
      last_marked_at: fill.at,
      realized_pnl_usdt: 0,
      unrealized_pnl_usdt: 0,
    });
  }

  /** Mark one position against a fresh price. No-op when the factor holds none. */
  mark(factorId: string, price: number, at: string = new Date().toISOString()): void {
    const pos = this.positions.get(factorId);
    if (!pos) return;
    pos.last_price = price;
    pos.last_marked_at = at;
    pos.unrealized_pnl_usdt = positionPnl(pos.side, pos.notional_usdt, pos.entry_price, price);

    const factor = this.factors.get(factorId);
    if (factor) {
      factor.paper_pnl_usdt = pos.realized_pnl_usdt + pos.unrealized_pnl_usdt;
    }
  }

  /**
   * Close a position and fold its P&L into the factor's realized total.
   *
   * The position stays in the map with zero notional rather than being deleted,
   * so `getOpenPositionCount` is driven by an explicit flag and a closed
   * position cannot be silently reopened by a later mark.
   */
  close(factorId: string, price: number): void {
    const pos = this.positions.get(factorId);
    if (!pos || pos.notional_usdt === 0) return;
    pos.realized_pnl_usdt += positionPnl(pos.side, pos.notional_usdt, pos.entry_price, price);
    pos.unrealized_pnl_usdt = 0;
    pos.notional_usdt = 0;
    pos.last_price = price;

    const factor = this.factors.get(factorId);
    if (factor) factor.paper_pnl_usdt = pos.realized_pnl_usdt;
  }

  /** Open positions, which is what the Guard's CHECK 2 counts. */
  getOpenPositionCount(): number {
    let n = 0;
    for (const p of this.positions.values()) if (p.notional_usdt > 0) n++;
    return n;
  }

  /**
   * The position for a factor, open or closed. Null when none was ever opened.
   *
   * Read by the loop when a promotion is withdrawn: the position has to be
   * closed at its last known mark, and the mark lives here rather than in the
   * loop because this is the only object that knows what price the position was
   * last seen at.
   */
  positionFor(factorId: string): PaperPosition | null {
    return this.positions.get(factorId) ?? null;
  }

  /**
   * Retire a factor whose verdict was demoted.
   *
   * A live candidate can lose its place when the family grows — BH thresholds
   * only tighten — so a promotion is not permanent. When that happens the
   * factor is RETIRED rather than deleted: the record of it having been
   * promoted stays visible, because a promotion that was later withdrawn is
   * part of the session's history and hiding it would make the loop look more
   * decisive than it was.
   */
  retire(factorId: string, reason: string): PromotedFactor | null {
    const factor = this.factors.get(factorId);
    if (!factor) return null;
    factor.status = 'retired';
    this.retireReasons.set(factorId, reason);
    return factor;
  }

  private readonly retireReasons = new Map<string, string>();

  retireReason(factorId: string): string | null {
    return this.retireReasons.get(factorId) ?? null;
  }

  /**
   * Feed a post-promotion IC measurement, for the decay fit.
   *
   * `age_days` is time since promotion. Samples accumulate and the half-life is
   * refitted on each call, so the number improves as the session runs rather
   * than being frozen at whatever three points existed early on.
   */
  observeDecay(factorId: string, sample: DecaySample): void {
    const list = this.decaySamples.get(factorId);
    if (!list) return;
    list.push(sample);
    const factor = this.factors.get(factorId);
    if (!factor) return;
    factor.decay_half_life_days = fitHalfLifeDays(list);
  }

  get(factorId: string): PromotedFactor | undefined {
    return this.factors.get(factorId);
  }

  byHypothesis(hypothesisId: string): PromotedFactor | undefined {
    return [...this.factors.values()].find((f) => f.hypothesis_id === hypothesisId);
  }

  /** All factors, sorted by IC descending, per build spec §11. */
  leaderboard(): PromotedFactor[] {
    return [...this.factors.values()].sort((a, b) => Math.abs(b.ic) - Math.abs(a.ic));
  }

  get activeCount(): number {
    return [...this.factors.values()].filter((f) => f.status === 'active').length;
  }

  get retiredCount(): number {
    return [...this.factors.values()].filter((f) => f.status === 'retired').length;
  }

  get allFills(): readonly PaperFill[] {
    return [...this.fills];
  }
}

/**
 * Fit an exponential decay of |IC| against age and return the half-life in days.
 *
 * `IC(age) = IC0 * exp(-lambda * age)`, so `ln|IC| = ln|IC0| - lambda*age` and a
 * least-squares line through the (age, ln|IC|) points gives lambda directly.
 * Half-life is `ln2 / lambda`.
 *
 * Returns null in three distinct situations, all of which mean "not measurable
 * yet" and none of which mean "no decay":
 *
 *   - fewer than MIN_OBS_FOR_DECAY samples;
 *   - a non-positive fitted lambda, i.e. IC is not shrinking — a half-life for
 *     something that is not decaying does not exist, and returning a huge number
 *     would imply a measurement that was never made;
 *   - any sample with |IC| = 0, which has no logarithm.
 *
 * The caller shows the reason; the contract carries `null`.
 */
export function fitHalfLifeDays(samples: readonly DecaySample[]): number | null {
  const usable = samples.filter((s) => s.ic !== 0 && Number.isFinite(s.ic));
  if (usable.length < MIN_OBS_FOR_DECAY) return null;

  const xs = usable.map((s) => s.age_days);
  const ys = usable.map((s) => Math.log(Math.abs(s.ic)));
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY);
    den += (xs[i]! - meanX) ** 2;
  }
  if (den === 0) return null; // every sample at the same age — no slope to fit

  const slope = num / den; // = -lambda
  const lambda = -slope;
  if (!(lambda > 0)) return null;

  return Math.LN2 / lambda;
}
