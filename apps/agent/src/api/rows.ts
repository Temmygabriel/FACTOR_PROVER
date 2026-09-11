/**
 * Decision-log entry → UI row.
 *
 * The log is the durable artifact and the UI is a view of it, so this file is
 * the only place the two shapes meet. That matters for one reason above the
 * rest: a row shown to a reader must be derivable from the record, not from
 * anything the running process happened to be holding in memory. Everything
 * here is computed from the entry's own stored fields plus the preregistered
 * policy, so the same row can be rebuilt from `decisions.jsonl` alone.
 *
 * The one thing that is NOT recomputed is the `checks` block, because the log
 * does not store it — it stores the numbers the checks were computed FROM. So
 * the checks are re-derived here using the same comparisons the gate uses.
 * That is deliberate: it means the five-bar verdict stamp in the UI is a
 * function of the recorded metrics, and cannot drift from them.
 */

import type { DecisionRow } from './contract.js';
import type { GatePolicy } from '../config.js';
import type { DecisionLogEntry } from '../log/decisions.js';
import type {
  Direction,
  ExperimentFamily,
  KillReason,
  Operator,
  RTokenSymbol,
  SignalId,
} from '../types.js';

/**
 * Recompute the five gate checks from the recorded metrics.
 *
 * Every comparison mirrors `adjudicateHypothesis` exactly, including the
 * absolute-value treatment of the floors: a strongly negative IC clears the IC
 * floor just as a positive one does, because the floors ask whether a
 * relationship is detectable, not which way it points. Re-deriving them any
 * other way here would make the UI disagree with the gate about the same entry.
 *
 * A CIRCUIT_BREAK entry has no hypothesis and all-zero metrics, so every check
 * comes out false — which is literally correct rather than a special case: zero
 * observations does fail an observation floor of 100. The UI keys off
 * `decision === 'CIRCUIT_BREAK'` to render it as its own kind of row.
 */
export function deriveChecks(
  entry: DecisionLogEntry,
  policy: GatePolicy,
): DecisionRow['checks'] {
  return {
    passed_min_obs: entry.n_obs >= policy.min_obs,
    passed_ic_floor: Math.abs(entry.ic) >= policy.min_ic,
    passed_t_stat_floor: Math.abs(entry.t_stat) >= policy.min_t_stat,
    passed_baseline_beat: !policy.require_baseline_beat || Math.abs(entry.ic) > Math.abs(entry.baseline_ic),
    // The bar this hypothesis faced at its own rank, as recorded at the time.
    // Comparing against a freshly computed threshold would be wrong: the
    // threshold depends on the family size when the verdict was reached, and the
    // family has grown since. The recorded value is the historical fact.
    passed_bh: entry.raw_p_value <= entry.bh_adjusted_threshold,
  };
}

/**
 * Read the stored hypothesis into the row's display shape.
 *
 * Returns null when the field is absent (an entry predating it) or malformed.
 * Never throws: a log written by a different version of this code should render
 * as a row with an unstated question, not take down the log endpoint.
 */
function readHypothesis(entry: DecisionLogEntry): DecisionRow['hypothesis'] {
  const h = entry.hypothesis;
  if (typeof h !== 'object' || h === null) return null;
  const o = h as Record<string, unknown>;
  const condition = o['condition'];
  if (typeof condition !== 'object' || condition === null) return null;
  const c = condition as Record<string, unknown>;

  if (
    typeof o['signal'] !== 'string' ||
    typeof o['target'] !== 'string' ||
    typeof o['direction'] !== 'string' ||
    typeof o['forward_return_minutes'] !== 'number' ||
    typeof o['experiment_family'] !== 'string' ||
    typeof c['operator'] !== 'string' ||
    typeof c['threshold'] !== 'number' ||
    typeof c['lookback_minutes'] !== 'number'
  ) {
    return null;
  }

  return {
    signal: o['signal'] as SignalId,
    target: o['target'] as RTokenSymbol,
    direction: o['direction'] as Direction,
    condition: {
      operator: c['operator'] as Operator,
      threshold: c['threshold'],
      lookback_minutes: c['lookback_minutes'],
    },
    forward_return_minutes: o['forward_return_minutes'],
    experiment_family: o['experiment_family'] as ExperimentFamily,
  };
}

export function entryToRow(entry: DecisionLogEntry, policy: GatePolicy): DecisionRow {
  return {
    entry_id: entry.entry_id,
    entry_hash: entry.entry_hash,
    prev_hash: entry.prev_hash,
    hypothesis_id: entry.hypothesis_id,
    timestamp_utc: entry.timestamp_utc,
    generator: entry.generator,
    partition_used: entry.partition_used,
    decision: entry.gate_decision as DecisionRow['decision'],
    reason: (entry.gate_reason ?? null) as KillReason | null,
    detail: entry.gate_detail,
    hypothesis: readHypothesis(entry),
    metrics: {
      ic: entry.ic,
      t_stat: entry.t_stat,
      hit_rate: entry.hit_rate,
      n_obs: entry.n_obs,
      baseline_ic: entry.baseline_ic,
      raw_p_value: entry.raw_p_value,
      bh_adjusted_threshold: entry.bh_adjusted_threshold,
    },
    checks: deriveChecks(entry, policy),
    ...(entry.schema_error !== undefined ? { schema_error: entry.schema_error } : {}),
  };
}

/**
 * Newest first, one page at a time.
 *
 * `before` is an entry_id cursor. Ids are dense (`E-0001`, `E-0002`, ...) so
 * ordering by id is the same as ordering by position, and the cursor is a
 * string comparison rather than a timestamp comparison — which matters because
 * two entries in the same session can share a timestamp to the second, and a
 * timestamp cursor would then skip or repeat rows.
 */
export function pageRows(
  entries: readonly DecisionLogEntry[],
  policy: GatePolicy,
  opts: { limit: number; before?: string | null },
): { rows: DecisionRow[]; next_cursor: string | null } {
  const limit = Math.max(1, Math.min(opts.limit, 500));

  let pool = entries;
  if (opts.before) {
    const idx = entries.findIndex((e) => e.entry_id === opts.before);
    // An unknown cursor returns the whole log rather than nothing: a stale
    // cursor after a log reset should show data, not an empty page that reads
    // as "no decisions were made".
    if (idx > 0) pool = entries.slice(0, idx);
  }

  const newestFirst = [...pool].reverse();
  const page = newestFirst.slice(0, limit);
  const hasMore = newestFirst.length > limit;

  return {
    rows: page.map((e) => entryToRow(e, policy)),
    next_cursor: hasMore ? page[page.length - 1]!.entry_id : null,
  };
}
