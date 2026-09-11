/**
 * The hash-chained, append-only decision log, and the verifier that checks it.
 *
 * The project's credibility rests on one claim: no gate decision was ever edited
 * after it was written. A claim like that is worth nothing if only the process
 * that made it can check it — so the verifier shares no state with the writer,
 * re-derives every hash from the recorded fields alone, and reports everything
 * it finds.
 *
 * The cases below are the leaves a tamperer would try to turn over. Where one of
 * them is INVISIBLE, that is asserted too: a verifier whose limits are not
 * written down invites people to read more into a PASS than it says.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DecisionLog,
  GENESIS_HASH,
  buildAppendContext,
  canonicalJson,
  canonicalize,
  computeEntryHash,
  sha256Hex,
  type AppendContext,
  type DecisionLogEntry,
  type HashedPayload,
} from '../src/log/decisions.js';
import { verifyDecisionLog } from '../src/log/verify.js';
import { __setFrozenManifestForTest, __clearFrozenCache } from '../src/data/frozen.js';
import { loadGatePolicy, loadPartitions } from '../src/config.js';
import type { GateDecision } from '../src/types.js';

const BASE_MS = Date.parse('2026-09-11T00:00:00Z');

const CTX: AppendContext = {
  session_id: 'S-2026-09-11',
  fdr_level: 0.1,
  policy_version: 'v1.0',
  policy_sha256: 'sha256:' + '1'.repeat(64),
  partitions_sha256: 'sha256:' + '2'.repeat(64),
  dataset_sha256: 'sha256:' + '3'.repeat(64),
};

function gateDecision(over: Partial<GateDecision> = {}): GateDecision {
  return {
    decision: 'KILL',
    reason: 'ic_below_floor',
    detail: '|IC| = 0.0100 is below the preregistered floor of 0.04.',
    bh_adjusted_threshold: 0.02,
    raw_p_value: 0.4,
    checks: {
      passed_min_obs: true,
      passed_bh: true,
      passed_ic_floor: false,
      passed_t_stat_floor: true,
      passed_baseline_beat: true,
    },
    ...over,
  };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fp-log-'));
  path = join(dir, 'decisions.jsonl');
  // The log stamps itself from the wall clock with no injection seam, so the
  // clock is faked rather than the log being given one: dates that advance by a
  // second per entry are what make a REORDER detectable.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE_MS));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
  __setFrozenManifestForTest(null);
  __clearFrozenCache();
});

/** Append `n` entries, one second apart, and return them. */
function seed(log: DecisionLog, n: number): DecisionLogEntry[] {
  const out: DecisionLogEntry[] = [];
  for (let i = 0; i < n; i++) {
    vi.setSystemTime(new Date(BASE_MS + i * 1000));
    out.push(
      log.append({
        ctx: CTX,
        hypothesisId: `H-${String(i + 1).padStart(4, '0')}`,
        hypothesis: { signal: 'btc_funding_rate', threshold: 0.00005, attempt: i },
        partitionUsed: 'DISCOVERY',
        generator: 'deterministic',
        decision: gateDecision(),
        backtest: {
          ic: 0.01 + i / 100,
          t_stat: 1 + i,
          hit_rate: 0.51,
          n_obs: 400 + i,
          baseline_ic: 0.02,
        },
      }),
    );
  }
  return out;
}

function lines(): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
}

function writeLines(ls: string[]): void {
  writeFileSync(path, ls.join('\n') + '\n', 'utf8');
}

describe('appending and verifying', () => {
  it('writes a log the verifier accepts', () => {
    const log = new DecisionLog(path);
    const entries = seed(log, 3);

    const result = verifyDecisionLog(path);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.entriesChecked).toBe(3);
    expect(result.headHash).toBe(entries[2]!.entry_hash);
  });

  it('starts at the genesis link and chains every entry to the previous one', () => {
    const log = new DecisionLog(path);
    const entries = seed(log, 3);

    expect(entries[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(entries[1]!.prev_hash).toBe(entries[0]!.entry_hash);
    expect(entries[2]!.prev_hash).toBe(entries[1]!.entry_hash);
  });

  it('numbers entries densely from E-0001', () => {
    // Dense because it is a second, independent witness to the entry's position:
    // deleting a line makes every id below it disagree with where it sits.
    const log = new DecisionLog(path);
    const entries = seed(log, 3);
    expect(entries.map((e) => e.entry_id)).toEqual(['E-0001', 'E-0002', 'E-0003']);
  });

  it('counts attempts densely, including kills', () => {
    // The counter must never be limited to hypotheses that passed — that would
    // void the multiple-testing correction it exists to witness.
    const log = new DecisionLog(path);
    const entries = seed(log, 3);
    expect(entries.map((e) => e.total_hypotheses_attempted_this_session)).toEqual([1, 2, 3]);
  });

  it('truncates the timestamp to whole seconds, matching the rest of the log', () => {
    const log = new DecisionLog(path);
    vi.setSystemTime(new Date('2026-09-11T12:34:56.789Z'));
    const entry = log.append({
      ctx: CTX,
      hypothesisId: 'H-0001',
      hypothesis: {},
      partitionUsed: 'DISCOVERY',
      generator: 'deterministic',
      decision: gateDecision(),
      backtest: { ic: 0, t_stat: 0, hit_rate: 0, n_obs: 0, baseline_ic: 0 },
    });
    expect(entry.timestamp_utc).toBe('2026-09-11T12:34:56Z');
  });

  it('records the hypothesis by hash rather than by value', () => {
    const log = new DecisionLog(path);
    const entry = log.append({
      ctx: CTX,
      hypothesisId: 'H-0001',
      hypothesis: { signal: 'btc_funding_rate', condition: { operator: 'gt', threshold: 0.00005 } },
      partitionUsed: 'DISCOVERY',
      generator: 'deterministic',
      decision: gateDecision(),
      backtest: { ic: 0, t_stat: 0, hit_rate: 0, n_obs: 0, baseline_ic: 0 },
    });
    expect(entry.hypothesis_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.hypothesis_hash).toBe(
      'sha256:' + sha256Hex(canonicalJson({ signal: 'btc_funding_rate', condition: { operator: 'gt', threshold: 0.00005 } })),
    );
  });

  it('records a schema rejection as an optional field that changes the hash', () => {
    // The schema_error key is present only when a rejection happened, and it IS
    // part of the hashed payload — so an entry cannot be re-labelled from
    // "schema rejected" to "genuinely tested" without breaking the chain.
    const log = new DecisionLog(path);
    const without = log.append({
      ctx: CTX,
      hypothesisId: 'H-0001',
      hypothesis: {},
      partitionUsed: 'DISCOVERY',
      generator: 'deterministic',
      decision: gateDecision(),
      backtest: { ic: 0, t_stat: 0, hit_rate: 0, n_obs: 0, baseline_ic: 0 },
    });
    vi.setSystemTime(new Date(BASE_MS + 1000));
    const withError = log.append({
      ctx: CTX,
      hypothesisId: 'H-0002',
      hypothesis: {},
      partitionUsed: 'DISCOVERY',
      generator: 'deterministic',
      decision: gateDecision(),
      backtest: { ic: 0, t_stat: 0, hit_rate: 0, n_obs: 0, baseline_ic: 0 },
      schemaError: 'condition.threshold 0.0001 can never be satisfied',
    });

    expect(without).not.toHaveProperty('schema_error');
    expect(withError.schema_error).toMatch(/can never be satisfied/);
    expect(verifyDecisionLog(path).ok).toBe(true);

    // Strip the key and the entry stops hashing back to itself.
    const ls = lines();
    const e = JSON.parse(ls[1]!) as Record<string, unknown>;
    delete e['schema_error'];
    ls[1] = JSON.stringify(e);
    writeLines(ls);
    expect(verifyDecisionLog(path).failures.map((f) => f.kind)).toContain('hash_mismatch');
  });

  it('reopens an existing log and continues the chain rather than restarting it', () => {
    const first = new DecisionLog(path);
    seed(first, 2);

    const second = new DecisionLog(path);
    expect(second.entryCount).toBe(2);
    expect(second.headHash).toBe(first.headHash);
    vi.setSystemTime(new Date(BASE_MS + 2000));
    const third = second.append({
      ctx: CTX,
      hypothesisId: 'H-0003',
      hypothesis: {},
      partitionUsed: 'DISCOVERY',
      generator: 'deterministic',
      decision: gateDecision(),
      backtest: { ic: 0, t_stat: 0, hit_rate: 0, n_obs: 0, baseline_ic: 0 },
    });

    expect(third.entry_id).toBe('E-0003');
    expect(third.prev_hash).toBe(first.headHash);
    expect(verifyDecisionLog(path).ok).toBe(true);
  });

  it('exposes the entry count and head hash a caller needs to publish', () => {
    const log = new DecisionLog(path);
    expect(log.entryCount).toBe(0);
    expect(log.headHash).toBe(GENESIS_HASH);
    const entries = seed(log, 2);
    expect(log.entryCount).toBe(2);
    expect(log.headHash).toBe(entries[1]!.entry_hash);
  });
});

describe('tampering: editing a field', () => {
  it('is caught by the entry’s own hash', () => {
    const log = new DecisionLog(path);
    seed(log, 3);

    const entries = log.readAll();
    entries[1]!.ic = 0.99;
    writeLines(entries.map((e) => JSON.stringify(e)));

    const result = verifyDecisionLog(path);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ kind: 'hash_mismatch', line: 2, entry_id: 'E-0002' });
    expect(result.failures[0]!.detail).toMatch(/a field was edited/);
  });

  it('is caught for the gate DECISION, which is the field that matters most', () => {
    const log = new DecisionLog(path);
    seed(log, 2);

    const entries = log.readAll();
    entries[0]!.gate_decision = 'PROMOTE';
    entries[0]!.gate_reason = null;
    writeLines(entries.map((e) => JSON.stringify(e)));

    const result = verifyDecisionLog(path);
    expect(result.failures.some((f) => f.kind === 'hash_mismatch')).toBe(true);
  });

  it('is caught when a numeric metric is nudged by a hair', () => {
    const log = new DecisionLog(path);
    seed(log, 1);
    const entries = log.readAll();
    entries[0]!.t_stat = entries[0]!.t_stat + 1e-12;
    writeLines(entries.map((e) => JSON.stringify(e)));
    expect(verifyDecisionLog(path).failures[0]!.kind).toBe('hash_mismatch');
  });

  it('is caught even when the field is ADDED rather than changed', () => {
    // The hash covers the entry as written, so an extra key is as visible as a
    // modified one — a tamperer cannot smuggle in context that was not there.
    const log = new DecisionLog(path);
    seed(log, 1);
    const ls = lines();
    const e = JSON.parse(ls[0]!) as Record<string, unknown>;
    e['note'] = 'looks better than it was';
    ls[0] = JSON.stringify(e);
    writeLines(ls);
    expect(verifyDecisionLog(path).failures.map((f) => f.kind)).toEqual(['hash_mismatch']);
  });
});

describe('tampering: editing a field AND repairing the hash', () => {
  it('breaks the NEXT entry’s link, so the repair is visible one line down', () => {
    // This is the attack the chain exists for. Repairing the hash makes the
    // edited entry self-consistent, so only the successor's prev_hash catches
    // it — and it always does, because the successor was hashed before the edit.
    const log = new DecisionLog(path);
    seed(log, 3);

    const ls = lines();
    const edited = JSON.parse(ls[1]!) as Record<string, unknown>;
    edited['ic'] = 0.99;
    const { entry_hash: _dropped, ...rest } = edited;
    edited['entry_hash'] = computeEntryHash(rest as HashedPayload);
    ls[1] = JSON.stringify(edited);
    writeLines(ls);

    const result = verifyDecisionLog(path);
    expect(result.ok).toBe(false);
    // The edited entry itself now verifies.
    expect(result.failures.filter((f) => f.line === 2 && f.kind === 'hash_mismatch')).toEqual([]);
    // Its successor does not link to it any more.
    const chainBreak = result.failures.find((f) => f.kind === 'chain_break');
    expect(chainBreak).toMatchObject({ line: 3, entry_id: 'E-0003' });
    expect(chainBreak!.detail).toMatch(/an entry was removed, inserted, or reordered above this line/);
  });

  it('leaves NO trace when the edited entry is the LAST one and its hash is repaired', () => {
    // The other half of the blind spot, and the reason `headHash` is published
    // with a run: an edit to the final entry that repairs its own hash is
    // self-consistent, and there is no successor to disagree with it.
    const log = new DecisionLog(path);
    seed(log, 2);

    const ls = lines();
    const edited = JSON.parse(ls[1]!) as Record<string, unknown>;
    edited['ic'] = 0.99;
    const { entry_hash: _dropped, ...rest } = edited;
    edited['entry_hash'] = computeEntryHash(rest as HashedPayload);
    ls[1] = JSON.stringify(edited);
    writeLines(ls);

    const result = verifyDecisionLog(path);
    expect(result.ok).toBe(true);
    expect(result.entriesChecked).toBe(2);
  });
});

describe('tampering: deleting a line', () => {
  it('breaks the chain, the dense ids AND the attempt counter', () => {
    // Three independent witnesses, so a tamperer has to defeat all three.
    const log = new DecisionLog(path);
    seed(log, 4);

    const ls = lines();
    ls.splice(1, 1);
    writeLines(ls);

    const result = verifyDecisionLog(path);
    expect(result.ok).toBe(false);
    const kinds = new Set(result.failures.map((f) => f.kind));
    expect(kinds).toContain('chain_break');
    expect(kinds).toContain('entry_id_gap');
    expect(kinds).toContain('attempt_counter_mismatch');

    // The first surviving entry after the gap is reported as E-0003 where
    // E-0002 was expected, so the deletion is localised to a line.
    expect(result.failures.find((f) => f.kind === 'entry_id_gap')).toMatchObject({
      line: 2,
      entry_id: 'E-0003',
    });
  });

  it('is invisible when the deleted line is the LAST one', () => {
    // The documented blind spot, asserted rather than described. A log cut off
    // after entry N is a perfectly consistent log of N entries — catching that
    // needs the external anchor, i.e. comparing headHash against the head hash
    // published with the run.
    const log = new DecisionLog(path);
    seed(log, 3);
    const headOfThree = log.headHash;

    const ls = lines();
    ls.pop();
    writeLines(ls);

    const result = verifyDecisionLog(path);
    expect(result.ok).toBe(true);
    expect(result.entriesChecked).toBe(2);
    // Which is why this value matters: it is the only thing that catches it.
    expect(result.headHash).not.toBe(headOfThree);
  });
});

describe('tampering: duplicating, reordering, truncating', () => {
  it('catches a duplicated line through the chain, the dense ids AND the counter', () => {
    // A copy of entry k carries entry k's own prev_hash, which is the hash of
    // entry k-1 — not of the line now sitting above it. So the copy breaks the
    // chain on arrival, and the ids and counter both drift from their positions
    // for every line below it. Three independent witnesses to one edit.
    const log = new DecisionLog(path);
    seed(log, 3);

    const ls = lines();
    ls.splice(1, 0, ls[0]!);
    writeLines(ls);

    const result = verifyDecisionLog(path);
    expect(result.ok).toBe(false);
    const kinds = result.failures.map((f) => f.kind);
    expect(kinds).toContain('chain_break');
    expect(kinds).toContain('entry_id_gap');
    expect(kinds).toContain('attempt_counter_mismatch');
    // The duplicate is the line that fails: expected E-0002, found E-0001.
    expect(result.failures.find((f) => f.kind === 'entry_id_gap')).toMatchObject({
      line: 2,
      entry_id: 'E-0001',
    });
  });

  it('catches a reordering through the chain AND the timestamps', () => {
    const log = new DecisionLog(path);
    seed(log, 3);

    const ls = lines();
    const tmp = ls[0]!;
    ls[0] = ls[1]!;
    ls[1] = tmp;
    writeLines(ls);

    const result = verifyDecisionLog(path);
    expect(result.ok).toBe(false);
    const kinds = result.failures.map((f) => f.kind);
    expect(kinds).toContain('chain_break');
    expect(kinds).toContain('entry_id_gap');
    expect(kinds).toContain('timestamp_regression');
    // The first entry no longer carries the genesis link.
    expect(result.failures[0]).toMatchObject({ kind: 'chain_break', line: 1 });
    expect(result.failures[0]!.detail).toMatch(/expected the genesis link/);
  });

  it('catches a truncation that lands mid-line as a parse error', () => {
    const log = new DecisionLog(path);
    seed(log, 3);

    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.slice(0, text.length - 15), 'utf8');

    const result = verifyDecisionLog(path);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === 'parse_error')).toBe(true);
  });

  it('catches a blank line inserted anywhere', () => {
    // The writer emits exactly one line per entry and never empty ones, so a
    // blank line is always somebody else's edit.
    const log = new DecisionLog(path);
    seed(log, 2);

    const ls = lines();
    ls.splice(1, 0, '');
    writeFileSync(path, ls.join('\n') + '\n', 'utf8');

    const result = verifyDecisionLog(path);
    expect(result.failures.some((f) => f.kind === 'parse_error')).toBe(true);
  });

  it('catches a line replaced by valid JSON that is not an object', () => {
    const log = new DecisionLog(path);
    seed(log, 2);
    const ls = lines();
    ls[0] = '"a string"';
    writeLines(ls);
    const result = verifyDecisionLog(path);
    expect(result.failures[0]).toMatchObject({ kind: 'parse_error' });
    expect(result.failures[0]!.detail).toMatch(/not an object/);
  });

  it('catches an entry whose entry_hash was removed entirely', () => {
    const log = new DecisionLog(path);
    seed(log, 1);
    const ls = lines();
    const e = JSON.parse(ls[0]!) as Record<string, unknown>;
    delete e['entry_hash'];
    ls[0] = JSON.stringify(e);
    writeLines(ls);
    const result = verifyDecisionLog(path);
    expect(result.failures.some((f) => f.kind === 'hash_mismatch')).toBe(true);
    expect(result.failures.some((f) => f.kind === 'chain_break')).toBe(false);
  });
});

describe('CIRCUIT_BREAK entries', () => {
  it('are the SAME shape as a decision entry, so every check still applies', () => {
    // Two reasons it is one shape and not a separate record type: a second
    // format would need its own verification path, and the chain would then have
    // gaps in its history exactly at the moments something interesting happened.
    const log = new DecisionLog(path);
    seed(log, 1);
    vi.setSystemTime(new Date(BASE_MS + 1000));
    const brk = log.appendCircuitBreak({
      ctx: CTX,
      reason: 'degenerate_loop',
      detail: '4 of the last 5 hypotheses share the same signal and target',
      lastHypothesisId: 'H-0001',
    });

    expect(brk.entry_id).toBe('E-0002');
    expect(brk.gate_decision).toBe('CIRCUIT_BREAK');
    expect(brk.gate_reason).toBeNull();
    expect(brk.gate_detail).toBe(
      'degenerate_loop: 4 of the last 5 hypotheses share the same signal and target',
    );
    expect(brk.raw_p_value).toBe(1);
    expect(brk.hypothesis_hash).toBe('sha256:none:circuit_break');
    expect(brk.hypothesis_id).toBe('H-0001');
    expect(brk.total_hypotheses_attempted_this_session).toBe(2);
    expect(verifyDecisionLog(path).ok).toBe(true);
  });

  it('verifies through the full chain, including a decision BEFORE it and AFTER it', () => {
    const log = new DecisionLog(path);
    seed(log, 2);
    vi.setSystemTime(new Date(BASE_MS + 2000));
    log.appendCircuitBreak({ ctx: CTX, reason: 'max_promotes_per_day', detail: '10 of 10 promoted' });
    vi.setSystemTime(new Date(BASE_MS + 3000));
    log.append({
      ctx: CTX,
      hypothesisId: 'H-0003',
      hypothesis: { after: 'the break' },
      partitionUsed: 'DISCOVERY',
      generator: 'deterministic',
      decision: gateDecision(),
      backtest: { ic: 0, t_stat: 0, hit_rate: 0, n_obs: 0, baseline_ic: 0 },
    });

    const result = verifyDecisionLog(path);
    expect(result.ok).toBe(true);
    expect(result.entriesChecked).toBe(4);
    expect(result.headHash).toBe(log.headHash);
  });

  it('falls back to SYSTEM when no hypothesis was standing at the break', () => {
    const log = new DecisionLog(path);
    const brk = log.appendCircuitBreak({ ctx: CTX, reason: 'manual_reset_required', detail: 'x' });
    expect(brk.hypothesis_id).toBe('SYSTEM');
    expect(verifyDecisionLog(path).ok).toBe(true);
  });
});

describe('the verifier’s own contract', () => {
  it('throws when the file cannot be read, because that is not a verdict', () => {
    expect(() => verifyDecisionLog(join(dir, 'not-there.jsonl'))).toThrow();
  });

  it('accepts an empty file as a log of zero entries', () => {
    writeFileSync(path, '', 'utf8');
    const result = verifyDecisionLog(path);
    expect(result).toEqual({ ok: true, entriesChecked: 0, headHash: null, failures: [] });
  });

  it('does not stop at the first problem, so a tamper is localised', () => {
    // A tamperer who trips one check has usually tripped several, and the extra
    // lines are what say WHERE the edit was.
    const log = new DecisionLog(path);
    seed(log, 4);
    const ls = lines();
    ls.splice(1, 1);
    writeLines(ls);

    const result = verifyDecisionLog(path);
    expect(result.failures.length).toBeGreaterThan(1);
    expect(new Set(result.failures.map((f) => f.line)).size).toBeGreaterThan(1);
  });

  it('checks every rule for every entry, and reports ok only when nothing failed', () => {
    const log = new DecisionLog(path);
    seed(log, 2);
    expect(verifyDecisionLog(path).failures).toEqual([]);

    const ls = lines();
    const e = JSON.parse(ls[0]!) as Record<string, unknown>;
    e['entry_id'] = 'E-0009';
    e['timestamp_utc'] = 'not a timestamp';
    e['total_hypotheses_attempted_this_session'] = 99;
    ls[0] = JSON.stringify(e);
    writeLines(ls);

    const kinds = new Set(verifyDecisionLog(path).failures.map((f) => f.kind));
    expect(kinds).toContain('hash_mismatch');
    expect(kinds).toContain('entry_id_gap');
    expect(kinds).toContain('timestamp_regression');
    expect(kinds).toContain('attempt_counter_mismatch');
  });
});

describe('canonicalization', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toEqual({ a: { c: 3, d: 2 }, b: 1 });
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('leaves array ORDER alone, because order is data', () => {
    // Sorting array elements would change the meaning of the payload — the
    // `checks` block and any list of values are ordered for a reason.
    expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('makes the entry hash independent of key insertion order', () => {
    // Without this a re-serialization in the verifier would produce a different
    // hash for identical data, and every log would "fail" its own check.
    const a: HashedPayload = { entry_id: 'E-0001', ic: 0.5, t_stat: 3 } as HashedPayload;
    const b: HashedPayload = { t_stat: 3, ic: 0.5, entry_id: 'E-0001' } as HashedPayload;
    expect(computeEntryHash(a)).toBe(computeEntryHash(b));
  });

  it('hashes nested objects order-independently too', () => {
    const a: HashedPayload = { entry_id: 'E-0001', checks: { a: 1, b: 2 } } as unknown as HashedPayload;
    const b: HashedPayload = { entry_id: 'E-0001', checks: { b: 2, a: 1 } } as unknown as HashedPayload;
    expect(computeEntryHash(a)).toBe(computeEntryHash(b));
  });

  it('is sensitive to a changed value at any depth', () => {
    const a: HashedPayload = { entry_id: 'E-0001', checks: { a: 1 } } as unknown as HashedPayload;
    const b: HashedPayload = { entry_id: 'E-0001', checks: { a: 2 } } as unknown as HashedPayload;
    expect(computeEntryHash(a)).not.toBe(computeEntryHash(b));
  });

  it('prefixes every hash with the algorithm, so the scheme is self-describing', () => {
    expect(computeEntryHash({ entry_id: 'E-0001' } as HashedPayload)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(GENESIS_HASH).toBe('sha256:' + '0'.repeat(64));
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('buildAppendContext', () => {
  it('takes the config hashes from the preregistered files, not from the caller', () => {
    // Exists so no call site can build a context by hand and quietly omit a
    // provenance field — every hash here is an input to the entry hash.
    __setFrozenManifestForTest(null);
    __clearFrozenCache();

    const ctx = buildAppendContext({ sessionId: 'S-1', fdrLevel: 0.1 });
    expect(ctx.session_id).toBe('S-1');
    expect(ctx.fdr_level).toBe(0.1);
    expect(ctx.policy_version).toBe(String(loadGatePolicy().data.policy_version));
    expect(ctx.policy_sha256).toBe(loadGatePolicy().sha256);
    expect(ctx.partitions_sha256).toBe(loadPartitions().sha256);
    // Null is the honest value with no frozen store: it says the verdict rested
    // on live data, which is not comparable to one that did not.
    expect(ctx.dataset_sha256).toBeNull();
  });

  it('records a dataset hash when a frozen store is installed', () => {
    __setFrozenManifestForTest({
      manifest_version: 't',
      generated_at: '2026-09-11T00:00:00Z',
      entries: [
        {
          symbol: 'BTCUSDT',
          partition: 'DISCOVERY',
          kind: 'candles',
          startMs: 0,
          endMs: 1,
          rows: 1,
          sha256: 'sha256:' + '9'.repeat(64),
          file: 'x.json.gz',
          fetched_at: '2026-09-11T00:00:00Z',
          source: 'test',
        },
      ],
    });
    __clearFrozenCache();
    expect(buildAppendContext({ sessionId: 'S-1', fdrLevel: 0.05 }).dataset_sha256).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });
});
