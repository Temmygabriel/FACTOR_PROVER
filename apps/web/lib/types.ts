/**
 * MIRROR of apps/agent/src/api/contract.ts — the frozen wire format.
 *
 * WHY THIS IS A COPY AND NOT AN IMPORT. The two halves deploy separately (agent
 * on Render, this app on Vercel, each with its own root directory, build and
 * toolchain). A cross-workspace type import would either pull agent source into
 * the web build or break when the web app is built from its own root, and it
 * would let either side start depending on the other's internals. A copy keeps
 * the wire format the only interface, which is what the contract file is for.
 *
 * The cost of a copy is drift, so the rule is: this file is edited ONLY to
 * match a change in contract.ts, never to add a field the server does not send.
 * A field the UI wants but the wire format lacks is reported to the agent
 * author, not invented here — a rendered field that no server sends would be a
 * fabricated number, which is the one thing this product cannot do.
 */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export type SessionPhase =
  | 'idle'
  | 'running'
  | 'paused'
  | 'halted_by_circuit_breaker'
  | 'stopped'
  | 'error';

/**
 * Signal, target and family are `string` here, not the agent's literal unions.
 * A union would make an enum the agent adds a BUILD FAILURE on the web side,
 * which is the wrong failure for a value that the UI can display verbatim; the
 * plain-language glosses in lib/copy.ts are lookups with a fallback, so an
 * unseen signal renders as its own name rather than as a blank.
 */
export interface PromotedFactor {
  factor_id: string;
  hypothesis_id: string;
  signal: string;
  target: string;
  direction: 'positive' | 'negative';
  window_minutes: number;
  lookback_minutes: number;
  ic: number;
  t_stat: number;
  hit_rate: number;
  n_obs: number;
  /** Absolute BH threshold this factor cleared, at the family size it cleared it. */
  bh_adjusted_threshold: number;
  raw_p_value: number;
  promoted_at: string;
  /** null until enough forward observations have accumulated to fit one. */
  decay_half_life_days: number | null;
  paper_pnl_usdt: number;
  paper_orders: number;
  status: 'active' | 'retired';
}

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

export interface HypothesisShape {
  signal: string;
  target: string;
  direction: 'positive' | 'negative';
  condition: { operator: string; threshold: number; lookback_minutes: number };
  forward_return_minutes: number;
  experiment_family: string;
}

export interface DecisionMetrics {
  ic: number;
  t_stat: number;
  hit_rate: number;
  n_obs: number;
  baseline_ic: number;
  raw_p_value: number;
  bh_adjusted_threshold: number;
}

/** Which of the five bars this row passed. Rendered as the verdict stamp. */
export interface GateChecks {
  passed_min_obs: boolean;
  passed_bh: boolean;
  passed_ic_floor: boolean;
  passed_t_stat_floor: boolean;
  passed_baseline_beat: boolean;
}

/**
 * One row of the decision log, as shown in the UI.
 *
 * ONE shape for both promotes and kills. A kill carries the same fields as a
 * promote, which is what makes it possible for the UI to render the two at
 * equal weight — and what stops a thinner kill render path from creeping in.
 */
export interface DecisionRow {
  entry_id: string;
  entry_hash: string;
  prev_hash: string;
  hypothesis_id: string;
  timestamp_utc: string;
  generator: string;
  partition_used: string;

  decision: GateDecisionType | 'CIRCUIT_BREAK';
  reason: KillReason | null;
  detail: string;

  hypothesis: HypothesisShape | null;

  metrics: DecisionMetrics;

  checks: GateChecks;

  /** Present only when a hypothesis died before any backtest ran. */
  schema_error?: string;
}

/** Provenance for the whole session. Shown so any number can be traced. */
export interface Provenance {
  session_id: string;
  started_at: string;
  policy_version: string;
  policy_sha256: string;
  partitions_sha256: string;
  /** null when the session is not backed by frozen data — shown as such. */
  dataset_sha256: string | null;
  dataset_frozen: boolean;
  frozen_files: number;
  fdr_level: number;
}

export interface SessionStats {
  hypotheses_attempted: number;
  hypotheses_promoted: number;
  hypotheses_killed: number;
  /** Rejected by the schema wall before any compute was spent. */
  hypotheses_schema_rejected: number;
  /** Currently passing the gate and being paper-tracked. */
  active_factors: number;
  retired_factors: number;
  /** Where hypotheses came from. Recorded so the UI can be honest about it. */
  generator_tiers: Record<string, number>;
  /** The BH threshold currently applied at rank 1, given the family size. */
  current_bh_threshold_rank1: number;
  loop_iterations: number;
}

export interface BreakerState {
  tripped: boolean;
  reason: string | null;
  detail: string;
  tripped_at: string | null;
  day: string;
}

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------

export interface StatusResponse {
  phase: SessionPhase;
  provenance: Provenance;
  stats: SessionStats;
  circuit_breaker: BreakerState;
  circuit_counters: {
    day: string;
    hypotheses_today: number;
    promotes_today: number;
    paper_orders_today: number;
    consecutive_llm_failures: number;
  };
  execution: {
    available: boolean;
    unverified: boolean;
    detail: string;
  };
  generator: {
    chain: string;
    tiers_live: string[];
    deterministic_fallback: boolean;
  };
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// GET /api/leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardResponse {
  factors: PromotedFactor[];
  /** Present when nothing has been promoted, explaining rather than showing "no data". */
  empty_reason: string | null;
}

// ---------------------------------------------------------------------------
// GET /api/log
// ---------------------------------------------------------------------------

export interface LogResponse {
  entries: DecisionRow[];
  total: number;
  /** Pass back as `before` to fetch the next page. */
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// SSE /api/stream
// ---------------------------------------------------------------------------

export type StreamEventType =
  | 'session_started'
  | 'hypothesis_proposed'
  | 'backtest_completed'
  | 'verdict'
  | 'promotion'
  | 'paper_order'
  | 'circuit_break'
  | 'circuit_reset'
  | 'tier_failure'
  | 'session_stopped'
  | 'error'
  | 'heartbeat';

export interface StreamEvent {
  type: StreamEventType;
  at: string;
  /** Short line for the live feed. Plain text, never LLM-authored. */
  message: string;
  /** The full row when the event produced one (verdict, promotion). */
  entry?: DecisionRow;
  /** Present on tier_failure: which generator tier failed and why. */
  tier_failure?: { tier: string; message: string };
  /** Present on circuit_break / circuit_reset. */
  breaker?: BreakerState;
  /** Present on error. */
  error?: string;
}

// ---------------------------------------------------------------------------
// POST /api/start | /api/stop | /api/reset
// ---------------------------------------------------------------------------

export interface ControlResponse {
  ok: boolean;
  phase: SessionPhase;
  detail: string;
}

export interface ResetRequest {
  /** Recorded in the log — a resume must be attributable to a person. */
  requested_by: string;
}

// ---------------------------------------------------------------------------
// Error shape — every non-2xx response uses this
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  detail: string;
  /** Never includes secrets; the server redacts before responding. */
}

/**
 * PROVISIONAL — GET /api/log/verify is listed in build spec §11 but has no
 * shape in contract.ts. Every field is optional and rendered defensively, so a
 * response this file cannot predict degrades to showing the raw detail string
 * rather than inventing a validity result. Reported to the agent author.
 */
export interface ChainVerification {
  valid?: boolean;
  checked?: number;
  broken_entry_id?: string | null;
  detail?: string;
  verified_at?: string;
}

/**
 * PROVISIONAL — the contract's StreamEvent lets `hypothesis_proposed` and
 * `backtest_completed` carry an `entry` (a full DecisionRow) but names no field
 * for a hypothesis that has not been decided yet, nor for metrics that exist
 * before the gate runs. Those two events are read against this optional shape
 * as well, so that a server which sends more than the contract requires lights
 * up the hypothesis panel; a server that sends only `message` still works and
 * the panel waits for the log row instead. Nothing here is assumed present.
 * Reported to the agent author.
 */
export interface ProvisionalStreamFields {
  hypothesis?: HypothesisShape;
  hypothesis_id?: string;
  metrics?: Partial<DecisionMetrics>;
  stats?: { hypotheses_attempted?: number; current_bh_threshold_rank1?: number };
}

/** A StreamEvent plus the provisional fields above, all optional. */
export type StreamEventRead = StreamEvent & ProvisionalStreamFields;
