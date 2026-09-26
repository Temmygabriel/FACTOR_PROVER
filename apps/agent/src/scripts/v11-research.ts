/**
 * The v1.1 research phase — a preregistered sweep of a venue-reachable target.
 *
 * WHY THIS PHASE EXISTS
 * ---------------------
 * v1.0's promoted factor (H-0006) targeted RGOOGLUSDT, and the Bitget demo venue
 * refuses every tokenised equity before any sizing or balance check:
 * `papTradingService not support RWA order validation error`. So the one factor
 * that ever passed the gate was, by construction, unexecutable — not unlucky,
 * structurally impossible. `BTCUSDT` is the only instrument this project has
 * verified its Agent Hub path can actually place an order on.
 *
 * That is a VENUE argument for a SPECIFICATION choice, and it is disclosed as
 * such in `config/gate_policy.v1.1.json` rather than presented as a finding. The
 * statistics are unaffected: same engine, same frozen store, same partitions,
 * and not one threshold moved.
 *
 * WHAT IS PREREGISTERED, AND WHEN
 * -------------------------------
 * `config/gate_policy.v1.1.json` was written and hashed BEFORE this script ran,
 * and before any v1.1 number was computed. Its hash is recorded in every entry
 * this script writes, so a reader can confirm after the fact that the policy
 * governing the results is the one that existed before them. The diff between
 * the v1.0 and v1.1 policy files changes the version string, the lock time, the
 * family names and the target universe — and no threshold.
 *
 * THE FAMILY IS FIXED UP FRONT, WHICH CHANGES THE SHAPE OF THE RESULT
 * ------------------------------------------------------------------
 * v1.0's loop grew its family one attempt at a time, so BH was re-applied after
 * every attempt and a hypothesis could be promoted and then demoted as the bar
 * tightened — which is exactly what happened to H-0006 at E-0008.
 *
 * This sweep enumerates its whole family first (320 hypotheses), so m is fixed
 * at 320 for every adjudication and no demotion dynamic can arise. That is a
 * CONSEQUENCE of sweeping exhaustively, not a convenience, and it is recorded
 * because v1.0's headline finding was precisely such a demotion.
 *
 * THE TWO STAGES
 * --------------
 *   Stage 1 — all 320 on DISCOVERY, adjudicated family-wide at m = 320.
 *   Stage 2 — VALIDATION, read ONLY for stage-1 survivors, at m = survivors.
 *
 * If stage 1 promotes nothing, VALIDATION IS NOT READ AT ALL. That matters:
 * every one of the 201 entries in the v1.0 record used DISCOVERY, so VALIDATION
 * has never been read by any recorded result in this project. It is the only
 * unspent partition left — LOCKED_TEST was spent on 2026-09-25 — and this script
 * refuses to spend it on a family that produced nothing.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not read or write `logs/decisions.jsonl`. It does not touch
 * LOCKED_TEST. It does not change the running system: the LLM prompt, the schema
 * validator and the session loop still offer the rToken universe, because
 * switching production to a new policy version is a separate change with its own
 * blast radius.
 *
 * HOW TO RUN IT
 * -------------
 *   node --experimental-strip-types --import <hook> src/scripts/v11-research.ts
 *   ... --plan     print the enumeration and STOP; reads no market data
 *
 * `--plan` is free to run repeatedly. The full run is one-shot — see below.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runBacktest, type BacktestOutcome } from '../backtest/engine.js';
import { loadGatePolicyFile, targetsForPolicy, type GatePolicy, type LoadedConfig } from '../config.js';
import { adjudicateHypothesis } from '../gate/gate.js';
import { buildAppendContext, DecisionLog } from '../log/decisions.js';
import { verifyDecisionLog } from '../log/verify.js';
import {
  FUNDING_CONDITIONS,
  LOOKBACKS,
  SPOT_CONDITIONS,
  type ConditionTemplate,
} from '../llm/deterministic.js';
import {
  FAMILY_SIGNALS,
  FAMILY_WINDOW_BOUNDS,
  VENUE_PAIR_SYMBOLS,
  type ExperimentFamily,
  type FactorHypothesis,
  type ProposedHypothesis,
  type SignalId,
} from '../types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(HERE, '..', '..');
const POLICY_PATH = join(AGENT_ROOT, 'config', 'gate_policy.v1.1.json');
const LOGS = join(AGENT_ROOT, 'logs');
const OUT_LOG = join(LOGS, 'v1.1.jsonl');
const OUT_META = join(LOGS, 'v1.1.meta.json');

const SESSION_ID = 'S-V11-1';

/**
 * The three v1.1 families, in the order the enumeration walks them.
 *
 * These are NOT v1.0's family names with a new target. A durable record entry
 * reading `funding_to_rtoken` has to keep meaning a funding signal tested
 * against a tokenised equity, so v1.1 gets its own names rather than borrowing
 * the old ones for a different target universe.
 */
const V11_FAMILIES: readonly ExperimentFamily[] = [
  'funding_to_pair',
  'momentum_to_pair',
  'combined_to_pair',
];

/**
 * The enumeration, built mechanically.
 *
 * Deliberately the SAME nested cross-product as v1.0's deterministic enumerator,
 * over the same condition templates (imported, not retyped — a re-declared
 * threshold table could silently test a different space while reporting that
 * nothing else changed) and the same lookbacks. Only two inputs differ: the
 * target, and the family names.
 *
 * Order is the natural nested-loop order rather than v1.0's strided walk. The
 * stride existed to spread a model-outage fallback's CONSECUTIVE proposals
 * across the space; here the entire space is swept, so there is no sequence of
 * consecutive proposals to spread, and natural order is easier to audit against
 * the preregistration.
 */
export function enumerateV11(targets: readonly string[]): ProposedHypothesis[] {
  const out: ProposedHypothesis[] = [];

  for (const family of V11_FAMILIES) {
    const bounds = FAMILY_WINDOW_BOUNDS[family];
    const windows = [15, 30, 60, 120].filter((w) => w >= bounds.min && w <= bounds.max);

    for (const signal of FAMILY_SIGNALS[family]) {
      const conditions: readonly ConditionTemplate[] = signal.includes('funding')
        ? FUNDING_CONDITIONS
        : SPOT_CONDITIONS;

      for (const target of targets) {
        for (const cond of conditions) {
          for (const forward of windows) {
            for (const lookback of LOOKBACKS) {
              out.push({
                signal,
                condition: {
                  operator: cond.operator,
                  threshold: cond.threshold,
                  lookback_minutes: lookback,
                },
                target: target as ProposedHypothesis['target'],
                direction: cond.operator === 'gt' ? 'positive' : 'negative',
                forward_return_minutes: forward,
                experiment_family: family,
              });
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * Check one enumerated candidate against the policy it will be judged by.
 *
 * NOT a re-implementation of `validateProposal`. That function is the schema
 * boundary for MODEL output, and it is deliberately still bound to the rToken
 * universe — v1.1 has not switched the running system over. What this checks is
 * the narrower, different question the sweep actually needs: is this candidate
 * inside the family the v1.1 policy declares? Anything outside is a bug in the
 * enumeration, so it throws rather than being skipped quietly.
 */
function assertWithinV11Policy(candidate: ProposedHypothesis, policy: GatePolicy): void {
  const targets = targetsForPolicy(policy);
  if (!targets.includes(String(candidate.target))) {
    throw new Error(`enumeration produced target ${candidate.target}, outside the v1.1 universe`);
  }
  if (!policy.families_enabled.includes(candidate.experiment_family)) {
    throw new Error(
      `enumeration produced family ${candidate.experiment_family}, not enabled by v1.1`,
    );
  }
  if (!FAMILY_SIGNALS[candidate.experiment_family].includes(candidate.signal as SignalId)) {
    throw new Error(
      `signal ${candidate.signal} is not licensed to family ${candidate.experiment_family}`,
    );
  }
  const b = FAMILY_WINDOW_BOUNDS[candidate.experiment_family];
  const fwd = candidate.forward_return_minutes;
  if (fwd < b.min || fwd > b.max) {
    throw new Error(`window ${fwd} is outside family bounds ${b.min}..${b.max}`);
  }
  if (!LOOKBACKS.includes(candidate.condition.lookback_minutes)) {
    throw new Error(`lookback ${candidate.condition.lookback_minutes} is outside the preregistered set`);
  }
}

/** Stamp an enumerated candidate into a full hypothesis. Index is 1-based. */
function stamp(p: ProposedHypothesis, index: number, proposedAt: string): FactorHypothesis {
  return {
    hypothesis_id: `H-V11-${String(index).padStart(4, '0')}`,
    session_id: SESSION_ID,
    proposed_at: proposedAt,
    ...p,
  };
}

interface Adjudicated {
  hypothesis: FactorHypothesis;
  outcome: BacktestOutcome;
  decision: ReturnType<typeof adjudicateHypothesis>;
}

/**
 * Run one family of hypotheses on one partition and adjudicate it family-wide.
 *
 * `sessionPValues` is the whole family's p-values, so BH's m is the family size
 * and every attempt counts — including the ones that failed for insufficient
 * data. Narrowing that to the plausible candidates would void the correction,
 * which is the same rule v1.0's gate documents.
 */
async function sweep(params: {
  candidates: readonly ProposedHypothesis[];
  partition: 'DISCOVERY' | 'VALIDATION';
  policy: LoadedConfig<GatePolicy>;
  proposedAt: string;
}): Promise<Adjudicated[]> {
  const { candidates, partition, policy, proposedAt } = params;

  const staged: Array<{ hypothesis: FactorHypothesis; outcome: BacktestOutcome }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    assertWithinV11Policy(candidate, policy.data);
    const hypothesis = stamp(candidate, i + 1, proposedAt);

    const outcome = await runBacktest({
      hypothesis,
      partition,
      policy: policy.data,
    });

    if (outcome.timedOut) {
      throw new Error(`the backtest for ${hypothesis.hypothesis_id} hit the time budget`);
    }

    // A leg served by the live endpoint would mean the number is not describable
    // by the committed `dataset_sha256`. A research phase whose numbers cannot be
    // tied to frozen bytes is not reproducible, so this is fatal rather than
    // recorded-and-continued.
    const legSources = [outcome.signalSources.signal, outcome.signalSources.spot];
    if (legSources.some((s) => s === 'live')) {
      throw new Error(
        `${hypothesis.hypothesis_id} read a leg from the LIVE endpoint ` +
          `(${JSON.stringify(outcome.signalSources)}); the number would not be attributable ` +
          `to the committed dataset`,
      );
    }

    staged.push({ hypothesis, outcome });
  }

  const pValues = staged.map((s) => s.outcome.result.p_value);

  return staged.map((s, i) => ({
    hypothesis: s.hypothesis,
    outcome: s.outcome,
    decision: adjudicateHypothesis({
      hypothesis: s.hypothesis,
      backtest: s.outcome.result,
      selfIndex: i,
      sessionPValues: pValues,
      policy: policy.data,
    }),
  }));
}

function summarise(rows: readonly Adjudicated[]): {
  promoted: Adjudicated[];
  reasons: Record<string, number>;
  bestByP: Adjudicated | null;
} {
  const promoted = rows.filter((r) => r.decision.decision.decision === 'PROMOTE');
  const reasons: Record<string, number> = {};
  for (const r of rows) {
    const key = r.decision.decision.decision === 'PROMOTE' ? 'PROMOTE' : String(r.decision.decision.reason);
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  const bestByP = rows.reduce<Adjudicated | null>(
    (best, r) => (best === null || r.outcome.result.p_value < best.outcome.result.p_value ? r : best),
    null,
  );
  return { promoted, reasons, bestByP };
}

async function main(args: string[]): Promise<number> {
  const planOnly = args.includes('--plan');

  const policy = loadGatePolicyFile(POLICY_PATH);
  const targets = targetsForPolicy(policy.data);
  const space = enumerateV11(targets);

  console.log('[v1.1] preregistered policy');
  console.log(`  file      ${POLICY_PATH}`);
  console.log(`  version   ${policy.data.policy_version}   locked_at ${policy.data.locked_at}`);
  console.log(`  sha256    ${policy.sha256}`);
  console.log(`  targets   ${targets.join(', ')}`);
  console.log(`  families  ${policy.data.families_enabled.join(', ')}`);
  console.log(
    `  bars      fdr ${policy.data.fdr_level}  min_ic ${policy.data.min_ic}  ` +
      `min_t ${policy.data.min_t_stat}  min_obs ${policy.data.min_obs}  ` +
      `baseline_beat ${policy.data.require_baseline_beat}  sampling ${policy.data.sampling}`,
  );
  console.log('');
  console.log(`[v1.1] enumeration  ${space.length} hypotheses`);

  const byFamily: Record<string, number> = {};
  for (const c of space) byFamily[c.experiment_family] = (byFamily[c.experiment_family] ?? 0) + 1;
  for (const [f, n] of Object.entries(byFamily)) console.log(`         ${f.padEnd(20)} ${n}`);

  const bySignal: Record<string, number> = {};
  for (const c of space) bySignal[c.signal] = (bySignal[c.signal] ?? 0) + 1;
  for (const [s, n] of Object.entries(bySignal)) console.log(`         ${s.padEnd(20)} ${n}`);

  // The bar every candidate faces, computed from the family size alone. Printed
  // BEFORE the run so it cannot be read as a post-hoc rationalisation.
  console.log('');
  console.log(
    `[v1.1] BH bar at rank 1 of m=${space.length}, FDR ${policy.data.fdr_level}: ` +
      `${(policy.data.fdr_level / space.length).toExponential(6)}`,
  );

  // The self-prediction control. `btc_spot_return` on a BTCUSDT target computes
  // the target's own trailing return over the same lookback, and the engine's
  // naive baseline is that same number — so IC and baseline IC are identically
  // equal and `require_baseline_beat` kills it by algebra, not by evidence.
  // Predicted here, before the run, and reported afterwards whatever it shows.
  const selfPrediction = space.filter(
    (c) => c.signal === 'btc_spot_return' && c.target === 'BTCUSDT',
  ).length;
  console.log(
    `[v1.1] predicted structural kills (btc_spot_return -> BTCUSDT, signal == baseline): ` +
      `${selfPrediction} of ${space.length}`,
  );

  if (planOnly) {
    console.log('');
    console.log('[v1.1] --plan: stopping. No market data read, nothing written.');
    return 0;
  }

  if (existsSync(OUT_LOG)) {
    process.stderr.write(
      `\n[v1.1] REFUSING TO RUN — ${OUT_LOG} already exists.\n` +
        '       This phase is recorded once. There is no --replace, on purpose: a phase\n' +
        '       that is cheap to redo is cheap to redo after changing something, which is\n' +
        '       the one failure preregistration exists to prevent.\n',
    );
    return 2;
  }

  const proposedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ctx = buildAppendContext({
    sessionId: SESSION_ID,
    fdrLevel: policy.data.fdr_level,
    policy,
  });

  // --- Stage 1: DISCOVERY ---------------------------------------------------
  console.log('');
  console.log(`[v1.1] stage 1 — sweeping ${space.length} hypotheses on DISCOVERY ...`);
  const stage1 = await sweep({
    candidates: space,
    partition: 'DISCOVERY',
    policy,
    proposedAt,
  });
  const s1 = summarise(stage1);
  console.log(`[v1.1] stage 1 complete.`);
  for (const [k, n] of Object.entries(s1.reasons)) console.log(`         ${k.padEnd(32)} ${n}`);

  // --- Stage 2: VALIDATION, only for survivors ------------------------------
  //
  // Read ONLY if stage 1 promoted something. A family that produced nothing
  // leaves VALIDATION unspent, and that is the correct outcome rather than a
  // reason to go looking.
  let stage2: Adjudicated[] = [];
  let validationRead = false;
  if (s1.promoted.length > 0) {
    validationRead = true;
    const survivors = s1.promoted.map((p) => ({
      signal: p.hypothesis.signal,
      condition: p.hypothesis.condition,
      target: p.hypothesis.target,
      direction: p.hypothesis.direction,
      forward_return_minutes: p.hypothesis.forward_return_minutes,
      experiment_family: p.hypothesis.experiment_family,
    })) satisfies ProposedHypothesis[];
    console.log('');
    console.log(
      `[v1.1] stage 2 — ${survivors.length} survivor(s); reading VALIDATION at m=${survivors.length}`,
    );
    stage2 = await sweep({ candidates: survivors, partition: 'VALIDATION', policy, proposedAt });
  } else {
    console.log('');
    console.log('[v1.1] stage 2 — NOT RUN. Stage 1 promoted nothing, so VALIDATION was not read');
    console.log('       and remains unspent. Reading it to look for something would be the');
    console.log('       specification search the preregistration exists to prevent.');
  }

  // --- Write ----------------------------------------------------------------
  const log = new DecisionLog(OUT_LOG);
  const written: Array<{ row: Adjudicated; entryId: string; stage: 1 | 2 }> = [];

  for (const row of stage1) {
    const e = log.append({
      ctx,
      hypothesisId: row.hypothesis.hypothesis_id,
      hypothesis: row.hypothesis,
      partitionUsed: 'DISCOVERY',
      generator: 'deterministic',
      decision: row.decision.decision,
      backtest: {
        ic: row.outcome.result.ic,
        t_stat: row.outcome.result.t_stat,
        hit_rate: row.outcome.result.hit_rate,
        n_obs: row.outcome.result.n_obs,
        baseline_ic: row.outcome.result.baseline_ic,
      },
    });
    written.push({ row, entryId: e.entry_id, stage: 1 });
  }
  for (const row of stage2) {
    const e = log.append({
      ctx,
      hypothesisId: row.hypothesis.hypothesis_id,
      hypothesis: row.hypothesis,
      partitionUsed: 'VALIDATION',
      generator: 'deterministic',
      decision: row.decision.decision,
      backtest: {
        ic: row.outcome.result.ic,
        t_stat: row.outcome.result.t_stat,
        hit_rate: row.outcome.result.hit_rate,
        n_obs: row.outcome.result.n_obs,
        baseline_ic: row.outcome.result.baseline_ic,
      },
    });
    written.push({ row, entryId: e.entry_id, stage: 2 });
  }

  const s2 = summarise(stage2);
  const meta = {
    artifact: 'v1.1 research phase',
    pass_id: SESSION_ID,
    generated_at: new Date().toISOString(),
    policy: {
      version: policy.data.policy_version,
      path: 'apps/agent/config/gate_policy.v1.1.json',
      sha256: policy.sha256,
      locked_at: policy.data.locked_at,
      thresholds: {
        fdr_level: policy.data.fdr_level,
        min_ic: policy.data.min_ic,
        min_t_stat: policy.data.min_t_stat,
        min_obs: policy.data.min_obs,
        require_baseline_beat: policy.data.require_baseline_beat,
        sampling: policy.data.sampling,
      },
      target_universe: targets,
      families_enabled: policy.data.families_enabled,
    },
    provenance: {
      partitions_sha256: ctx.partitions_sha256,
      dataset_sha256: ctx.dataset_sha256,
    },
    enumeration: {
      size: space.length,
      by_family: byFamily,
      by_signal: bySignal,
      order: 'family -> signal -> target -> condition -> forward window -> lookback',
      condition_templates: 'imported unchanged from src/llm/deterministic.ts',
      lookbacks: [...LOOKBACKS],
      venue_pair_symbols_available: [...VENUE_PAIR_SYMBOLS],
      predicted_structural_kills_btc_spot_to_btcusdt: selfPrediction,
      bh_bar_at_rank_1: policy.data.fdr_level / space.length,
    },
    stage_1: {
      partition: 'DISCOVERY',
      m: stage1.length,
      promoted: s1.promoted.length,
      kill_reasons: s1.reasons,
      best_by_p_value: s1.bestByP
        ? {
            hypothesis_id: s1.bestByP.hypothesis.hypothesis_id,
            signal: s1.bestByP.hypothesis.signal,
            condition: s1.bestByP.hypothesis.condition,
            direction: s1.bestByP.hypothesis.direction,
            forward_return_minutes: s1.bestByP.hypothesis.forward_return_minutes,
            ic: s1.bestByP.outcome.result.ic,
            t_stat: s1.bestByP.outcome.result.t_stat,
            n_obs: s1.bestByP.outcome.result.n_obs,
            baseline_ic: s1.bestByP.outcome.result.baseline_ic,
            raw_p_value: s1.bestByP.outcome.result.p_value,
            bh_adjusted_threshold: s1.bestByP.decision.decision.bh_adjusted_threshold,
            bh_rank: s1.bestByP.decision.rank,
            decision: s1.bestByP.decision.decision.decision,
            reason: s1.bestByP.decision.decision.reason,
          }
        : null,
    },
    stage_2: {
      validation_read: validationRead,
      note: validationRead
        ? 'VALIDATION was read because stage 1 promoted at least one hypothesis.'
        : 'VALIDATION was NOT read: stage 1 promoted nothing. It remains unspent.',
      m: stage2.length,
      promoted: s2.promoted.length,
      kill_reasons: s2.reasons,
    },
    locked_test: 'NOT READ. Spent by the v1.0 out-of-sample pass on 2026-09-25.',
    survivors: stage2
      .filter((r) => r.decision.decision.decision === 'PROMOTE')
      .map((r) => ({
        hypothesis_id: r.hypothesis.hypothesis_id,
        hypothesis: r.hypothesis,
        partition: 'VALIDATION',
        ic: r.outcome.result.ic,
        t_stat: r.outcome.result.t_stat,
        n_obs: r.outcome.result.n_obs,
        baseline_ic: r.outcome.result.baseline_ic,
        raw_p_value: r.outcome.result.p_value,
        bh_adjusted_threshold: r.decision.decision.bh_adjusted_threshold,
      })),
    stage_1_promotions: s1.promoted.map((r) => ({
      hypothesis_id: r.hypothesis.hypothesis_id,
      hypothesis: r.hypothesis,
      ic: r.outcome.result.ic,
      t_stat: r.outcome.result.t_stat,
      n_obs: r.outcome.result.n_obs,
      baseline_ic: r.outcome.result.baseline_ic,
      raw_p_value: r.outcome.result.p_value,
      bh_adjusted_threshold: r.decision.decision.bh_adjusted_threshold,
    })),
  };
  writeFileSync(OUT_META, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  // --- Report ---------------------------------------------------------------
  console.log('');
  console.log('[v1.1] written');
  console.log(`  ${OUT_LOG}   ${written.length} entries`);
  console.log(`  ${OUT_META}`);

  if (s1.bestByP) {
    const b = s1.bestByP;
    console.log('');
    console.log('[v1.1] strongest stage-1 result (smallest raw p, NOT necessarily a promotion)');
    console.log(`  ${b.hypothesis.hypothesis_id}  ${b.hypothesis.signal} ${b.hypothesis.condition.operator} ${b.hypothesis.condition.threshold} @ ${b.hypothesis.condition.lookback_minutes}m`);
    console.log(`      -> ${b.hypothesis.target} ${b.hypothesis.forward_return_minutes}m  ${b.hypothesis.direction}`);
    console.log(
      `      n ${b.outcome.result.n_obs}  IC ${b.outcome.result.ic.toFixed(4)}  ` +
        `t ${b.outcome.result.t_stat.toFixed(3)}  baseline IC ${b.outcome.result.baseline_ic.toFixed(4)}`,
    );
    console.log(
      `      p ${b.outcome.result.p_value.toExponential(4)}  vs BH bar ` +
        `${b.decision.decision.bh_adjusted_threshold.toExponential(4)} at rank ${b.decision.rank} of ${b.decision.bh.m}`,
    );
    console.log(`      ${b.decision.decision.decision}${b.decision.decision.reason ? ` (${b.decision.decision.reason})` : ''}`);
  }

  console.log('');
  console.log(
    `[v1.1] survivors: ${s2.promoted.length} (stage-1 promotions: ${s1.promoted.length})`,
  );

  const result = verifyDecisionLog(OUT_LOG);
  console.log('');
  console.log(`[v1.1] ${OUT_LOG}`);
  console.log(`  head hash ${result.headHash ?? '(no entries)'}`);
  if (!result.ok) {
    process.stderr.write('[v1.1] FAIL — the v1.1 log does not verify\n');
    for (const f of result.failures) {
      process.stderr.write(`  line ${f.line}  ${f.entry_id ?? '(no id)'}  ${f.kind}\n      ${f.detail}\n`);
    }
    return 1;
  }
  console.log(`[v1.1] PASS — ${result.entriesChecked} entr(ies), chain intact and append-only.`);
  return 0;
}

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      // `process.exit()` is deliberately not called: under --experimental-strip-types
      // it tears the process down mid-write and asserts in the worker thread.
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`[v1.1] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    });
}
