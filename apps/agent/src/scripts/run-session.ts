/**
 * Headless one-shot session runner.
 *
 * WHY THIS EXISTS. The deployed agent runs on Render's free tier, which has no
 * persistent disk. The container is replaced when the service sleeps, and
 * `logs/decisions.jsonl` — a submission artifact, and the durable record the
 * whole credibility claim rests on — goes with it. A log that only ever exists
 * on a filesystem that forgets is not a record.
 *
 * So the session can also be run HERE, to completion, against the committed
 * frozen dataset, writing the log straight into the working tree where it can be
 * committed. No API keys and no network are required: with no provider
 * configured the loop falls through to the deterministic enumerator, which is a
 * pure function of the attempt index. That makes the run REPRODUCIBLE — the same
 * bound produces the same proposals, and therefore the same verdicts, so a
 * reader who does not trust the committed log can regenerate it rather than
 * believe it.
 *
 * The two things a re-run does NOT reproduce are the timestamps and the session
 * id, because there is no honest way to reproduce a clock. Both are inside the
 * hashes, so two runs of the same session have different head hashes while
 * agreeing on every decision. That is why this script CHECKS the reproducibility
 * claim rather than only asserting it: when a log already exists, its sequence
 * of (hypothesis, verdict) is compared against the new run's, and a difference
 * is a failure. See `substance()` below for exactly what is and is not compared,
 * and why comparing hashes would be the wrong test.
 *
 * WHAT IT DOES NOT DO. It opens no socket, places no order (the Execution Guard
 * refuses every intent without the paper-trading flag), and edits no policy. It
 * runs the same `SessionLoop` the HTTP server runs, with a bound on it.
 *
 * ONE FILE, ONE SESSION. If a log already exists this script REFUSES to run
 * until `--replace` is passed, and then it removes the file before starting.
 * Appending would technically verify — `entry_id` and
 * `total_hypotheses_attempted_this_session` are both stamped from the file's own
 * line count, so a second session would keep them dense — but it would make the
 * field name a lie: an entry reading "attempted this session: 400" in a session
 * that attempted forty. The file is also the artifact a judge reads as one run's
 * record, and a record of two runs spliced together is a different document.
 *
 * HOW TO RUN IT.
 *
 *   npm run run-session --workspace apps/agent
 *   npx tsx src/scripts/run-session.ts --iterations 200 --replace
 *
 * Exit code 0 only when the session ran, the log it wrote verifies, and — when
 * there was a previous log to compare against — it reproduced that log's
 * decisions. Anything else is non-zero, so a CI step cannot pass on a run that
 * did not happen or that did not reproduce.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadGatePolicy } from '../config.js';
import { verifyDecisionLog } from '../log/verify.js';
import { SessionLoop } from '../session/loop.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `apps/agent/logs/decisions.jsonl`, resolved from THIS FILE rather than from
 * the working directory.
 *
 * The loop's own `defaultLogPath()` is deliberately CWD-relative, because the
 * npm scripts run with apps/agent as the working directory. A runner started
 * from a repository root — which is what a CI step does — would then write its
 * log somewhere else entirely, and "the log is not where the workflow looks for
 * it" is indistinguishable from "the run failed".
 */
const DEFAULT_LOG_PATH = join(HERE, '..', '..', 'logs', 'decisions.jsonl');

/**
 * How many iterations to run when `--iterations` is not given.
 *
 * Read from the preregistered policy rather than restated here, so the default
 * can never drift from the rule the run is actually subject to. It is the same
 * number the circuit breaker enforces, which means the default run stops exactly
 * where the policy says it must rather than being cut off by it — the difference
 * between a session that finished and a session that was halted, which the log
 * distinguishes and a reader should not have to guess at.
 *
 * The literal is the documented default for the case where the policy file
 * cannot be read at all, matching how `loadGeneratorConfig` handles the same
 * situation: a config problem should not make the runner unrunnable.
 */
function defaultIterations(): number {
  try {
    const n = loadGatePolicy().data.circuit_breaker.max_hypotheses_per_day;
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n;
  } catch {
    // Falls through to the literal below.
  }
  return 200;
}

interface Options {
  iterations: number;
  logPath: string;
  delayMs: number;
  replace: boolean;
}

const USAGE =
  'usage: npm run run-session --workspace apps/agent [options]\n' +
  '\n' +
  '  --iterations <n>   hypotheses to attempt (default: the policy\'s daily ceiling)\n' +
  '  --out <path>       where to write the log (default: apps/agent/logs/decisions.jsonl)\n' +
  '  --delay-ms <n>     pause between iterations (default: 0; the hosted loop paces itself)\n' +
  '  --replace          delete an existing log before starting. Required if one exists.\n';

/** Read a positive integer for a flag. Null when the value is absent or unusable. */
function intArg(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function parseArgs(args: string[]): Options | string {
  const opts: Options = {
    iterations: defaultIterations(),
    logPath: DEFAULT_LOG_PATH,
    delayMs: 0,
    replace: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case '--replace':
        opts.replace = true;
        break;
      case '--iterations': {
        const n = intArg(args[i + 1]);
        if (n === null || n < 1) return `--iterations needs a positive integer, got ${describe(args[i + 1])}`;
        opts.iterations = n;
        i += 1;
        break;
      }
      case '--out': {
        const path = args[i + 1];
        if (path === undefined || path.trim() === '') return '--out needs a path';
        opts.logPath = path;
        i += 1;
        break;
      }
      case '--delay-ms': {
        const n = intArg(args[i + 1]);
        if (n === null) return `--delay-ms needs a non-negative integer, got ${describe(args[i + 1])}`;
        opts.delayMs = n;
        i += 1;
        break;
      }
      default:
        return `unrecognised argument: ${describe(flag)}`;
    }
  }

  return opts;
}

function describe(v: unknown): string {
  return v === undefined ? '(nothing)' : JSON.stringify(v);
}

/** Line count of a JSONL file, for the "how much am I about to delete" message. */
function lineCount(path: string): number {
  const text = readFileSync(path, 'utf8');
  let n = 0;
  for (const line of text.split('\n')) if (line.trim()) n += 1;
  return n;
}

/**
 * The reason distribution of the log this run just wrote.
 *
 * Printed because the shape of a session is itself a result: a run where every
 * hypothesis died at the same bar says something different from one where they
 * died at five different bars, and a CI log that shows only "PASS" hides that.
 * It reads the file it just finished writing, so it cannot disagree with it.
 */
function reasonDistribution(path: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = JSON.parse(trimmed) as { gate_decision?: unknown; gate_reason?: unknown };
    const decision = typeof entry.gate_decision === 'string' ? entry.gate_decision : 'unknown';
    const reason = typeof entry.gate_reason === 'string' ? entry.gate_reason : '(none recorded)';
    const key = decision === 'KILL' ? reason : decision;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Descending by count, then alphabetically so ties are stable across runs.
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * What was in the way while proposing, split into the two different things that
 * `generator_fallback_reason` records.
 *
 * The field is wider than its name. It carries every tier disruption during the
 * proposal, which is two distinct events:
 *
 *   - SKIPPED. The tier failed and a LATER tier answered. `generator` on the
 *     entry names a different tier from the one in the reason. This is a real
 *     fallback.
 *   - STALLED. The tier was throttled, waited out the provider's reset hint and
 *     then answered the same iteration itself. `generator` names the SAME tier.
 *     Nothing fell back; the cost was wall-clock, and the provider records it so
 *     a forty-second pause is in the record rather than only in the timestamp
 *     gap between two entries.
 *
 * Reading the reason's leading tier against the entry's own `generator` is what
 * separates them, and it is the only signal available: the two events produce
 * the same `tier [kind]` shape and differ only in who ended up answering.
 *
 * Keyed on the tier and the failure KIND — `groq [rate_limited]` — because that
 * is the part that is stable across occurrences and is the actual answer to "why
 * did the model stop answering". The provider's own error text differs every
 * time, so keying on the whole message would report a hundred throttles as a
 * hundred distinct facts.
 *
 * Reads the file it just finished writing, so it cannot disagree with it.
 */
export interface TierDisruptions {
  /** Tiers that failed so a later tier answered. */
  skipped: Array<[string, number]>;
  /** Tiers that stalled and then answered themselves. Not fallbacks. */
  stalled: Array<[string, number]>;
}

function fallbackSummary(path: string): TierDisruptions {
  const skipped = new Map<string, number>();
  const stalled = new Map<string, number>();

  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = JSON.parse(trimmed) as Record<string, unknown>;
    const reason = entry['generator_fallback_reason'];
    if (typeof reason !== 'string' || reason === '') continue;

    const answered = typeof entry['generator'] === 'string' ? entry['generator'] : null;

    for (const part of reason.split(' | ')) {
      const [tier, kind] = part.split(' ');
      if (!tier) continue;
      const key = `${tier} [${kind ?? 'unknown'}]`;
      bump(tier === answered ? stalled : skipped, key);
    }
  }

  const sort = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return { skipped: sort(skipped), stalled: sort(stalled) };
}

/**
 * The comparable substance of a log: one line per entry saying WHICH hypothesis
 * was judged and WHAT the gate decided about it.
 *
 * Not the entry hashes, and deliberately not `hypothesis_hash` either. Both
 * cover `proposed_at` and `session_id`, the two things a re-run cannot
 * reproduce — so comparing hashes would report a difference between two runs
 * that agreed on every decision, and a check that cries wolf is worse than no
 * check at all. What is compared is the proposal's own fields and the verdict,
 * which is what "this run is the same experiment" actually means.
 */
function substance(path: string): string[] {
  const out: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = JSON.parse(trimmed) as Record<string, unknown>;
    const hypothesis = (entry['hypothesis'] ?? {}) as Record<string, unknown>;
    const condition = (hypothesis['condition'] ?? {}) as Record<string, unknown>;
    out.push(
      [
        entry['hypothesis_id'],
        hypothesis['signal'],
        hypothesis['target'],
        hypothesis['direction'],
        condition['operator'],
        condition['threshold'],
        condition['lookback_minutes'],
        hypothesis['forward_return_minutes'],
        hypothesis['experiment_family'],
        entry['gate_decision'],
        entry['gate_reason'],
      ].join(' | '),
    );
  }
  return out;
}

/**
 * Which non-enumerated tiers proposed the hypotheses in an existing log.
 *
 * The counterpart to `sampledTiers` below, and it exists because the comparison
 * needs the provenance of BOTH logs, not just the incoming one. The first
 * version of this checked only the run being written, which left the same bug
 * standing from the other side: a keyless run pointed at a model-proposed log
 * compared its own enumerated decisions against a sampled session's, found a
 * difference that was guaranteed, and reported the failure as a broken
 * reproducibility guarantee. It also deleted that log on the way in, because
 * `--replace` removes the file before the comparison is reached.
 */
function sampledTiersIn(path: string): string[] {
  const tiers = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = JSON.parse(trimmed) as Record<string, unknown>;
    const generator = entry['generator'];
    if (typeof generator === 'string' && generator !== 'deterministic') tiers.add(generator);
  }
  return [...tiers];
}

/**
 * Compare a previous log's decisions against the run that just replaced it.
 *
 * Compares the common prefix, so a re-run with a different `--iterations` is
 * judged on the part both runs cover rather than failing for having stopped
 * somewhere else. Returns a description of the first difference, or null when
 * every compared entry agrees.
 */
function firstSubstantiveDifference(before: string[], after: string[]): string | null {
  const shared = Math.min(before.length, after.length);
  for (let i = 0; i < shared; i += 1) {
    if (before[i] !== after[i]) {
      return (
        `entry ${i + 1} differs:\n` +
        `      before: ${before[i]}\n` +
        `      after:  ${after[i]}`
      );
    }
  }
  return null;
}

async function main(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n\n${USAGE}`);
    return 2;
  }

  // Read the outgoing log's decisions BEFORE deleting it, so the run that
  // replaces it can be held to reproducing them. Its PROVENANCE is read at the
  // same moment and for the same reason: it is needed to decide whether holding
  // the new run to reproducing it means anything, and after `rmSync` below the
  // question can no longer be asked.
  const previousSubstance = existsSync(parsed.logPath) ? substance(parsed.logPath) : null;
  const previousSampledTiers = existsSync(parsed.logPath) ? sampledTiersIn(parsed.logPath) : [];

  if (existsSync(parsed.logPath)) {
    if (!parsed.replace) {
      process.stderr.write(
        `refusing to overwrite ${parsed.logPath} (${lineCount(parsed.logPath)} entries)\n\n` +
          'One log is one session. Appending a second session to it would leave every later\n' +
          'entry claiming a "this session" attempt count that counts the earlier session\n' +
          'too. Pass --replace to discard the existing log and start a fresh chain from\n' +
          'genesis, or --out <path> to write somewhere else.\n',
      );
      return 2;
    }
    process.stderr.write(`replacing ${parsed.logPath} (${lineCount(parsed.logPath)} entries)\n`);
    rmSync(parsed.logPath, { force: true });
  }

  const loop = new SessionLoop({
    maxIterations: parsed.iterations,
    iterationDelayMs: parsed.delayMs,
    logPath: parsed.logPath,
  });

  // Progress, because a CI log that is silent for several minutes reads as a
  // hung job. Only verdicts are printed, one line each, plus the events that
  // mean the run stopped for a reason other than reaching its bound.
  //
  // Tier failures are ALSO printed, and that is not decoration. A session whose
  // provider throttles it halfway leaves a log where thirty-two entries say
  // `generator: deterministic` and nothing anywhere says why — which is how the
  // first keyed demo run ended, and the question "why did your model stop
  // answering" had no committed answer. The reason now travels in the entry
  // itself (see `fallbackReason` in src/llm/provider.ts) and is echoed here so a
  // reader of the CI log sees it as it happens rather than only in the file.
  let seen = 0;
  const every = Math.max(1, Math.floor(parsed.iterations / 10));
  const tierTrouble = new Map<string, number>();
  loop.bus.subscribe(
    (event) => {
      if (event.type === 'verdict') {
        seen += 1;
        if (seen % every === 0 || event.entry?.decision === 'PROMOTE') {
          const row = event.entry;
          const decision = row?.decision ?? 'unknown';
          const reason = row?.reason ?? '';
          console.log(
            `[run] ${String(seen).padStart(4)}/${parsed.iterations}  ${row?.hypothesis_id ?? ''}  ` +
              `${decision}${reason ? ` (${reason})` : ''}`,
          );
        }
      } else if (event.type === 'tier_failure') {
        // Counted by (tier, kind) rather than printed per occurrence: a hundred
        // identical throttles is one fact, and the summary below reports it once.
        const key = event.message.split(':')[0] ?? 'unknown';
        tierTrouble.set(key, (tierTrouble.get(key) ?? 0) + 1);
      } else if (event.type === 'circuit_break' || event.type === 'error' || event.type === 'session_stopped') {
        console.log(`[run] ${event.type}: ${event.message}`);
      }
    },
    { replay: false },
  );

  console.log(
    `[run] session ${loop.sessionId} · bound ${parsed.iterations} iterations · ` +
      `log ${parsed.logPath}`,
  );

  const begun = await loop.runToCompletion();
  if (!begun.ok) {
    process.stderr.write(`[run] the session did not start: ${begun.detail}\n`);
    return 1;
  }

  const stats = loop.getStats();
  const status = loop.getStatus();

  console.log('');
  console.log('[run] finished');
  console.log(`  phase                    ${status.phase}`);
  console.log(`  hypotheses attempted     ${stats.hypotheses_attempted}`);
  console.log(`  promoted                 ${stats.hypotheses_promoted}`);
  console.log(`  killed                   ${stats.hypotheses_killed}`);
  console.log(`  schema-rejected          ${stats.hypotheses_schema_rejected}`);
  console.log(`  generator tiers          ${JSON.stringify(stats.generator_tiers)}`);
  console.log(`  rank-1 BH threshold      ${stats.current_bh_threshold_rank1}`);
  if (status.circuit_breaker.tripped) {
    // Stated prominently rather than left in a status field: a halted session is
    // a different result from a completed one, and the difference is the whole
    // point of having a breaker.
    console.log(`  CIRCUIT BREAKER TRIPPED  ${status.circuit_breaker.reason}`);
    console.log(`                           ${status.circuit_breaker.detail}`);
  }
  if (status.last_error !== null) console.log(`  last error               ${status.last_error}`);

  if (!existsSync(parsed.logPath)) {
    process.stderr.write(`\n[run] FAIL — no log was written at ${parsed.logPath}\n`);
    return 1;
  }

  const distribution = reasonDistribution(parsed.logPath);
  console.log('');
  console.log('  why each hypothesis was decided:');
  for (const [reason, count] of distribution) {
    console.log(`    ${String(count).padStart(4)}  ${reason}`);
  }

  // Printed unconditionally, including when empty, because "no entry fell back"
  // is itself the claim a keyed run is making. A summary that appears only when
  // something went wrong cannot distinguish "nothing went wrong" from "the
  // summary was never wired up".
  const disruptions = fallbackSummary(parsed.logPath);
  console.log('');
  console.log('  tier disruptions while proposing, and which kind they were:');
  if (disruptions.skipped.length === 0 && disruptions.stalled.length === 0) {
    console.log('    none — every proposal went through its first-choice tier untouched,');
    console.log('    or the run had no model configured and enumerated instead');
  } else {
    // Listed separately because they are different facts about the run, and
    // lumping them together is what made this block wrong before: an entry that
    // waited out a throttle and was then answered by the SAME tier was being
    // reported as having fallen back off it.
    console.log('    skipped — the tier failed, a later tier answered (a real fallback):');
    if (disruptions.skipped.length === 0) console.log('      none');
    for (const [reason, count] of disruptions.skipped) {
      console.log(`      ${String(count).padStart(4)}  ${reason}`);
    }
    console.log('    stalled — the tier was throttled, waited, then answered itself:');
    if (disruptions.stalled.length === 0) console.log('      none');
    for (const [reason, count] of disruptions.stalled) {
      console.log(`      ${String(count).padStart(4)}  ${reason}`);
    }
  }

  const result = verifyDecisionLog(parsed.logPath);
  console.log('');
  console.log(`[run] ${parsed.logPath}`);
  console.log(`  head hash ${result.headHash ?? '(no entries)'}`);

  if (!result.ok) {
    process.stderr.write(`\n[run] FAIL — the log does not verify: ${result.failures.length} problem(s)\n`);
    for (const failure of result.failures) {
      process.stderr.write(`  line ${failure.line}  ${failure.entry_id ?? '(no id)'}  ${failure.kind}\n`);
      process.stderr.write(`      ${failure.detail}\n`);
    }
    return 1;
  }

  console.log(`[run] PASS — ${result.entriesChecked} entries, chain intact and append-only.`);

  /*
   * The reproducibility comparison, and the one condition under which it means
   * anything.
   *
   * It asserts a property of the whole path from attempt index to decision: that
   * it is a pure function of the frozen dataset and the policy. That is exactly
   * true when the proposals come from the deterministic enumerator, which is a
   * pure function of the attempt index by construction.
   *
   * It is exactly FALSE when a model proposed them, and not because anything is
   * broken. A sampled proposal is supposed to differ between runs; that is what
   * sampling is. Comparing a model-proposed log against the log it replaced
   * therefore tests nothing and fails always — which is how this first surfaced:
   * a sixty-hypothesis Groq session that ran correctly to completion, wrote a
   * chain-intact log, passed its own verification, and was then reported as a
   * failure by an assertion that could not have held.
   *
   * So the comparison runs only when every proposal was enumerated, and when it
   * cannot run the log says so rather than passing silently. The distinction
   * matters to a reader: "reproducible" is a claim about the protocol, and it
   * should only be printed over a log that has it.
   *
   * What remains true of a model-proposed log — and what a sceptical reader
   * should check instead — is that every VERDICT in it is re-derivable: the gate
   * is a deterministic function of the hypothesis, the frozen dataset and the
   * policy, and all three are hashed into the entry. The hypotheses are not
   * reproducible; the judgements about them are.
   */
  const sampledTiers = Object.keys(stats.generator_tiers).filter((tier) => tier !== 'deterministic');
  const enumeratedOnly = sampledTiers.length === 0;

  if (previousSubstance !== null && enumeratedOnly && previousSampledTiers.length === 0) {
    const difference = firstSubstantiveDifference(previousSubstance, substance(parsed.logPath));
    if (difference !== null) {
      process.stderr.write(
        `\n[run] FAIL — this run did not reproduce the log it replaced. ${difference}\n` +
          '      The proposals or the verdicts changed, which means something in the path from\n' +
          '      attempt index to decision is not a pure function of the frozen dataset and the\n' +
          '      policy. The log is written and verifies, but the reproducibility claim is not\n' +
          '      true of it.\n',
      );
      return 1;
    }
    console.log(
      `[run] PASS — reproduced all ${Math.min(previousSubstance.length, result.entriesChecked)} ` +
        'entries of the log it replaced: same hypotheses, same verdicts.',
    );
  } else if (previousSubstance !== null && !enumeratedOnly) {
    console.log(
      `[run] NOTE — the reproducibility comparison was not applied: ${sampledTiers.join(', ')} ` +
        'proposed these hypotheses, and a sampled proposal is meant to differ between runs.\n' +
        '       This log is NOT reproducible, and says so rather than claiming otherwise. What\n' +
        '       is checkable is every verdict in it: the gate is a deterministic function of the\n' +
        '       hypothesis, the frozen dataset and the policy, all three hashed into each entry.',
    );
  } else if (previousSubstance !== null) {
    /*
     * The mirror image, and the case the condition above was missing. Every
     * proposal in THIS run was enumerated — so this run is reproducible — but
     * the log it replaced was not. Holding it to reproducing a sampled session
     * would fail every time for a reason that says nothing about this run, and
     * the failure would arrive after `--replace` had already deleted that log.
     */
    console.log(
      '[run] NOTE — the reproducibility comparison was not applied: every proposal in this run ' +
        `was enumerated, but the log it replaced was not — ${previousSampledTiers.join(', ')} ` +
        'proposed those hypotheses.\n' +
        '       A sampled proposal is meant to differ between runs, so the two logs cannot be\n' +
        '       compared. This log IS reproducible: a second keyless run reproduces it exactly.\n' +
        '       The record it replaced is the one that was not reproducible, and if it is worth\n' +
        '       keeping it belongs in its own file rather than at the path this run replaced.',
    );
  }

  // A halted session is not a failed run — the breaker doing its job is a
  // result, and the log records it. But it is not the run that was asked for
  // either, so CI is told, and the summary says which of the two happened.
  if (status.circuit_breaker.tripped) {
    console.log(
      `\n[run] NOTE — the session ran ${stats.hypotheses_attempted} hypotheses and then halted\n` +
        '      on the circuit breaker. That is recorded in the log as a CIRCUIT_BREAK entry.\n' +
        '      Re-run with a smaller --iterations if a session that ends on its own bound was\n' +
        '      wanted.',
    );
  }

  return 0;
}

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`[run] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
