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

  /**
   * The family size when this verdict was reached — how many hypotheses the
   * session had attempted by then, and therefore how many the BH correction was
   * spread across. Recorded per entry, so it is the count at the time rather
   * than the session's current total.
   */
  total_hypotheses_attempted_this_session: number;

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
  /**
   * Which tiers proposed the hypotheses in the WHOLE record, and how many each.
   *
   * Not a tally of `entries`, which is one page. The distinction is the reason
   * the field exists: a tally over a page would let a reader conclude "this
   * record was enumerated" from having seen ten rows, and the server computes it
   * over the file precisely so the UI never has to make that inference.
   *
   * Optional because the server may be older than this client. Absent means
   * unknown, and the UI says nothing rather than guessing.
   */
  generators?: { tier: string; count: number }[];

  /**
   * The record these entries came from — an echo of what was asked for.
   *
   * THE OPTIONALITY HERE MEANS THE OPPOSITE OF THE OTHER OPTIONAL FIELDS, and
   * that is the only reason this comment is this long. `generators` absent means
   * "the server has nothing to say, so say nothing". `record` absent means the
   * server DID NOT UNDERSTAND THE QUESTION: an instance deployed before record
   * selection existed ignores `?record=llm` and answers with the canonical
   * record — a 200 with a page of entirely true rows.
   *
   * So an absent `record` must NEVER be read as "same as what I asked for". It
   * is the signal that this server cannot select records, and the only safe
   * response is to refuse to render a selection at all. Rendering the canonical
   * record under a heading claiming it is the model-proposed one is precisely
   * the mislabelling the parameter was added to prevent, reached by the back
   * door — and it would be worse than the original problem, because the page
   * would look like it had checked.
   */
  record?: RecordId;
}

/**
 * Which committed record a request is about.
 *
 * THERE ARE TWO RECORDS AND THEY ARE DIFFERENT DOCUMENTS. `committed` is the
 * canonical research record — 201 entries, every one proposed by the
 * deterministic enumerator, the session the promotion and the demotion rest on.
 * `llm` is the model-proposed calibration record — 60 entries, every one
 * proposed by Groq.
 *
 * Both are committed, both verify, and each entry's `generator` says which is
 * which. They are two files rather than one because one file cannot hold both
 * facts: merged, either the model proposed nothing in the record that exists,
 * or the deterministic session is gone.
 */
export type RecordId = 'committed' | 'llm';

/**
 * AN ENTRY ID IS SCOPED TO ITS RECORD, NOT GLOBAL.
 *
 * Both files number their entries densely from `E-0001`, so the ids collide
 * across records — and a colliding id is a genuinely different row. `E-0006` is
 * the PROMOTE the submission rests on in the canonical record (p = 0.0147), and
 * an unrelated KILL in the model record (p = 0.0352).
 *
 * Two consequences the UI must honour: never carry a `before` cursor across a
 * record switch, and never treat an id as identifying a row without also
 * knowing which record it came from.
 */
export const RECORD_IDS: readonly RecordId[] = ['committed', 'llm'];

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
 * One specific way the hash chain failed to verify, from the contract's
 * `VerifyFailureRow`. `line` is 1-based in the log file, so a reader who opens
 * `logs/decisions.jsonl` can go straight to the entry named.
 */
export interface VerifyFailureRow {
  kind: string;
  line: number;
  entry_id: string | null;
  /** What was expected and what was found. */
  detail: string;
}

/**
 * The result of re-verifying the decision log's hash chain.
 *
 * This was PROVISIONAL for a while — five invented optional fields (`valid`,
 * `checked`, `broken_entry_id`, `verified_at`) reading against an endpoint whose
 * real shape was in contract.ts all along. The cost of that guess was not
 * cosmetic: the log screen's banner had to read both shapes to avoid rendering
 * every real answer as unreadable, and a shape that has to be guessed is a shape
 * that can be guessed wrongly in the direction of showing a pass.
 *
 * It is now a straight mirror of `VerifyResponse`, which is what the deployed
 * endpoint actually returns.
 *
 * `ok: true` with `entries_checked: 0` means the log exists and is empty. That is
 * vacuously true, not evidence of integrity, and the banner says "nothing to
 * verify" rather than "verified".
 *
 * `unavailable_reason` is set when the log could not be read at all, and it comes
 * with ok false and an empty `failures` array. It must be read BEFORE `ok`, or a
 * log that does not exist yet is reported as a log that has been tampered with.
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
  unavailable_reason: string | null;
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
