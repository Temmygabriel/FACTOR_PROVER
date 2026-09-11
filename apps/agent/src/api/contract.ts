/**
 * The HTTP/SSE contract between the agent backend (Render) and the web frontend
 * (Vercel).
 *
 * This file is the single source of truth for the wire format. Both sides read
 * it, so a field cannot be renamed on one side without the other failing to
 * compile. That matters here because the two halves deploy separately and are
 * built by different toolchains.
 *
 * Two rules the shapes below are designed to enforce, both from the design spec:
 *
 *  1. A KILLED verdict is a RESULT, not an absence. Kill entries carry the same
 *     fields as promotes — the same IC, t-stat, p-value, observation count and
 *     gate detail. The frontend renders them at equal visual weight, and the
 *     contract makes that possible by not having a thinner shape for kills.
 *
 *  2. Every number shown to a reader is traceable to a log entry. These types
 *     carry provenance (entry_id, entry_hash, policy_sha256, dataset_sha256)
 *     alongside the metrics, so the UI can always show where a number came from
 *     rather than presenting it as a bare fact.
 */

import type { GateDecisionType, KillReason, RTokenSymbol, SignalId } from '../types.js';
import type { BreakerState } from '../circuit/breaker.js';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Where a session is in its lifecycle. */
export type SessionPhase =
  | 'idle'
  | 'running'
  | 'paused'
  | 'halted_by_circuit_breaker'
  | 'stopped'
  | 'error';

/** A factor that survived the gate and is being paper-tracked. */
export interface PromotedFactor {
  factor_id: string;
  hypothesis_id: string;
  signal: SignalId;
  target: RTokenSymbol;
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

/**
 * The hypothesis as proposed, for display. Shared by `DecisionRow` and by the
 * provisional stream events, so a row and the event that preceded it cannot
 * describe the same hypothesis differently.
 */
export interface HypothesisShape {
  signal: SignalId;
  target: RTokenSymbol;
  direction: 'positive' | 'negative';
  condition: { operator: string; threshold: number; lookback_minutes: number };
  forward_return_minutes: number;
  experiment_family: string;
}

/** The measured metrics, before and after adjudication. */
export interface DecisionMetrics {
  ic: number;
  t_stat: number;
  hit_rate: number;
  n_obs: number;
  baseline_ic: number;
  raw_p_value: number;
  bh_adjusted_threshold: number;
}

/**
 * One row of the decision log, as shown in the UI.
 *
 * Deliberately ONE shape for both promotes and kills. A kill has no less
 * information available about it than a promote does; giving kills a thinner
 * type would make it natural for the UI to show them more briefly, which is the
 * exact bias this project is built to avoid.
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

  /** Which of the five bars this row passed. Rendered as the verdict stamp. */
  checks: {
    passed_min_obs: boolean;
    passed_bh: boolean;
    passed_ic_floor: boolean;
    passed_t_stat_floor: boolean;
    passed_baseline_beat: boolean;
  };

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

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------

export interface StatusResponse {
  phase: SessionPhase;
  provenance: Provenance;
  stats: SessionStats;
  circuit_breaker: BreakerState;
  /** Counters behind the breaker, so the UI can show how close it is to tripping. */
  circuit_counters: {
    day: string;
    hypotheses_today: number;
    promotes_today: number;
    paper_orders_today: number;
    consecutive_llm_failures: number;
  };
  /** Honest capability report — never claims execution it does not have. */
  execution: {
    available: boolean;
    unverified: boolean;
    detail: string;
  };
  /** Honest report of which generator tiers are live. */
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
  /** Sorted by ic descending, per build spec §11. */
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

/**
 * Every SSE frame is one of these. `heartbeat` exists because Render's free
 * tier sleeps an idle service and proxies drop silent connections; a periodic
 * comment frame keeps the stream alive without pretending anything happened.
 */
export interface StreamEvent {
  type: StreamEventType;
  at: string;
  /** Short line for the live feed. Plain text, never LLM-authored. */
  message: string;
  /** The full row when the event produced one (verdict, promotion). */
  entry?: DecisionRow;
  /**
   * The hypothesis under test, on `hypothesis_proposed` and
   * `backtest_completed`.
   *
   * These two events describe work that has NOT been decided yet, so there is no
   * row to send. Without a payload the only thing a reader sees is a sentence,
   * and a UI cannot render an in-flight hypothesis — which is what a live view
   * is for. The fields are the same shapes the eventual row uses, so the panel
   * does not have to switch representation when the verdict arrives.
   */
  hypothesis?: HypothesisShape;
  hypothesis_id?: string;
  /**
   * Backtest outputs, on `backtest_completed`.
   *
   * Exactly the result fields and no more: `bh_adjusted_threshold` is omitted
   * because it is not a property of the backtest — it is computed during
   * adjudication, from the family's size at that moment, and sending a stale or
   * guessed value here would let the live view show a threshold the gate never
   * used.
   */
  metrics?: Omit<DecisionMetrics, 'bh_adjusted_threshold'>;
  /** Running counters, on `backtest_completed`, so the header stays live. */
  stats?: { hypotheses_attempted: number; current_bh_threshold_rank1: number };
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
// GET /api/log/verify
// ---------------------------------------------------------------------------

/** One specific way the hash chain failed to verify. */
export interface VerifyFailureRow {
  kind: string;
  /** 1-based line number in the log file. */
  line: number;
  entry_id: string | null;
  /** What was expected and what was found. */
  detail: string;
}

/**
 * The result of re-verifying the decision log's hash chain.
 *
 * This endpoint is what makes the submission's central claim checkable rather
 * than merely asserted. Every entry carries `entry_hash` = sha256 of its own
 * canonical JSON, and `prev_hash` = its predecessor's `entry_hash`, so the whole
 * log is a chain: altering or removing any entry breaks every link after it.
 * This route recomputes that from the file's own bytes and reports what it
 * found.
 *
 * A reader who does not trust this server can read `logs/decisions.jsonl` and
 * `src/log/verify.ts` and reproduce the result — `reproduce` states the command.
 * That is deliberate: a verification you have to take on faith is not a
 * verification.
 *
 * `ok: true` with `entries_checked: 0` means the log exists and is empty. That
 * is vacuously true, not evidence of integrity, and the UI is expected to say
 * "empty" rather than "verified".
 */
export interface VerifyResponse {
  ok: boolean;
  entries_checked: number;
  /** entry_hash of the last entry, or null when the log holds none. */
  head_hash: string | null;
  failures: VerifyFailureRow[];
  /** Path to the log, relative to the repo root. */
  log_path: string;
  /** How to reproduce this from a checkout. */
  reproduce: string;
  /** Set when the log could not be read at all, e.g. it does not exist yet. */
  unavailable_reason: string | null;
}

// ---------------------------------------------------------------------------
// Error shape — every non-2xx response uses this
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  detail: string;
  /** Never includes secrets; the server redacts before responding. */
}
