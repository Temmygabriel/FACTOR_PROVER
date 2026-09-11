/**
 * Hash-chained, append-only decision log.
 *
 * Rule 3. Every gate decision writes exactly one entry. Each entry carries the
 * hash of the previous entry, so altering or removing any line breaks every
 * hash after it. The file grows only.
 *
 * The hash is taken over the canonical JSON of all fields except entry_hash
 * itself. Canonical means keys sorted recursively, so the digest does not
 * depend on object insertion order — otherwise a re-serialization in a
 * verifier would produce a different hash for identical data.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GateDecision, KillReason } from '../types.js';
import type { PartitionName } from '../config.js';
import { loadGatePolicy, loadPartitions } from '../config.js';
import { frozenDatasetHash } from '../data/frozen.js';

/** Recursively sort object keys so serialization is deterministic. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** The genesis link. The first entry's prev_hash is this constant. */
export const GENESIS_HASH = 'sha256:' + '0'.repeat(64);

export interface DecisionLogEntry {
  entry_id: string;
  prev_hash: string;
  hypothesis_id: string;
  hypothesis_hash: string;
  /**
   * The hypothesis as proposed, verbatim.
   *
   * `hypothesis_hash` alone proves the hypothesis has not changed since it was
   * logged, but it cannot TELL you what was tested — a hash is a witness, not a
   * description. Without this field the durable artifact records a verdict on a
   * question it does not state, so anyone reading `decisions.jsonl` has to take
   * the verdict on trust. That is the wrong way round for a submission whose
   * claim is that every verdict is checkable from the record.
   *
   * Storing both is strictly stronger than storing either: the object is
   * readable, and the hash beside it is recomputable from the object, so a
   * reader can confirm the two agree rather than believing that they do.
   *
   * Optional because it is an addition — entries written before it existed
   * verify exactly as they did before, and the verifier reports the absence
   * rather than failing the line.
   */
  hypothesis?: unknown;
  session_id: string;
  timestamp_utc: string;
  partition_used: PartitionName;
  generator: string;

  ic: number;
  t_stat: number;
  hit_rate: number;
  n_obs: number;
  baseline_ic: number;

  bh_adjusted_threshold: number;
  raw_p_value: number;
  gate_decision: string;
  gate_reason: KillReason | null;
  gate_detail: string;

  total_hypotheses_attempted_this_session: number;
  fdr_level: number;
  policy_version: string;
  policy_sha256: string;
  partitions_sha256: string;

  /**
   * One hash over every frozen (symbol, partition) file backing this session.
   *
   * WHY THIS FIELD EXISTS. The protocol's central claim is that every verdict
   * came from a fixed, disclosed dataset. A hash of the policy proves the
   * thresholds did not move; this proves the DATA did not move either. Without
   * it, a verdict is reproducible only if you also happen to know which bytes
   * were on disk when it was reached.
   *
   * null means no frozen dataset backed the entry — the backtest read the live
   * API instead. That is recorded honestly rather than papered over with a
   * placeholder hash, because a verdict reached on live data is not comparable
   * to one reached on frozen data, and the log should say so.
   *
   * Recorded per entry rather than once per session: the value is constant in
   * normal operation, so any drift across a session's entries is visible
   * evidence that the data changed underneath a running session.
   */
  dataset_sha256: string | null;

  /** Present only when the hypothesis was rejected before any backtest. */
  schema_error?: string;

  entry_hash: string;
}

/** Everything except entry_hash — the exact payload that gets hashed. */
export type HashedPayload = Omit<DecisionLogEntry, 'entry_hash'>;

export function computeEntryHash(payload: HashedPayload): string {
  return 'sha256:' + sha256Hex(canonicalJson(payload));
}

export interface AppendContext {
  session_id: string;
  fdr_level: number;
  policy_version: string;
  policy_sha256: string;
  partitions_sha256: string;
  /** From frozenDatasetHash(). Null when the session is running on live data. */
  dataset_sha256: string | null;
}

/**
 * Assemble the per-session context from the preregistered config and the frozen
 * dataset.
 *
 * Exists so that no call site can construct an AppendContext by hand and quietly
 * omit a provenance field. Every hash recorded here is an input to the entry
 * hash, so a missing one is not a cosmetic gap — it is a verdict that can no
 * longer be tied to the exact inputs that produced it.
 */
export function buildAppendContext(params: { sessionId: string; fdrLevel: number }): AppendContext {
  const policy = loadGatePolicy();
  const partitions = loadPartitions();
  return {
    session_id: params.sessionId,
    fdr_level: params.fdrLevel,
    policy_version: String(policy.data.policy_version),
    policy_sha256: policy.sha256,
    partitions_sha256: partitions.sha256,
    dataset_sha256: frozenDatasetHash(),
  };
}

export class DecisionLog {
  private readonly path: string;
  private lastHash: string;
  private count: number;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    const existing = this.readAll();
    this.count = existing.length;
    this.lastHash = existing.length ? existing[existing.length - 1]!.entry_hash : GENESIS_HASH;
  }

  get entryCount(): number {
    return this.count;
  }

  get headHash(): string {
    return this.lastHash;
  }

  readAll(): DecisionLogEntry[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const out: DecisionLogEntry[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      out.push(JSON.parse(trimmed) as DecisionLogEntry);
    }
    return out;
  }

  /**
   * Append one decision. Returns the written entry.
   *
   * `entry_id` is derived from the count, so it is dense and gap-free: deleting
   * a line is detectable because the ids stop being contiguous as well as
   * because the chain breaks.
   */
  append(params: {
    ctx: AppendContext;
    hypothesisId: string;
    hypothesis: unknown;
    partitionUsed: PartitionName;
    generator: string;
    decision: GateDecision;
    backtest: {
      ic: number;
      t_stat: number;
      hit_rate: number;
      n_obs: number;
      baseline_ic: number;
    };
    schemaError?: string;
  }): DecisionLogEntry {
    const entryId = `E-${String(this.count + 1).padStart(4, '0')}`;

    const payload: HashedPayload = {
      entry_id: entryId,
      prev_hash: this.lastHash,
      hypothesis_id: params.hypothesisId,
      hypothesis_hash: 'sha256:' + sha256Hex(canonicalJson(params.hypothesis)),
      hypothesis: params.hypothesis,
      session_id: params.ctx.session_id,
      timestamp_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      partition_used: params.partitionUsed,
      generator: params.generator,

      ic: params.backtest.ic,
      t_stat: params.backtest.t_stat,
      hit_rate: params.backtest.hit_rate,
      n_obs: params.backtest.n_obs,
      baseline_ic: params.backtest.baseline_ic,

      bh_adjusted_threshold: params.decision.bh_adjusted_threshold,
      raw_p_value: params.decision.raw_p_value,
      gate_decision: params.decision.decision,
      gate_reason: params.decision.reason,
      gate_detail: params.decision.detail,

      total_hypotheses_attempted_this_session: this.count + 1,
      fdr_level: params.ctx.fdr_level,
      policy_version: params.ctx.policy_version,
      policy_sha256: params.ctx.policy_sha256,
      partitions_sha256: params.ctx.partitions_sha256,
      dataset_sha256: params.ctx.dataset_sha256,
    };

    if (params.schemaError !== undefined) payload.schema_error = params.schemaError;

    const entry: DecisionLogEntry = {
      ...payload,
      entry_hash: computeEntryHash(payload),
    };

    appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8');
    this.lastHash = entry.entry_hash;
    this.count += 1;
    return entry;
  }

  /**
   * Append a CIRCUIT_BREAK entry (build spec §10).
   *
   * Deliberately the SAME shape as a decision entry rather than a separate
   * record type. Two reasons, both about not weakening the guarantees:
   *
   *  1. The verifier's checks — hash recomputation, chain linkage, dense ids,
   *     monotonic timestamps, dense attempt counter — all keep applying to it.
   *     A break entry in a different format would need its own verification
   *     path, and a second path is a second thing that can be wrong.
   *
   *  2. The chain stays a single sequence. If breaks were stored elsewhere, the
   *     log would have gaps in its history exactly at the moments something
   *     interesting happened.
   *
   * The counters and metrics are the ones standing at the moment of the break,
   * so `total_hypotheses_attempted_this_session` still advances by one and the
   * dense-counter check is unaffected.
   */
  appendCircuitBreak(params: {
    ctx: AppendContext;
    reason: string;
    detail: string;
    /** Signal/target standing at the break, for context. Null when unavailable. */
    lastHypothesisId?: string;
  }): DecisionLogEntry {
    const entryId = `E-${String(this.count + 1).padStart(4, '0')}`;

    const payload: HashedPayload = {
      entry_id: entryId,
      prev_hash: this.lastHash,
      hypothesis_id: params.lastHypothesisId ?? 'SYSTEM',
      // No hypothesis is being judged, so there is nothing to hash. A hash of
      // the empty object would be misleading — it would look like a hypothesis
      // was hashed. The constant says plainly that none was.
      hypothesis_hash: 'sha256:none:circuit_break',
      session_id: params.ctx.session_id,
      timestamp_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      partition_used: 'DISCOVERY',
      generator: 'system',

      ic: 0,
      t_stat: 0,
      hit_rate: 0,
      n_obs: 0,
      baseline_ic: 0,

      bh_adjusted_threshold: 0,
      raw_p_value: 1,
      gate_decision: 'CIRCUIT_BREAK',
      gate_reason: null,
      gate_detail: `${params.reason}: ${params.detail}`,

      total_hypotheses_attempted_this_session: this.count + 1,
      fdr_level: params.ctx.fdr_level,
      policy_version: params.ctx.policy_version,
      policy_sha256: params.ctx.policy_sha256,
      partitions_sha256: params.ctx.partitions_sha256,
      dataset_sha256: params.ctx.dataset_sha256,
    };

    const entry: DecisionLogEntry = { ...payload, entry_hash: computeEntryHash(payload) };
    appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8');
    this.lastHash = entry.entry_hash;
    this.count += 1;
    return entry;
  }
}
