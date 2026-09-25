/**
 * The reserved out-of-sample pass over LOCKED_TEST.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `config/partitions.json` sets aside a third partition and states its purpose in
 * its own words: LOCKED_TEST "is read once, manually, for the final demo
 * out-of-sample pass." Until now nothing performed that pass. The partition has
 * been frozen, hashed and committed since 2026-09-11 and not one row of it has
 * ever been read by any part of this system — `grep -rn "allowLockedTest *: *true"
 * apps/agent` returned nothing, and no script under `src/scripts/` touched it.
 * This is the consumer that was missing.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It changes nothing. Same engine, same gate, same policy file, same frozen store,
 * same partition boundaries. It does not re-adjudicate the canonical record, it
 * does not write to `logs/decisions.jsonl`, and it does not adjust a threshold.
 * The only input it chooses is WHICH hypotheses to carry, and that choice is made
 * by a rule fixed before the holdout was read — see CARRY_RULE below.
 *
 * THE CARRY RULE, PRE-REGISTERED
 * ------------------------------
 * The rule is stated in CARRY_RULE and is mechanical: every hypothesis the gate
 * ever recorded a PROMOTE for in the canonical record, deduplicated by
 * hypothesis hash. It is deliberately NOT "the hypotheses that look best", and it
 * is not chosen after seeing anything from LOCKED_TEST, because at the time this
 * rule was written nothing from LOCKED_TEST had been seen.
 *
 * WHY THE CARRY SET IS NOT THE SAME AS "THE SURVIVORS"
 * ----------------------------------------------------
 * The canonical record ends with ZERO surviving factors: E-0006 promoted H-0006
 * and E-0008 killed the same hypothesis two entries later, when the family grew
 * from 6 attempts to 7 and the BH bar tightened from 0.016667 to 0.014286 past a p
 * of 0.014664. So a rule reading "carry the survivors" would carry nothing and
 * this pass would test an empty set.
 *
 * The rule is therefore "ever promoted", and the distinction is reported rather
 * than glossed: the entry this writes records the OOS verdict, and the summary
 * prints both the carry-set size and the survivor count so the two cannot be
 * confused for one another.
 *
 * ONE SHOT, ENFORCED BY CODE
 * --------------------------
 * If the output log already exists this script REFUSES to run. It has no
 * `--replace`. The partition is read once; a mechanism that made re-running
 * frictionless would make it equally frictionless to re-run after changing
 * something, which is the single failure this whole exercise is guarding against.
 * Re-running this script unchanged would produce the same numbers anyway — the
 * engine is deterministic — so the refusal costs nothing except the ability to
 * quietly re-decide.
 *
 * HOW TO RUN IT
 * -------------
 *   node --experimental-strip-types --import <hook> src/scripts/locked-test-pass.ts
 *   ... --carry-only     print the carry set and STOP before reading the holdout
 *
 * `--carry-only` exists so the plumbing can be exercised — the canonical log read,
 * the carry rule, the provenance hashes — without spending the partition. It is
 * the only mode that is free to run repeatedly.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runBacktest, type BacktestOutcome } from '../backtest/engine.js';
import { loadGatePolicy } from '../config.js';
import { adjudicateHypothesis } from '../gate/gate.js';
import { buildAppendContext, DecisionLog } from '../log/decisions.js';
import { verifyDecisionLog } from '../log/verify.js';
import type { FactorHypothesis } from '../types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGS = join(HERE, '..', '..', 'logs');
const CANONICAL_LOG = join(LOGS, 'decisions.jsonl');
const OUT_LOG = join(LOGS, 'locked-test.jsonl');
const OUT_META = join(LOGS, 'locked-test.meta.json');

/**
 * The preregistered carry rule, as a string, because it is quoted into the
 * metadata artifact verbatim rather than paraphrased. A rule that only exists as
 * code cannot be checked by a reader who does not read code, and this is the one
 * decision in the pass that could bias the result.
 */
export const CARRY_RULE =
  'Every hypothesis for which the canonical research record (logs/decisions.jsonl) ' +
  'contains at least one entry with gate_decision === "PROMOTE", deduplicated by ' +
  'hypothesis_hash, ordered by the entry_id of its first promotion. Fixed before any ' +
  'LOCKED_TEST row was read. It is not "the survivors" — see the header.';

interface CanonicalEntry {
  entry_id: string;
  hypothesis_id: string;
  hypothesis_hash: string;
  hypothesis: FactorHypothesis;
  gate_decision: string;
  timestamp_utc: string;
}

function readCanonical(): CanonicalEntry[] {
  if (!existsSync(CANONICAL_LOG)) {
    throw new Error(`canonical record not found at ${CANONICAL_LOG}`);
  }
  const out: CanonicalEntry[] = [];
  for (const line of readFileSync(CANONICAL_LOG, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as CanonicalEntry);
  }
  return out;
}

export interface Carried {
  hypothesis_id: string;
  hypothesis_hash: string;
  hypothesis: FactorHypothesis;
  /** The entry that first promoted it. */
  promoted_at_entry: string;
}

/** Apply CARRY_RULE. Pure: canonical entries in, carried set out. */
export function carrySet(entries: readonly CanonicalEntry[]): Carried[] {
  const first = new Map<string, CanonicalEntry>();
  for (const e of entries) {
    if (e.gate_decision !== 'PROMOTE') continue;
    // Entries are in file order, so the first one seen is the first promotion.
    if (!first.has(e.hypothesis_hash)) first.set(e.hypothesis_hash, e);
  }
  return [...first.values()]
    .sort((a, b) => a.entry_id.localeCompare(b.entry_id))
    .map((e) => ({
      hypothesis_id: e.hypothesis_id,
      hypothesis_hash: e.hypothesis_hash,
      hypothesis: e.hypothesis,
      promoted_at_entry: e.entry_id,
    }));
}

/** Final verdict recorded for a hypothesis hash, or null if it never appears. */
function finalVerdict(
  entries: readonly CanonicalEntry[],
  hash: string,
): { entry_id: string; decision: string } | null {
  let last: CanonicalEntry | null = null;
  for (const e of entries) if (e.hypothesis_hash === hash) last = e;
  return last === null ? null : { entry_id: last.entry_id, decision: last.gate_decision };
}

async function main(args: string[]): Promise<number> {
  const carryOnly = args.includes('--carry-only');

  const canonical = readCanonical();
  const carried = carrySet(canonical);
  const survivors = new Set<string>();
  for (const c of carried) {
    if (finalVerdict(canonical, c.hypothesis_hash)?.decision === 'PROMOTE') {
      survivors.add(c.hypothesis_hash);
    }
  }

  console.log('[oos] carry rule');
  console.log(`  ${CARRY_RULE}`);
  console.log('');
  console.log(`[oos] canonical record   ${canonical.length} entries`);
  console.log(`[oos] carry set          ${carried.length} hypothesis(es)`);
  console.log(`[oos] of which surviving ${survivors.size}`);
  for (const c of carried) {
    const fv = finalVerdict(canonical, c.hypothesis_hash);
    console.log(
      `      ${c.hypothesis_id}  ${c.hypothesis.signal} ${c.hypothesis.condition.operator} ` +
        `${c.hypothesis.condition.threshold} -> ${c.hypothesis.target} ` +
        `${c.hypothesis.forward_return_minutes}m  | promoted at ${c.promoted_at_entry}` +
        `  | canonical final: ${fv?.decision ?? '(absent)'}${fv?.decision === 'KILL' ? ` (${fv.entry_id})` : ''}`,
    );
  }

  if (carryOnly) {
    console.log('');
    console.log('[oos] --carry-only: stopping before LOCKED_TEST is read. Nothing spent.');
    return 0;
  }

  if (carried.length === 0) {
    console.log('');
    console.log('[oos] the carry rule selected nothing, so there is nothing to test out of sample.');
    console.log('      That is a result, not a failure: it says the record contains no promotion.');
    return 0;
  }

  if (existsSync(OUT_LOG)) {
    process.stderr.write(
      `\n[oos] REFUSING TO RUN — ${OUT_LOG} already exists.\n` +
        '      LOCKED_TEST is read once (config/partitions.json). This script has no\n' +
        '      --replace on purpose: a pass that is cheap to redo is cheap to redo after\n' +
        '      changing something, which is the one thing this pass exists to prevent.\n' +
        '      If a genuine re-run is required, delete the file deliberately and say so.\n',
    );
    return 2;
  }

  const policy = loadGatePolicy();
  const ctx = buildAppendContext({
    sessionId: 'S-LOCKEDTEST-1',
    fdrLevel: policy.data.fdr_level,
  });

  // The family is the carry set. For a single preregistered hypothesis this is
  // BH at m = 1, i.e. the bar is exactly the policy's fdr_level — which is the
  // correct correction for one pre-specified test, not a relaxation of it.
  const outcomes: Array<{ carried: Carried; outcome: BacktestOutcome }> = [];

  for (const c of carried) {
    const outcome = await runBacktest({
      hypothesis: c.hypothesis,
      partition: 'LOCKED_TEST',
      allowLockedTest: true,
    });

    if (outcome.timedOut) {
      process.stderr.write(`[oos] FAIL — the backtest for ${c.hypothesis_id} hit the time budget\n`);
      return 1;
    }

    // The pass must rest on the committed dataset. A leg served by the live
    // endpoint would mean the number is not describable by `dataset_sha256`, and
    // an out-of-sample result nobody can tie to the frozen data is not evidence.
    const legSources = [outcome.signalSources.signal, outcome.signalSources.spot];
    if (legSources.some((s) => s === 'live')) {
      process.stderr.write(
        `[oos] FAIL — ${c.hypothesis_id} read at least one leg from the LIVE endpoint ` +
          `(${JSON.stringify(outcome.signalSources)}). The frozen store did not cover it, so ` +
          'this number would not be attributable to the committed dataset. Refusing to record it.\n',
      );
      return 1;
    }

    outcomes.push({ carried: c, outcome });
  }

  // Gate is family-wide over the pass's own carried set, exactly as it is over a
  // session's attempts. Same function, same policy file, no special case.
  const sessionPValues = outcomes.map((o) => o.outcome.result.p_value);
  const adjudications = outcomes.map((o, i) => ({
    carried: o.carried,
    outcome: o.outcome,
    verdict: adjudicateHypothesis({
      hypothesis: o.carried.hypothesis,
      backtest: o.outcome.result,
      selfIndex: i,
      sessionPValues,
      policy: policy.data,
    }),
  }));

  const log = new DecisionLog(OUT_LOG);
  const written = [];
  for (const a of adjudications) {
    const entry = log.append({
      ctx,
      hypothesisId: a.carried.hypothesis_id,
      hypothesis: a.carried.hypothesis,
      partitionUsed: 'LOCKED_TEST',
      // The hypothesis was enumerated, not sampled — same provenance as the
      // canonical entry that promoted it. The partition field is what marks this
      // as the out-of-sample read.
      generator: 'deterministic',
      decision: a.verdict.decision,
      backtest: {
        ic: a.outcome.result.ic,
        t_stat: a.outcome.result.t_stat,
        hit_rate: a.outcome.result.hit_rate,
        n_obs: a.outcome.result.n_obs,
        baseline_ic: a.outcome.result.baseline_ic,
      },
    });
    written.push({ a, entry });
  }

  const meta = {
    artifact: 'LOCKED_TEST out-of-sample pass',
    pass_id: 'S-LOCKEDTEST-1',
    generated_at: new Date().toISOString(),
    carry_rule: CARRY_RULE,
    canonical_record: {
      path: 'apps/agent/logs/decisions.jsonl',
      entries: canonical.length,
      head_hash: lastHeadHash(canonical),
    },
    carry_set_size: carried.length,
    survivors_in_canonical_record: survivors.size,
    provenance: {
      partition_used: 'LOCKED_TEST',
      policy_version: ctx.policy_version,
      policy_sha256: ctx.policy_sha256,
      partitions_sha256: ctx.partitions_sha256,
      dataset_sha256: ctx.dataset_sha256,
      fdr_level: ctx.fdr_level,
    },
    results: written.map(({ a, entry }) => ({
      entry_id: entry.entry_id,
      hypothesis_id: a.carried.hypothesis_id,
      hypothesis_hash: a.carried.hypothesis_hash,
      promoted_at_entry: a.carried.promoted_at_entry,
      canonical_final_verdict: finalVerdict(canonical, a.carried.hypothesis_hash),
      signal_sources: a.outcome.signalSources,
      grid_size: a.outcome.gridSize,
      ic: a.outcome.result.ic,
      t_stat: a.outcome.result.t_stat,
      hit_rate: a.outcome.result.hit_rate,
      n_obs: a.outcome.result.n_obs,
      baseline_ic: a.outcome.result.baseline_ic,
      raw_p_value: a.outcome.result.p_value,
      bh_adjusted_threshold: a.verdict.decision.bh_adjusted_threshold,
      decision: a.verdict.decision.decision,
      reason: a.verdict.decision.reason,
      detail: a.verdict.decision.detail,
      checks: a.verdict.decision.checks,
      bh_rank: a.verdict.rank,
      bh_family_size: a.verdict.bh.m,
    })),
  };
  writeFileSync(OUT_META, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  // --- report -------------------------------------------------------------
  console.log('');
  console.log('[oos] LOCKED_TEST read complete.');
  console.log(`  policy          ${ctx.policy_version}  ${ctx.policy_sha256}`);
  console.log(`  partitions      ${ctx.partitions_sha256}`);
  console.log(`  dataset         ${ctx.dataset_sha256}`);
  console.log('');
  for (const { a, entry } of written) {
    const r = a.outcome.result;
    const d = a.verdict.decision;
    console.log(`  ${entry.entry_id}  ${a.carried.hypothesis_id}  ${d.decision}${d.reason ? ` (${d.reason})` : ''}`);
    console.log(
      `      grid ${a.outcome.gridSize}  n_obs ${r.n_obs}  IC ${r.ic.toFixed(4)}  ` +
        `t ${r.t_stat.toFixed(3)}  hit ${r.hit_rate.toFixed(4)}  baseline IC ${r.baseline_ic.toFixed(4)}`,
    );
    console.log(`      p ${r.p_value.toFixed(6)}  vs BH bar ${d.bh_adjusted_threshold.toFixed(6)} at rank ${a.verdict.rank} of ${a.verdict.bh.m}`);
    console.log(`      ${d.detail}`);
  }

  const result = verifyDecisionLog(OUT_LOG);
  console.log('');
  console.log(`[oos] ${OUT_LOG}`);
  console.log(`  head hash ${result.headHash ?? '(no entries)'}`);
  if (!result.ok) {
    process.stderr.write(`[oos] FAIL — the out-of-sample log does not verify\n`);
    for (const f of result.failures) {
      process.stderr.write(`  line ${f.line}  ${f.entry_id ?? '(no id)'}  ${f.kind}\n      ${f.detail}\n`);
    }
    return 1;
  }
  console.log(`[oos] PASS — ${result.entriesChecked} entr(ies), chain intact and append-only.`);
  console.log(`[oos] metadata    ${OUT_META}`);
  console.log(`[oos] verify with npx tsx src/log/verify.ts --file logs/locked-test.jsonl`);
  return 0;
}

function lastHeadHash(entries: readonly CanonicalEntry[]): string | null {
  if (entries.length === 0) return null;
  const raw = readFileSync(CANONICAL_LOG, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const last = JSON.parse(lines[lines.length - 1]!) as { entry_hash?: string };
  return last.entry_hash ?? null;
}

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      // `process.exit()` is deliberately not called: under --experimental-strip-types
      // it tears the process down mid-write and asserts in the worker thread. The
      // code is set and Node exits on its own once the loop drains.
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`[oos] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    });
}
