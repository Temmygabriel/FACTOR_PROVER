/**
 * Factor Prover — core type contracts.
 *
 * Two rules govern this file:
 *
 *  1. The hypothesis schema is BOUNDED and ENUM-CONSTRAINED. Anything outside
 *     these enums is auto-KILLed before it reaches the backtest. The LLM never
 *     emits free text inside the executable schema.
 *
 *  2. The LLM proposes; it never decides. Every threshold that determines a
 *     verdict lives in config/gate_policy.json, is written once, and is
 *     read-only for the life of the session.
 *
 * Two families from the original build spec are absent, both for evidence-based
 * reasons documented in docs/DATA_FINDINGS.md:
 *   - Family 2 (OI shock)  — Bitget exposes no historical open interest.
 *   - sentiment_* signals  — the fear/greed and long-short signals would require
 *                            an external data source, which contradicts the
 *                            submission's "all data is from Bitget's API" claim.
 */

// ---------------------------------------------------------------------------
// Signals — every one derivable from Bitget's public API, with real history.
// ---------------------------------------------------------------------------

export const SIGNAL_IDS = [
  'btc_funding_rate',
  'eth_funding_rate',
  'btc_spot_return',
  'eth_spot_return',
  'btc_funding_x_spot',
] as const;

export type SignalId = (typeof SIGNAL_IDS)[number];

/** Signals that are a conjunction of two primitives. */
export const COMBINED_SIGNALS: readonly SignalId[] = ['btc_funding_x_spot'];

// ---------------------------------------------------------------------------
// Targets — tokenized equities ("rTokens") listed on Bitget spot.
// ---------------------------------------------------------------------------

export const RTOKEN_SYMBOLS = [
  'RCOINUSDT',
  'RNVDAUSDT',
  'RGOOGLUSDT',
  'RAAPLUSDT',
  'RAMZNUSDT',
  'RSPYUSDT',
  'RQQQUSDT',
] as const;

export type RTokenSymbol = (typeof RTOKEN_SYMBOLS)[number];

// ---------------------------------------------------------------------------
// Experiment families — the bounded search space.
// ---------------------------------------------------------------------------

export const EXPERIMENT_FAMILIES = [
  'funding_to_rtoken',
  'btc_momentum_to_rtoken',
  'combined_cross_asset',
] as const;

export type ExperimentFamily = (typeof EXPERIMENT_FAMILIES)[number];

/** Which signals each family is permitted to use. Enforced by the validator. */
export const FAMILY_SIGNALS: Record<ExperimentFamily, readonly SignalId[]> = {
  funding_to_rtoken: ['btc_funding_rate', 'eth_funding_rate'],
  btc_momentum_to_rtoken: ['btc_spot_return', 'eth_spot_return'],
  combined_cross_asset: ['btc_funding_x_spot'],
};

/**
 * Forward-return window bounds (minutes) per family.
 *
 * CAPPED AT 120 MINUTES. The original spec allowed up to 480 (8h), but measured
 * against the real DISCOVERY partition an 8h window yields only ~70 valid
 * non-overlapping observations — below the preregistered min_obs of 100 — so
 * every such hypothesis would auto-KILL for insufficient data rather than for
 * any property of the idea. See the power_analysis block in gate_policy.json.
 *
 * Observation counts available and the IC each window needs to clear
 * min_t_stat = 2.0 (measured on the real DISCOVERY partition, 42,098 candles):
 *
 *     15m -> 3126 obs, IC >= 0.036
 *     30m -> 1547 obs, IC >= 0.051
 *     60m ->  742 obs, IC >= 0.073
 *    120m ->  346 obs, IC >= 0.107
 *
 * Short windows carry the statistical power; long windows need a signal
 * strength real markets do not produce.
 */
export const FAMILY_WINDOW_BOUNDS: Record<ExperimentFamily, { min: number; max: number }> = {
  funding_to_rtoken: { min: 15, max: 120 },
  btc_momentum_to_rtoken: { min: 30, max: 120 },
  combined_cross_asset: { min: 60, max: 120 },
};

/** Every family's window cap, for validator and UI copy. */
export const MAX_FORWARD_WINDOW_MINUTES = 120;

/**
 * Lookback bounds for the signal condition.
 *
 * Defined in src/data/freezeWindow.ts and re-exported here, because it is only
 * half of a two-sided constraint: the frozen files carry a warm-up lead-in
 * DERIVED from this number, so the schema and the dataset have to agree on it.
 * Keeping the definition next to the lead-in arithmetic is what keeps them
 * agreeing. Re-exported so every existing importer is unaffected.
 */
export { MAX_LOOKBACK_MINUTES } from './data/freezeWindow.js';

// ---------------------------------------------------------------------------
// Condition operators
// ---------------------------------------------------------------------------

export const OPERATORS = [
  'gt',
  'lt',
  'gte',
  'lte',
  'pct_change_gt',
  'pct_change_lt',
] as const;

export type Operator = (typeof OPERATORS)[number];

export const DIRECTIONS = ['positive', 'negative'] as const;
export type Direction = (typeof DIRECTIONS)[number];

// ---------------------------------------------------------------------------
// The hypothesis. This is exactly what the LLM returns and nothing more.
// ---------------------------------------------------------------------------

export interface FactorHypothesis {
  /** H-{padded}. Assigned by the system, never by the LLM. */
  hypothesis_id: string;
  /** Assigned by the system. */
  session_id: string;
  /** ISO timestamp. Assigned by the system. */
  proposed_at: string;

  signal: SignalId;
  condition: {
    operator: Operator;
    threshold: number;
    /** Integer, 1-480 only. */
    lookback_minutes: number;
  };

  target: RTokenSymbol;
  direction: Direction;
  /** Integer, bounded per family. */
  forward_return_minutes: number;

  experiment_family: ExperimentFamily;
}

/** Which tier produced a hypothesis. Recorded so the log stays honest. */
export type GeneratorTier = 'groq' | 'gemini' | 'anthropic' | 'openai' | 'deterministic';

/** Fields the LLM supplies. Everything else is stamped by the system. */
export type ProposedHypothesis = Omit<
  FactorHypothesis,
  'hypothesis_id' | 'session_id' | 'proposed_at'
>;

// ---------------------------------------------------------------------------
// Backtest results
// ---------------------------------------------------------------------------

export interface Observation {
  /** Unix ms of the signal timestamp. */
  timestamp: number;
  signal_value: number;
  /** Forward return over the hypothesis window, in basis points. */
  target_return: number;
}

export interface BacktestResult {
  /** Pearson correlation between signal and forward return. */
  ic: number;
  /** t-statistic on the IC, computed on the sample actually used. */
  t_stat: number;
  /** Two-tailed p-value. */
  p_value: number;
  /** Fraction of observations where the sign of the call was correct. */
  hit_rate: number;
  /** Count of valid, non-overlapping observations only. */
  n_obs: number;
  /** IC of a naive baseline (prior-period return as the signal). */
  baseline_ic: number;
  /** Observed autocorrelation lag-1 of the signal; disclosed, not gated. */
  signal_autocorr_lag1: number;
}

// ---------------------------------------------------------------------------
// Gate decisions
// ---------------------------------------------------------------------------

export type GateDecisionType = 'PROMOTE' | 'KILL';

export type KillReason =
  | 'p_value_exceeds_bh_threshold'
  | 'insufficient_obs'
  | 'lookback_bias_detected'
  | 'duplicate_family'
  | 'schema_validation_failed'
  | 'baseline_not_beaten'
  | 'ic_below_floor'
  | 't_stat_below_floor';

export interface GateDecision {
  decision: GateDecisionType;
  reason: KillReason | null;
  /** Human-readable, machine-generated. Never LLM-authored. */
  detail: string;
  bh_adjusted_threshold: number;
  raw_p_value: number;
  checks: {
    passed_min_obs: boolean;
    passed_bh: boolean;
    passed_ic_floor: boolean;
    passed_t_stat_floor: boolean;
    passed_baseline_beat: boolean;
  };
}

// ---------------------------------------------------------------------------
// LLM context projection — typed numbers only, never raw data or free text.
// ---------------------------------------------------------------------------

export interface LLMContext {
  session: {
    session_id: string;
    hypotheses_attempted: number;
    hypotheses_promoted: number;
    hypotheses_killed: number;
    hypotheses_retired: number;
    current_fdr_level: number;
    discovery_window_start: string;
    discovery_window_end: string;
  };

  promoted_factors: Array<{
    factor_id: string;
    signal: SignalId;
    target: RTokenSymbol;
    window_minutes: number;
    direction: Direction;
    ic: number;
    t_stat: number;
    hit_rate: number;
    n_obs: number;
    paper_pnl_usdt: number;
    decay_half_life_days: number | null;
    status: 'active' | 'retired';
  }>;

  recent_kills: Array<{
    factor_id: string;
    signal: SignalId;
    target: RTokenSymbol;
    kill_reason: KillReason;
    ic: number;
    t_stat: number;
  }>;

  market_summary: {
    btc_funding_rate_current: number;
    btc_funding_rate_7d_percentile: number;
    btc_spot_return_1h_pct: number;
    eth_funding_rate_current: number;
    eth_spot_return_1h_pct: number;
  };

  /**
   * Which source the `market_summary` numbers came from.
   *
   * The summary is read live when the network allows and from the frozen
   * DISCOVERY tail when it does not. Those are weeks apart, so a model shown a
   * stale level without being told would reason about a market that no longer
   * exists — and the hypotheses it proposes would be conditioned on a state the
   * backtest cannot even see. Disclosed in the prompt by being part of it.
   */
  market_summary_source: 'live' | 'frozen';

  allowed_signals: SignalId[];
  allowed_targets: RTokenSymbol[];
  allowed_families: ExperimentFamily[];
}
