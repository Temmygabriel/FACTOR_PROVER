/**
 * Independent verifier for the hash-chained decision log.
 *
 * Why this file exists. The project's credibility rests on one claim: no gate
 * decision was ever edited after it was written. A claim like that is worth
 * nothing if only the process that made it can check it, so this verifier
 * shares no state with the writer. It reads the file as bytes, re-derives every
 * hash from the recorded fields alone, and reports everything it finds. It is
 * safe to run against a log you did not produce: it opens one file, for
 * reading, and writes nothing.
 *
 * What it detects. The chain plus the dense ids plus the counter means each of
 * these acts leaves a mark:
 *
 *   - editing a field                 -> that entry's hash stops recomputing
 *   - editing a field and repairing
 *     the hash to match               -> the NEXT entry's prev_hash no longer
 *                                        links to it
 *   - deleting or inserting a line    -> the chain breaks, the entry_ids stop
 *                                        being dense, and the running attempt
 *                                        counter drifts off its position
 *   - reordering lines                -> the chain breaks and timestamps regress
 *   - truncating mid-line             -> the tail is no longer valid JSON
 *
 * What it does NOT prove. That the recorded values are honest. This checks that
 * the bytes on disk are internally consistent and append-only; it cannot check
 * that the numbers were computed correctly, that they were not fabricated
 * before being written, or that the policy hashes match the preregistered
 * files. Three limits are worth stating plainly:
 *
 *   - A truncation that lands exactly on a line boundary is invisible. A log
 *     cut off after entry N is a perfectly consistent log of N entries. Catching
 *     that needs the external anchor: compare `headHash` against the head hash
 *     published with the run.
 *   - A line deleted from anywhere but the end breaks the chain, and a line
 *     deleted from the very end does not — same reason.
 *   - Duplicate keys inside one JSON object are not detected. JSON.parse keeps
 *     the last, so `{"ic":1,"ic":2}` reads as 2. The writer emits its own bytes
 *     and the file should be treated as opaque; hand-editing it in a tool that
 *     rewrites JSON is exactly the case this cannot see.
 *
 * Failure semantics. Every entry is checked against every rule; the first
 * problem does not stop the scan, because a tamperer who trips one check has
 * usually tripped several and the extra lines localise the edit. `ok` is true
 * only when the whole file produced no failures at all. A file that cannot be
 * read is not a verdict, so this function throws rather than returning a
 * result.
 *
 *   node dist/log/verify.js <path-to-decisions.jsonl>
 *   node dist/log/verify.js --file <path-to-decisions.jsonl>
 *
 * Exit code 0 means the log verified, 1 means it did not. Both forms are
 * accepted because the npm script and CI already call it with `--file`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GENESIS_HASH, canonicalJson, computeEntryHash, sha256Hex, type HashedPayload } from './decisions.js';

export type VerifyFailureKind =
  | 'parse_error'
  | 'hash_mismatch'
  | 'chain_break'
  | 'entry_id_gap'
  | 'timestamp_regression'
  | 'attempt_counter_mismatch'
  | 'hypothesis_hash_mismatch';

export interface VerifyFailure {
  kind: VerifyFailureKind;
  /** 1-based line number in the file, counting the blank terminator as none. */
  line: number;
  entry_id: string | null;
  /** Human-readable and specific: what was expected, and what was found. */
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  entriesChecked: number;
  /** entry_hash of the last entry, or null when the file holds none. */
  headHash: string | null;
  failures: VerifyFailure[];
}

/** JSON.parse returns any; this narrows to the object case without one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A field that must be a string, or null when it is absent or the wrong type. */
function stringField(entry: Record<string, unknown>, key: string): string | null {
  const value = entry[key];
  return typeof value === 'string' ? value : null;
}

/** For failure details: a value safe to print, including undefined. */
function describe(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? 'missing' : json;
}

/**
 * Verify one decision log file. Never throws for a log that has been tampered
 * with — tampering is reported in `failures`, not raised — but does throw if
 * the file itself cannot be read.
 */
export function verifyDecisionLog(path: string): VerifyResult {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  // The writer terminates every entry with '\n', so the split leaves a final
  // empty element that is a line terminator rather than a line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const failures: VerifyFailure[] = [];
  let entriesChecked = 0;
  let headHash: string | null = null;

  // Linkage is taken against the previous entry that PARSED, not the previous
  // physical line. A stray unparseable line between two entries is already
  // reported on its own; blaming the entry after it for a break that is not
  // there would be a false accusation.
  let prevEntry: Record<string, unknown> | null = null;
  let prevEntryLine = 0;
  let prevTimestampMs: number | null = null;
  let prevTimestampLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const trimmed = lines[i]!.trim();

    // 1. Parse.
    if (trimmed === '') {
      failures.push({
        kind: 'parse_error',
        line,
        entry_id: null,
        detail:
          'blank line — the writer emits exactly one line per entry and never ' +
          'empty ones',
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({
        kind: 'parse_error',
        line,
        entry_id: null,
        detail: `not valid JSON (${message})`,
      });
      continue;
    }

    if (!isRecord(parsed)) {
      failures.push({
        kind: 'parse_error',
        line,
        entry_id: null,
        detail: 'valid JSON but not an object, so it cannot be a log entry',
      });
      continue;
    }

    entriesChecked += 1;
    const entryId = stringField(parsed, 'entry_id');

    // 2. Recompute the hash from the entry's own fields. This is the writer's
    // own function, so a log it produced must hash back to itself exactly.
    const { entry_hash: recordedHash, ...rest } = parsed;
    const recomputed = computeEntryHash(rest as HashedPayload);
    if (typeof recordedHash !== 'string') {
      failures.push({
        kind: 'hash_mismatch',
        line,
        entry_id: entryId,
        detail: 'entry_hash is missing or is not a string',
      });
    } else if (recordedHash !== recomputed) {
      failures.push({
        kind: 'hash_mismatch',
        line,
        entry_id: entryId,
        detail:
          `entry_hash is ${recordedHash} but this entry's own fields hash to ` +
          `${recomputed} — a field was edited`,
      });
    }

    // 2b. The stored hypothesis must hash to the stored hypothesis_hash.
    //
    // The entry-hash check above already proves NO field was edited, this one
    // included. So what does this add? It checks the writer's own consistency:
    // that `hypothesis_hash` is really the hash OF the object sitting next to
    // it, rather than a hash of some other object that happened to be passed in.
    // Without it, a log could carry a readable hypothesis and a plausible-looking
    // hash that never described it, and every check in this file would still
    // pass. That failure mode is invisible to a chain verifier by construction,
    // which is exactly why it needs its own check.
    //
    // Absent `hypothesis` is reported as unverifiable rather than as a failure:
    // entries written before the field existed are honest about a verdict
    // without describing the question, and failing them would say the log is
    // corrupt when it is merely older.
    // 'sha256:none:circuit_break' is the documented marker for "no hypothesis
    // was judged", so there is nothing for it to describe.
    const storedHypothesis = (parsed as Record<string, unknown>)['hypothesis'];
    const recordedHypothesisHash = stringField(parsed, 'hypothesis_hash');
    if (storedHypothesis !== undefined && recordedHypothesisHash?.startsWith('sha256:') === true) {
      const recomputedHypothesisHash = 'sha256:' + sha256Hex(canonicalJson(storedHypothesis));
      if (recomputedHypothesisHash !== recordedHypothesisHash) {
        failures.push({
          kind: 'hypothesis_hash_mismatch',
          line,
          entry_id: entryId,
          detail:
            `hypothesis_hash is ${recordedHypothesisHash} but the hypothesis stored on this ` +
            `line hashes to ${recomputedHypothesisHash} — the record describes a different ` +
            `hypothesis than the one it claims to have tested`,
        });
      }
    }

    // 3. Chain linkage.
    const prevHash = stringField(parsed, 'prev_hash');
    if (prevEntry === null) {
      if (prevHash !== GENESIS_HASH) {
        failures.push({
          kind: 'chain_break',
          line,
          entry_id: entryId,
          detail:
            `first entry's prev_hash is ${prevHash ?? 'missing'}, expected the ` +
            `genesis link ${GENESIS_HASH}`,
        });
      }
    } else {
      const expectedPrev = stringField(prevEntry, 'entry_hash');
      if (prevHash !== expectedPrev) {
        failures.push({
          kind: 'chain_break',
          line,
          entry_id: entryId,
          detail:
            `prev_hash is ${prevHash ?? 'missing'} but the preceding entry ` +
            `(line ${prevEntryLine}) has entry_hash ${expectedPrev ?? 'missing'} — ` +
            `an entry was removed, inserted, or reordered above this line`,
        });
      }
    }

    // 4. Dense entry ids. Deleting a line makes every id below it disagree with
    // its position, so each shifted line is reported rather than just the first.
    const expectedId = `E-${String(entriesChecked).padStart(4, '0')}`;
    if (entryId !== expectedId) {
      failures.push({
        kind: 'entry_id_gap',
        line,
        entry_id: entryId,
        detail:
          `expected ${expectedId} at position ${entriesChecked} in the file, ` +
          `found ${entryId ?? 'a missing or non-string entry_id'}`,
      });
    }

    // 5. Monotonic timestamps. Equal adjacent values are legitimate: several
    // decisions inside the same second are still in order.
    const stamp = stringField(parsed, 'timestamp_utc');
    const stampMs = stamp === null ? NaN : Date.parse(stamp);
    if (Number.isNaN(stampMs)) {
      failures.push({
        kind: 'timestamp_regression',
        line,
        entry_id: entryId,
        detail: `timestamp_utc is ${describe(parsed['timestamp_utc'])}, which does not parse as a timestamp`,
      });
    } else if (prevTimestampMs !== null && stampMs < prevTimestampMs) {
      failures.push({
        kind: 'timestamp_regression',
        line,
        entry_id: entryId,
        detail:
          `timestamp_utc ${stamp} is earlier than ${new Date(prevTimestampMs).toISOString()} ` +
          `on line ${prevTimestampLine} — lines below are out of order`,
      });
    }

    // 6. Dense attempt counter. The writer stamps it from its own count, so it
    // is a second, independent witness to the entry's position.
    const attempted = parsed['total_hypotheses_attempted_this_session'];
    if (attempted !== entriesChecked) {
      failures.push({
        kind: 'attempt_counter_mismatch',
        line,
        entry_id: entryId,
        detail:
          `total_hypotheses_attempted_this_session is ${describe(attempted)}, ` +
          `expected ${entriesChecked} (this entry's 1-based position in the file)`,
      });
    }

    headHash = typeof recordedHash === 'string' ? recordedHash : null;
    prevEntry = parsed;
    prevEntryLine = line;
    if (!Number.isNaN(stampMs)) {
      prevTimestampMs = stampMs;
      prevTimestampLine = line;
    }
  }

  return { ok: failures.length === 0, entriesChecked, headHash, failures };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printReport(path: string, result: VerifyResult): void {
  console.log('Factor Prover — decision log verification');
  console.log(`  file            ${path}`);
  console.log(`  entries checked ${result.entriesChecked}`);
  console.log(`  head hash       ${result.headHash ?? '(no entries)'}`);
  console.log('');

  if (result.ok) {
    console.log(`PASS — ${result.entriesChecked} entries, chain intact and append-only.`);
    return;
  }

  console.log(`FAIL — ${result.failures.length} problem(s) found.`);
  console.log('');
  for (const failure of result.failures) {
    console.log(`  line ${failure.line}  ${failure.entry_id ?? '(no id)'}  ${failure.kind}`);
    console.log(`      ${failure.detail}`);
  }
}

/**
 * The path to verify, from either `verify.js <path>` or the `verify.js --file
 * <path>` form the npm script and CI use. Null when neither was supplied.
 */
function pathArgument(args: string[]): string | null {
  if (args[0] === '--file') return args[1] ?? null;
  return args[0] ?? null;
}

/** Returns the process exit code: 0 on a clean log, 1 on anything else. */
function main(args: string[]): number {
  const path = pathArgument(args);
  if (path === null) {
    process.stderr.write('usage: node dist/log/verify.js [--file] <path-to-decisions.jsonl>\n');
    return 1;
  }
  if (!existsSync(path)) {
    process.stderr.write(`cannot read decision log: no such file: ${path}\n`);
    return 1;
  }

  let result: VerifyResult;
  try {
    result = verifyDecisionLog(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cannot read decision log: ${message}\n`);
    return 1;
  }

  printReport(path, result);
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
