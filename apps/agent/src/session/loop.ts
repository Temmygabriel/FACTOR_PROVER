/**
 * The session loop.
 *
 * This is the thing that runs. One iteration is: propose → screen → backtest →
 * adjudicate → log → re-adjudicate the whole family → act on any changed
 * verdict. Everything it touches is deterministic given the frozen dataset and
 * the preregistered policy; the only non-deterministic input is which
 * hypothesis the generator produces, and that is recorded verbatim in the log
 * along with which tier produced it.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO PRESERVE
 *
 * 1. A KILL IS A RESULT. Every path through `runIteration` ends in exactly one
 *    appended log entry, carrying the same metrics a promotion would. There is
 *    no early return that skips the log — including the three pre-backtest
 *    kills, which are the easiest place to accidentally drop a hypothesis out
 *    of the record. A hypothesis that was never tested still occupies a family
 *    slot (see src/session/family.ts) and still gets a line.
 *
 * 2. THE FAMILY IS LIVE, SO A VERDICT CAN CHANGE. BH is computed over every
 *    hypothesis attempted this session, so a candidate's verdict depends on
 *    hypotheses that did not exist when it was first judged. After each new
 *    attempt this loop re-adjudicates every already-judged candidate against
 *    the grown family, and appends a NEW entry when a verdict changes. Nothing
 *    is rewritten: the log shows the verdict changing and why, and a demotion
 *    is as visible as a promotion.
 *
 * 3. PROVENANCE TRAVELS WITH THE RUN, NOT THE VERDICT. `signalSources` is
 *    reported on every backtest outcome including the killed ones, so a run
 *    that silently fell back to the live network is visible even when its
 *    result was a rejection. Recording it only on successes would mean the only
 *    runs whose data anyone could check are the ones that already looked good.
 */

import { randomUUID } from 'node:crypto';

import { adjudicateHypothesis } from '../gate/gate.js';
import { runBacktest, type BacktestOutcome } from '../backtest/engine.js';
import { percentileRank } from '../backtest/signals.js';
import { formatHypothesisId, stampHypothesis } from '../schema/validate.js';
import {
  DecisionLog,
  buildAppendContext,
  type AppendContext,
  type DecisionLogEntry,
} from '../log/decisions.js';
import { HypothesisGenerator, describeChain, loadGeneratorConfig } from '../llm/provider.js';
import { CircuitBreaker, type BreakerState } from '../circuit/breaker.js';
import { ExecutionGuard, type GuardOutcome, type OrderIntent } from '../execution/guard.js';
import { fetchSpotPrice } from '../execution/prices.js';
import { describeCapability, loadAgentHubConfig, type HubCapability } from '../execution/agentHub.js';
import { loadGatePolicy, loadPartitions, partitionWindow, type GatePolicy } from '../config.js';
import { fetchCandles, buildPriceSeries } from '../backtest/data.js';
import { fetchFundingHistory } from '../data/fundingHistory.js';
import {
  frozenCoverage,
  frozenDatasetHash,
  loadFrozenCandles,
  loadFrozenFunding,
  loadFrozenManifest,
} from '../data/frozen.js';
import { REFERENCE_COINS, MINUTE_MS, FUNDING_INTERVAL_MS } from '../data/freezeWindow.js';
import { entryToRow, pageRows } from '../api/rows.js';
import { SessionEventBus } from './events.js';
import {
  SessionFamily,
  asProposed,
  findDuplicate,
  lookbackBias,
  type PriorAttempt,
} from './family.js';
import { PaperLedger } from './paper.js';

import {
  EXPERIMENT_FAMILIES,
  FAMILY_SIGNALS,
  RTOKEN_SYMBOLS,
  type BacktestResult,
  type ExperimentFamily,
  type FactorHypothesis,
  type GateDecision,
  type KillReason,
  type LLMContext,
  type ProposedHypothesis,
  type RTokenSymbol,
  type SignalId,
} from '../types.js';
import type {
  ControlResponse,
  DecisionRow,
  LeaderboardResponse,
  LogResponse,
  PromotedFactor,
  Provenance,
  SessionPhase,
  SessionStats,
  StatusResponse,
} from '../api/contract.js';

// ---------------------------------------------------------------------------
// Options and internal state
// ---------------------------------------------------------------------------

export interface SessionLoopOptions {
  sessionId?: string;
  /** Decision log path. Defaults to `<agent>/logs/decisions.jsonl`. */
  logPath?: string;
  bus?: SessionEventBus;
  generator?: HypothesisGenerator;
  breaker?: CircuitBreaker;
  guard?: ExecutionGuard;
  ledger?: PaperLedger;
  /** Pause between iterations. */
  iterationDelayMs?: number;
  /** Stop after this many iterations. Null means run until stopped. */
  maxIterations?: number | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** A candidate that has a recorded verdict, kept so it can be re-adjudicated. */
interface JudgedCandidate {
  hypothesis: FactorHypothesis;
  backtest: BacktestResult;
  slotIndex: number;
  decision: GateDecision;
  generator: string;
  factorId: string | null;
  /** The hypothesis_id of the proposal that caused this verdict, for the trace. */
  judgedAtFamilySize: number;
}

/** Where the market summary numbers came from. Disclosed, never assumed. */
type SummarySource = 'live' | 'frozen';

const DEFAULT_ITERATION_DELAY_MS = 1_500;
const MARKET_SUMMARY_TTL_MS = 60_000;
/** Funding settlements in a 7-day window, at 3 per day. */
const SETTLEMENTS_PER_WEEK = 21;

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export class SessionLoop {
  readonly sessionId: string;
  /**
   * The log this session appends to. Exposed so the HTTP layer verifies the
   * file being WRITTEN rather than a path it guessed at — the hash-chain
   * endpoint would otherwise be capable of reporting a green verification for a
   * log nobody is writing to.
   */
  readonly logPath: string;
  readonly bus: SessionEventBus;
  readonly ledger: PaperLedger;

  private readonly log: DecisionLog;
  private readonly ctx: AppendContext;
  private readonly policy: GatePolicy;
  private readonly generator: HypothesisGenerator;
  private readonly breaker: CircuitBreaker;
  private readonly guard: ExecutionGuard;
  private readonly family = new SessionFamily();
  private readonly judged = new Map<string, JudgedCandidate>();
  private readonly priorAttempts: PriorAttempt[] = [];
  private readonly generatorTiers: Record<string, number> = {};
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly iterationDelayMs: number;
  private readonly maxIterations: number | null;
  private readonly startedAt: string;

  private phase: SessionPhase = 'idle';
  private lastError: string | null = null;
  private loopIterations = 0;
  private attemptsMade = 0;
  private running = false;
  private stopRequested = false;
  private capability: HubCapability | null = null;
  private marketSummaryCache: { at: number; value: LLMContext['market_summary']; source: SummarySource } | null = null;

  constructor(opts: SessionLoopOptions = {}) {
    this.sessionId = opts.sessionId ?? `S-${randomUUID().slice(0, 8)}`;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.iterationDelayMs = opts.iterationDelayMs ?? DEFAULT_ITERATION_DELAY_MS;
    this.maxIterations = opts.maxIterations ?? null;
    this.startedAt = this.now().toISOString().replace(/\.\d{3}Z$/, 'Z');

    this.bus = opts.bus ?? new SessionEventBus();
    this.ledger = opts.ledger ?? new PaperLedger();

    this.policy = loadGatePolicy().data;
    this.ctx = buildAppendContext({ sessionId: this.sessionId, fdrLevel: this.policy.fdr_level });
    this.logPath = opts.logPath ?? defaultLogPath();
    this.log = new DecisionLog(this.logPath);

    this.generator = opts.generator ?? new HypothesisGenerator(loadGeneratorConfig());
    this.breaker = opts.breaker ?? new CircuitBreaker(this.policy, this.now);
    this.guard =
      opts.guard ??
      new ExecutionGuard({
        getOpenPositions: () => this.ledger.getOpenPositionCount(),
        getPrice: fetchSpotPrice,
        now: this.now,
      });
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  get currentPhase(): SessionPhase {
    return this.phase;
  }

  /**
   * Begin the session.
   *
   * Returns as soon as the session is marked running: this is called from an
   * HTTP handler, and holding the request open for the life of the loop would
   * mean a proxy timeout decided when the session ended. `runToCompletion`
   * exists for tests and CLI use, which do want to await the whole thing.
   */
  start(): ControlResponse {
    if (this.phase === 'running') {
      return { ok: false, phase: this.phase, detail: 'session is already running' };
    }
    if (this.breaker.currentState.tripped) {
      return {
        ok: false,
        phase: this.phase,
        detail:
          'the circuit breaker is tripped; a session will not start until an operator ' +
          'resets it (POST /api/reset), because a trip means "a human decides what happens next"',
      };
    }

    this.phase = 'running';
    this.stopRequested = false;
    this.lastError = null;

    this.bus.emit('session_started', `session ${this.sessionId} started`, {});
    this.emitProvenanceNote();

    void this.runLoop();
    return { ok: true, phase: this.phase, detail: 'session started' };
  }

  /** Ask the loop to stop. It finishes the iteration in flight, then exits. */
  stop(reason = 'stopped by operator'): ControlResponse {
    if (this.phase !== 'running') {
      return { ok: false, phase: this.phase, detail: `session is not running (phase ${this.phase})` };
    }
    this.stopRequested = true;
    this.phase = 'stopped';
    this.bus.emit('session_stopped', `session stopped: ${reason}`, {});
    return { ok: true, phase: this.phase, detail: reason };
  }

  /**
   * Manually clear a tripped breaker.
   *
   * Deliberately requires `requested_by`. A trip exists to force a human
   * decision, so a resume that cannot be attributed to a person defeats the
   * mechanism — the breaker would just be a delay. The name is recorded in the
   * breaker's detail string, which `GET /api/status` reports.
   *
   * Daily counters are NOT restored: a resume must not hand back spent budget.
   */
  reset(requestedBy: string): ControlResponse {
    if (typeof requestedBy !== 'string' || requestedBy.trim() === '') {
      return { ok: false, phase: this.phase, detail: 'requested_by is required — a resume must name a person' };
    }
    const state = this.breaker.reset(requestedBy.trim());
    this.phase = this.phase === 'halted_by_circuit_breaker' ? 'idle' : this.phase;
    this.bus.emit('circuit_reset', `circuit breaker reset by ${requestedBy.trim()}`, { breaker: state });
    return { ok: true, phase: this.phase, detail: state.detail };
  }

  /** Await the whole loop. For tests and CLI runs, never for an HTTP handler. */
  async runToCompletion(): Promise<void> {
    await this.runLoop();
  }

  // -------------------------------------------------------------------------
  // The loop proper
  // -------------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (!this.stopRequested) {
        if (this.maxIterations !== null && this.loopIterations >= this.maxIterations) {
          this.bus.emit(
            'session_stopped',
            `reached the configured iteration limit (${this.maxIterations}); stopping`,
            {},
          );
          this.phase = 'stopped';
          break;
        }

        const state = this.breaker.currentState;
        if (state.tripped) {
          this.haltOnBreaker(state);
          break;
        }

        await this.runIteration();
        this.loopIterations += 1;

        if (this.stopRequested) break;
        await this.sleep(this.iterationDelayMs);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.phase = 'error';
      this.bus.emit('error', `session aborted: ${this.lastError}`, { error: this.lastError });
    } finally {
      this.running = false;
      if (this.phase === 'running') this.phase = 'stopped';
    }
  }

  /**
   * Record a breaker trip in the log and stop.
   *
   * The trip is written to the decision log as an ordinary entry rather than
   * kept in memory, so the log's own verification (chain, dense ids, dense
   * counter) still covers it — a session that halted shows up as a session that
   * halted, with no gap in the record exactly where something interesting
   * happened.
   */
  private haltOnBreaker(state: BreakerState): void {
    this.phase = 'halted_by_circuit_breaker';
    const last = [...this.judged.keys()].pop() ?? undefined;

    try {
      this.log.appendCircuitBreak({
        ctx: this.ctx,
        reason: state.reason ?? 'unknown',
        detail: state.detail,
        lastHypothesisId: last,
      });
    } catch (err) {
      // The breaker still halted; only the record of it failed. Reported rather
      // than swallowed, because a halt that did not get logged is precisely the
      // thing a reader of the log would never find out about.
      this.bus.emit('error', `breaker halted the session but the halt could not be logged: ${String(err)}`, {
        error: String(err),
      });
    }

    this.bus.emit('circuit_break', `circuit breaker tripped: ${state.reason} — ${state.detail}`, {
      breaker: state,
    });
  }

  // -------------------------------------------------------------------------
  // One iteration
  // -------------------------------------------------------------------------

  private async runIteration(): Promise<void> {
    const hypothesisId = formatHypothesisId(this.attemptsMade + 1);
    this.attemptsMade += 1;

    // --- propose -----------------------------------------------------------
    const outcome = await this.generator.generate(await this.buildLLMContext(), this.attemptsMade - 1);

    for (const f of outcome.tierFailures) {
      this.bus.emit('tier_failure', `${f.tier}: ${f.message}`, {
        tier_failure: { tier: f.tier, message: `[${f.kind}] ${f.message}` },
      });
    }

    // Only a tier that was actually CALLED and failed counts against the
    // breaker. An unconfigured tier is a deployment choice, not an outage, and
    // counting it would trip the breaker after three iterations of a session
    // that was working as designed.
    if (outcome.tierFailures.some((f) => f.kind === 'transport')) {
      this.breaker.recordLlmFailure();
    } else {
      this.breaker.recordLlmSuccess();
    }

    const tier = outcome.tier;
    this.generatorTiers[tier] = (this.generatorTiers[tier] ?? 0) + 1;
    this.breaker.recordHypothesis(
      outcome.proposal ? { signal: outcome.proposal.signal, target: outcome.proposal.target } : undefined,
    );

    // --- screen 1: the schema wall ----------------------------------------
    if (outcome.proposal === null) {
      this.recordPreBacktestKill({
        hypothesisId,
        reason: 'schema_validation_failed',
        detail:
          `The ${tier} tier returned a proposal the schema rejected, so no compute was spent ` +
          `on it: ${outcome.schemaError ?? 'no detail supplied'}`,
        schemaError: outcome.schemaError ?? 'unknown schema error',
        generator: tier,
        proposal: null,
      });
      return;
    }

    const proposal: ProposedHypothesis = outcome.proposal;
    const hypothesis = stampHypothesis(proposal, {
      hypothesisId,
      sessionId: this.sessionId,
      now: this.now(),
    });

    this.bus.emit(
      'hypothesis_proposed',
      `${hypothesisId} (${tier}): ${describeProposal(proposal)}`,
      {
        // Sent so the live view can render what is being tested RIGHT NOW. The
        // verdict is minutes away and the row does not exist yet; without this
        // the feed shows a sentence and nothing else, and the panel falls back
        // to the previous row, which reads as though the loop had stalled.
        hypothesis_id: hypothesisId,
        hypothesis: {
          signal: proposal.signal,
          target: proposal.target,
          direction: proposal.direction,
          condition: { ...proposal.condition },
          forward_return_minutes: proposal.forward_return_minutes,
          experiment_family: proposal.experiment_family,
        },
      },
    );

    // --- screen 2: is this even a new test? -------------------------------
    const duplicate = findDuplicate(proposal, this.priorAttempts);
    if (duplicate) {
      this.recordPreBacktestKill({
        hypothesisId,
        reason: 'duplicate_family',
        detail:
          `This is not a new test: ${duplicate.hypothesis_id} already measured the same ` +
          `signal, target, direction, operator and horizon. It is recorded as an attempt ` +
          `(and counted in the family) rather than re-run, because re-running it would spend ` +
          `a backtest to produce the same number and would let a repeated idea look like ` +
          `independent confirmation.`,
        generator: tier,
        proposal,
      });
      return;
    }

    // --- screen 3: does the lookback mean what it says? -------------------
    const bias = lookbackBias(proposal);
    if (bias) {
      this.recordPreBacktestKill({
        hypothesisId,
        reason: 'lookback_bias_detected',
        detail: bias,
        generator: tier,
        proposal,
      });
      return;
    }

    this.priorAttempts.push({ hypothesis_id: hypothesisId, hypothesis: proposal });

    // --- backtest ----------------------------------------------------------
    const outcomeBt = await runBacktest({ hypothesis, partition: 'DISCOVERY' });
    this.bus.emit(
      'backtest_completed',
      `${hypothesisId}: n=${outcomeBt.result.n_obs}, IC=${fmt(outcomeBt.result.ic)}, ` +
        `t=${fmt(outcomeBt.result.t_stat, 3)}, p=${fmt(outcomeBt.result.p_value)} ` +
        `(signal data: ${outcomeBt.signalSources.signal}${outcomeBt.signalSources.spot ? `+${outcomeBt.signalSources.spot}` : ''})`,
      {
        hypothesis_id: hypothesisId,
        hypothesis: {
          signal: proposal.signal,
          target: proposal.target,
          direction: proposal.direction,
          condition: { ...proposal.condition },
          forward_return_minutes: proposal.forward_return_minutes,
          experiment_family: proposal.experiment_family,
        },
        // `bh_adjusted_threshold` is deliberately absent: adjudication has not
        // run yet, so any value here would be one the gate had not used.
        metrics: {
          ic: outcomeBt.result.ic,
          t_stat: outcomeBt.result.t_stat,
          hit_rate: outcomeBt.result.hit_rate,
          n_obs: outcomeBt.result.n_obs,
          baseline_ic: outcomeBt.result.baseline_ic,
          raw_p_value: outcomeBt.result.p_value,
        },
        stats: {
          hypotheses_attempted: this.attemptsMade,
          current_bh_threshold_rank1: this.family.rank1Threshold(this.policy.fdr_level),
        },
      },
    );

    // --- adjudicate --------------------------------------------------------
    const slot = this.family.add({
      hypothesisId,
      pValue: outcomeBt.result.p_value,
      origin: 'tested',
    });

    const adjudication = adjudicateHypothesis({
      hypothesis,
      backtest: outcomeBt.result,
      selfIndex: slot.index,
      sessionPValues: this.family.pValues,
      policy: this.policy,
    });

    const candidate: JudgedCandidate = {
      hypothesis,
      backtest: outcomeBt.result,
      slotIndex: slot.index,
      decision: adjudication.decision,
      generator: tier,
      factorId: null,
      judgedAtFamilySize: this.family.size,
    };
    this.judged.set(hypothesisId, candidate);

    this.appendAndAnnounce(candidate, {
      familySize: this.family.size,
      message: `${hypothesisId} ${adjudication.decision.decision}: ${adjudication.decision.reason ?? 'all checks cleared'}`,
    });

    if (adjudication.decision.decision === 'PROMOTE') {
      await this.onPromotion(candidate);
    }

    // --- the family grew, so every earlier verdict is now stale -----------
    this.reAdjudicate({ excludeHypothesisId: hypothesisId });
  }

  // -------------------------------------------------------------------------
  // Append + announce
  // -------------------------------------------------------------------------

  /**
   * Write one entry and publish the verdict.
   *
   * Every verdict in this loop goes through here, which is what makes property
   * 1 above hold by construction rather than by discipline: there is one place
   * that appends and announces, so there is no path that can produce a verdict
   * without a log line.
   *
   * Takes no backtest outcome. It reads the metrics off the candidate, which is
   * the same object the entry is built from — passing an outcome as well would
   * mean two sources for one set of numbers, and a re-adjudicated verdict
   * genuinely has no fresh outcome to pass.
   */
  private appendAndAnnounce(
    candidate: JudgedCandidate,
    opts: { familySize: number; message: string },
  ): DecisionLogEntry {
    const entry = this.log.append({
      ctx: this.ctx,
      hypothesisId: candidate.hypothesis.hypothesis_id,
      hypothesis: candidate.hypothesis,
      partitionUsed: 'DISCOVERY',
      generator: candidate.generator,
      decision: candidate.decision,
      backtest: {
        ic: candidate.backtest.ic,
        t_stat: candidate.backtest.t_stat,
        hit_rate: candidate.backtest.hit_rate,
        n_obs: candidate.backtest.n_obs,
        baseline_ic: candidate.backtest.baseline_ic,
      },
    });

    const row: DecisionRow = entryToRow(entry, this.policy);
    this.bus.emit('verdict', opts.message, { entry: row });
    return entry;
  }

  /**
   * A kill that happened before any backtest.
   *
   * Uses an empty `BacktestResult` so the entry carries the same fields as any
   * other — zeros rather than absent values, because a KILL is a result and a
   * thinner shape for it is exactly the asymmetry this project refuses. The
   * gate is still consulted, so the recorded `bh_adjusted_threshold` is the real
   * bar at this rank and family size rather than a placeholder; only the
   * decision and its wording are overridden, because `insufficient_obs` is
   * true of zero observations but is not the reason this hypothesis died.
   */
  private recordPreBacktestKill(params: {
    hypothesisId: string;
    reason: KillReason;
    detail: string;
    generator: string;
    proposal: ProposedHypothesis | null;
    schemaError?: string;
  }): void {
    const emptyBacktest: BacktestResult = {
      ic: 0,
      t_stat: 0,
      hit_rate: 0,
      n_obs: 0,
      baseline_ic: 0,
      signal_autocorr_lag1: 0,
      p_value: 1,
    };

    // No test was run, so the slot joins the family at p = 1. See
    // src/session/family.ts for why that is the honest value rather than
    // leaving the hypothesis out of the family.
    const slot = this.family.add({ hypothesisId: params.hypothesisId, pValue: 1, origin: originFor(params.reason) });

    // Only run the gate when there is a hypothesis to judge. Without one there
    // is no `hypothesis_id` to adjudicate and the call would be a fiction.
    const bhThreshold =
      params.proposal === null
        ? (slot.index + 1) / this.family.size * this.policy.fdr_level
        : adjudicateHypothesis({
            hypothesis: stampHypothesis(params.proposal, {
              hypothesisId: params.hypothesisId,
              sessionId: this.sessionId,
              now: this.now(),
            }),
            backtest: emptyBacktest,
            selfIndex: slot.index,
            sessionPValues: this.family.pValues,
            policy: this.policy,
          }).decision.bh_adjusted_threshold;

    const decision: GateDecision = {
      decision: 'KILL',
      reason: params.reason,
      detail: params.detail,
      bh_adjusted_threshold: bhThreshold,
      raw_p_value: 1,
      checks: {
        passed_min_obs: false,
        passed_bh: false,
        passed_ic_floor: false,
        passed_t_stat_floor: false,
        passed_baseline_beat: false,
      },
    };

    const entry = this.log.append({
      ctx: this.ctx,
      hypothesisId: params.hypothesisId,
      // A schema rejection may have no well-formed hypothesis at all, so the
      // hash marker says so rather than hashing a null and calling it a hash.
      hypothesis: params.proposal ?? null,
      partitionUsed: 'DISCOVERY',
      generator: params.generator,
      decision,
      backtest: emptyBacktest,
      ...(params.schemaError !== undefined ? { schemaError: params.schemaError } : {}),
    });

    this.bus.emit('verdict', `${params.hypothesisId} KILL: ${params.reason}`, {
      entry: entryToRow(entry, this.policy),
    });
  }

  // -------------------------------------------------------------------------
  // Re-adjudication
  // -------------------------------------------------------------------------

  /**
   * Re-run the gate for every already-judged candidate against the grown family.
   *
   * Expected direction is DEMOTION: untested hypotheses join at p = 1, which
   * raises m and lowers (k/m)*q at every rank, so thresholds only tighten and a
   * candidate that cleared the bar early can stop clearing it. The reverse is
   * also handled because it is not impossible — adding a very small p-value
   * shifts other candidates' ranks, and a rank can improve — and a verdict that
   * changed in either direction has to be recorded either way. Silently keeping
   * a stale verdict would make the log assert something the family no longer
   * supports.
   *
   * Entries are appended ONLY when the decision or the reason actually changed.
   * Re-appending an unchanged verdict every iteration would bury the real
   * changes in noise: 200 attempts against 200 candidates is 40,000 lines, and
   * a log that long is a log nobody reads.
   */
  private reAdjudicate(opts: { excludeHypothesisId?: string } = {}): void {
    for (const [id, candidate] of this.judged) {
      if (id === opts.excludeHypothesisId) continue;

      const re = adjudicateHypothesis({
        hypothesis: candidate.hypothesis,
        backtest: candidate.backtest,
        selfIndex: candidate.slotIndex,
        sessionPValues: this.family.pValues,
        policy: this.policy,
      });

      const changed =
        re.decision.decision !== candidate.decision.decision ||
        re.decision.reason !== candidate.decision.reason;
      if (!changed) continue;

      const wasPromoted = candidate.decision.decision === 'PROMOTE';
      const nowPromoted = re.decision.decision === 'PROMOTE';
      const previousReason = candidate.decision.reason;

      candidate.decision = re.decision;
      candidate.judgedAtFamilySize = this.family.size;

      this.appendAndAnnounce(candidate, {
        familySize: this.family.size,
        message:
          `${id} verdict changed on a family of ${this.family.size}: ` +
          `${wasPromoted ? 'PROMOTE' : 'KILL'} → ${nowPromoted ? 'PROMOTE' : 'KILL'}` +
          (nowPromoted ? '' : ` (${re.decision.reason ?? previousReason})`),
      });

      if (wasPromoted && !nowPromoted) this.onDemotion(candidate);
      if (!wasPromoted && nowPromoted) {
        // Not awaited: re-adjudication runs inside an iteration and blocking it
        // on a price fetch would stall the loop for every other candidate.
        void this.onPromotion(candidate).catch((err) => {
          this.bus.emit('error', `${id} promoted on re-adjudication but the paper order failed: ${String(err)}`, {
            error: String(err),
          });
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Promotion, paper execution, demotion
  // -------------------------------------------------------------------------

  private async onPromotion(candidate: JudgedCandidate): Promise<void> {
    if (candidate.factorId !== null) return; // already promoted

    const factor = this.ledger.promote({
      hypothesis: candidate.hypothesis,
      ic: candidate.backtest.ic,
      t_stat: candidate.backtest.t_stat,
      hit_rate: candidate.backtest.hit_rate,
      n_obs: candidate.backtest.n_obs,
      bh_adjusted_threshold: candidate.decision.bh_adjusted_threshold,
      raw_p_value: candidate.decision.raw_p_value,
    });
    candidate.factorId = factor.factor_id;
    this.breaker.recordPromote();

    const row = this.rowFor(candidate.hypothesis.hypothesis_id);
    this.bus.emit(
      'promotion',
      `${factor.factor_id} promoted from ${candidate.hypothesis.hypothesis_id}: ` +
        `${candidate.hypothesis.signal} → ${candidate.hypothesis.target}, ` +
        `IC=${fmt(candidate.backtest.ic)}, n=${candidate.backtest.n_obs}. ` +
        `A survivorship result under FDR control, not a claim of profitability.`,
      row ? { entry: row } : {},
    );

    await this.placePaperOrder(factor, candidate.hypothesis);
  }

  /**
   * Send one paper order through the Execution Guard.
   *
   * The Guard's decision is what is recorded, including when it refuses. A
   * refused order is a real event in the session's history and a ledger that
   * only held the successful ones would make the execution record look cleaner
   * than it was — which is the same failure mode as a log that only holds
   * promotions, one layer down.
   *
   * A promotion does NOT depend on the Guard allowing the order. Being promoted
   * is a verdict about a backtest; placing an order is an execution decision
   * with its own five checks. Conflating them would let an unavailable broker
   * silently suppress a statistical result.
   */
  private async placePaperOrder(factor: PromotedFactor, hypothesis: FactorHypothesis): Promise<void> {
    const notional = this.policy.execution_guard.max_order_usdt;
    const side = hypothesis.direction === 'positive' ? 'buy' : 'sell';
    const at = this.now().toISOString().replace(/\.\d{3}Z$/, 'Z');

    let entryPrice: number | null = null;
    let priceNote = '';
    try {
      entryPrice = await this.priceFor(hypothesis.target);
    } catch (err) {
      priceNote = ` (live price unavailable: ${err instanceof Error ? err.message : String(err)})`;
    }

    if (entryPrice === null) {
      // No price means CHECK 4 could not be evaluated, so no order is built and
      // none is sent. Recorded as a refused fill rather than skipped, because
      // "we promoted something and could not price it" is information.
      this.ledger.recordFill(
        {
          factor_id: factor.factor_id,
          hypothesis_id: hypothesis.hypothesis_id,
          symbol: hypothesis.target,
          side,
          notional_usdt: notional,
          entry_price: 0,
          at,
          placed: false,
          refusal: `no live price for ${hypothesis.target}, so the order was never built${priceNote}`,
        },
        { openPosition: false },
      );
      this.bus.emit(
        'paper_order',
        `${factor.factor_id}: no paper order — ${hypothesis.target} could not be priced${priceNote}`,
        {},
      );
      return;
    }

    const intent: OrderIntent = {
      symbol: hypothesis.target,
      side,
      notional_usdt: notional,
      entry_price: entryPrice,
      factor_id: factor.factor_id,
      hypothesis_id: hypothesis.hypothesis_id,
    };

    let outcome: GuardOutcome;
    try {
      outcome = await this.guard.evaluate(intent);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ledger.recordFill(
        {
          factor_id: factor.factor_id,
          hypothesis_id: hypothesis.hypothesis_id,
          symbol: hypothesis.target,
          side,
          notional_usdt: notional,
          entry_price: entryPrice,
          at,
          placed: false,
          refusal: `the Execution Guard threw: ${detail}`,
        },
        { openPosition: false },
      );
      this.bus.emit('paper_order', `${factor.factor_id}: paper order failed — ${detail}`, {});
      return;
    }

    this.ledger.recordFill(
      {
        factor_id: factor.factor_id,
        hypothesis_id: hypothesis.hypothesis_id,
        symbol: hypothesis.target,
        side,
        notional_usdt: notional,
        entry_price: entryPrice,
        at,
        placed: outcome.allowed,
        refusal: outcome.allowed ? null : outcome.detail,
      },
      { openPosition: outcome.allowed },
    );

    if (outcome.allowed) this.breaker.recordPaperOrder();

    this.bus.emit(
      'paper_order',
      outcome.allowed
        ? `${factor.factor_id}: paper ${side} ${notional} USDT ${hypothesis.target} @ ${entryPrice}` +
            ` — simulated, not a real position`
        : `${factor.factor_id}: no paper order — refused at ${outcome.refused_at}: ${outcome.detail}`,
      {},
    );
  }

  /**
   * Withdraw a promotion whose verdict no longer holds.
   *
   * The factor is retired rather than deleted, and any open paper position is
   * closed at its last mark. Both choices keep the history readable: a session
   * where a promotion was later withdrawn should look like that, not like a
   * session that never promoted anything.
   */
  private onDemotion(candidate: JudgedCandidate): void {
    const factorId = candidate.factorId;
    if (factorId === null) return;

    const reason = candidate.decision.detail;
    this.ledger.retire(factorId, reason);

    const position = this.ledger.positionFor(factorId);
    if (position && position.notional_usdt > 0) {
      this.ledger.close(factorId, position.last_price);
    }

    this.bus.emit(
      'verdict',
      `${factorId} retired: the family grew to ${this.family.size} and its FDR threshold no ` +
        `longer admits ${candidate.hypothesis.hypothesis_id}. This is what FDR control means — ` +
        `the correction is applied over everything attempted, so a bar can rise after a result ` +
        `was reached.`,
      {},
    );
  }

  // -------------------------------------------------------------------------
  // Read surfaces
  // -------------------------------------------------------------------------

  getStatus(): StatusResponse {
    const breakerState = this.breaker.currentState;
    const counters = this.breaker.currentCounters;
    const capability = this.capabilityNow();
    const cfg = this.generator.config;
    const tiersLive = (['groq', 'gemini', 'openai'] as const).filter((t) =>
      t === 'groq' ? cfg.groqApiKey !== null : t === 'gemini' ? cfg.geminiApiKey !== null : cfg.openaiApiKey !== null,
    );

    return {
      phase: this.phase,
      provenance: this.getProvenance(),
      stats: this.getStats(),
      circuit_breaker: breakerState,
      circuit_counters: {
        day: counters.day,
        hypotheses_today: counters.hypotheses_today,
        promotes_today: counters.promotes_today,
        paper_orders_today: counters.paper_orders_today,
        consecutive_llm_failures: counters.consecutive_llm_failures,
      },
      execution: {
        available: capability.available,
        unverified: capability.unverified,
        detail: capability.detail,
      },
      generator: {
        chain: describeChain(cfg),
        tiers_live: tiersLive,
        deterministic_fallback: cfg.allowDeterministicFallback,
      },
      last_error: this.lastError,
    };
  }

  getLeaderboard(): LeaderboardResponse {
    const factors = this.ledger.leaderboard();
    return {
      factors,
      empty_reason:
        factors.length > 0
          ? null
          : this.family.size === 0
            ? 'No hypotheses have been attempted yet. Nothing has been tested, so nothing has been promoted or rejected — this is an empty session, not a null result.'
            : `${this.family.size} hypotheses attempted, ${this.family.rejectedCount(this.policy.fdr_level)} of them currently clearing the Benjamini-Hochberg threshold, and none passing all five gate checks. That is a result: under FDR control at q=${this.policy.fdr_level}, a session of this size is expected to produce few or no survivors when there is nothing there to find.`,
    };
  }

  getLog(opts: { limit?: number; before?: string | null } = {}): LogResponse {
    const { rows, next_cursor } = pageRows(this.log.readAll(), this.policy, {
      limit: opts.limit ?? 50,
      before: opts.before ?? null,
    });
    return { entries: rows, total: this.log.entryCount, next_cursor };
  }

  getProvenance(): Provenance {
    const datasetHash = frozenDatasetHash();
    const manifest = loadFrozenManifest();
    const partitions = loadPartitions();
    return {
      session_id: this.sessionId,
      started_at: this.startedAt,
      policy_version: String(this.policy.policy_version),
      policy_sha256: loadGatePolicy().sha256,
      // `.sha256`, not the LoadedConfig itself: `partitions` is the wrapper that
      // carries the parsed data, the path and the hash. This field is documented
      // as the sha256 of the committed partitions bytes, and the frontend renders
      // it as a provenance string — assigning the wrapper would have shipped an
      // object where a hash belongs, quietly breaking the one panel whose entire
      // job is to let a reader trace a number back to its source.
      partitions_sha256: partitions.sha256,
      dataset_sha256: datasetHash,
      dataset_frozen: datasetHash !== null,
      frozen_files: manifest?.entries.length ?? 0,
      fdr_level: this.policy.fdr_level,
    };
  }

  getStats(): SessionStats {
    const judged = [...this.judged.values()];
    const promoted = judged.filter((c) => c.decision.decision === 'PROMOTE').length;
    return {
      // Distinct hypotheses actually attempted — NOT the log's line count. A
      // verdict-change entry advances the log without a new hypothesis existing,
      // so using the line count here would inflate this number every time the
      // family grew. The log's own counter field stays a line counter because
      // the verifier checks it for density; this is the honest attempt count.
      hypotheses_attempted: this.attemptsMade,
      hypotheses_promoted: promoted,
      // Every attempt ends in exactly one verdict, so killed is the remainder.
      // Counting only judged candidates would silently exclude the three
      // pre-backtest kill paths and make promoted + killed fall short of
      // attempted, which reads as lost data.
      hypotheses_killed: this.attemptsMade - promoted,
      hypotheses_schema_rejected: this.family.all.filter((s) => s.origin === 'schema_rejected').length,
      active_factors: this.ledger.activeCount,
      retired_factors: this.ledger.retiredCount,
      generator_tiers: { ...this.generatorTiers },
      current_bh_threshold_rank1: this.family.rank1Threshold(this.policy.fdr_level),
      loop_iterations: this.loopIterations,
    };
  }

  /** The most recent row for a hypothesis, or null when it has no entry yet. */
  private rowFor(hypothesisId: string): DecisionRow | null {
    const entries = this.log.readAll();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.hypothesis_id === hypothesisId) return entryToRow(entries[i]!, this.policy);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Live price, market summary, capability
  // -------------------------------------------------------------------------

  /**
   * A live price for a symbol, with the frozen store as a disclosed fallback.
   *
   * Frozen candles are historical (DISCOVERY ends in early August), so a price
   * taken from them is not a current price and would sail through the Guard's
   * sanity band while being months stale. The fallback exists only so a paper
   * order is still built and refused on its merits when the network is down —
   * never so that a stale price can pass as a live one. Which source answered
   * is stated in the order's refusal text.
   */
  private async priceFor(symbol: string): Promise<number> {
    try {
      const quote = await fetchSpotPrice(symbol);
      if (Number.isFinite(quote.price) && quote.price > 0) return quote.price;
      throw new Error(`price for ${symbol} was ${quote.raw}`);
    } catch (liveErr) {
      const frozen = loadFrozenCandles(symbol, 'DISCOVERY');
      const last = frozen?.candles[frozen.candles.length - 1];
      if (last) {
        throw new Error(
          `live price failed (${liveErr instanceof Error ? liveErr.message : String(liveErr)}); ` +
            `the DISCOVERY close of ${last.close} at ${new Date(last.ts).toISOString()} is ` +
            `months old and is deliberately NOT used as a live price`,
        );
      }
      throw liveErr;
    }
  }

  private capabilityNow(): HubCapability {
    if (!this.capability) {
      this.capability = describeCapability(loadAgentHubConfig());
    }
    return this.capability;
  }

  /**
   * The market summary the model is shown.
   *
   * Read LIVE where the network allows, because these fields are named
   * `_current` and a model told "BTC funding is 0.0001 today" when the number
   * actually came from a partition that ended in early August would be
   * reasoning about a market that no longer exists. The frozen DISCOVERY tail is
   * the fallback, and WHICH ONE ANSWERED IS DISCLOSED IN THE PROMPT rather than
   * silently substituted — the model is told the numbers may be historical so it
   * does not treat a stale level as a live one.
   *
   * Cached for a minute: this is context for a proposal, not an input to a
   * verdict, and re-reading it every iteration would spend the session's network
   * budget on decoration.
   */
  private async marketSummary(): Promise<LLMContext['market_summary']> {
    const now = Date.now();
    if (this.marketSummaryCache && now - this.marketSummaryCache.at < MARKET_SUMMARY_TTL_MS) {
      return this.marketSummaryCache.value;
    }

    const live = await this.readLiveSummary().catch(() => null);
    const result = live ?? this.frozenSummary();

    this.marketSummaryCache = { at: now, ...result };
    return result.value;
  }

  /** Live reads, or null when any of them fails. All four must succeed. */
  private async readLiveSummary(): Promise<{ value: LLMContext['market_summary']; source: SummarySource } | null> {
    const nowMs = Date.now();
    const fundingStartMs = nowMs - 8 * FUNDING_INTERVAL_MS;

    const [btcFunding, ethFunding, btcCandles, ethCandles] = await Promise.all([
      fetchFundingHistory('BTCUSDT', fundingStartMs),
      fetchFundingHistory('ETHUSDT', fundingStartMs),
      fetchCandles('BTCUSDT', nowMs - 61 * MINUTE_MS, nowMs),
      fetchCandles('ETHUSDT', nowMs - 61 * MINUTE_MS, nowMs),
    ]);

    if (btcFunding.length === 0 || ethFunding.length === 0) return null;

    const btcNow = tailRate(btcFunding);
    const ethNow = tailRate(ethFunding);

    return {
      source: 'live',
      value: {
        btc_funding_rate_current: btcNow,
        btc_funding_rate_7d_percentile: percentileRank(
          btcFunding.slice(-SETTLEMENTS_PER_WEEK).map((r) => r.fundingRate),
          btcNow,
        ),
        btc_spot_return_1h_pct: tailReturnPct(btcCandles),
        eth_funding_rate_current: ethNow,
        eth_spot_return_1h_pct: tailReturnPct(ethCandles),
      },
    };
  }

  /** The DISCOVERY tail, labelled as historical rather than passed off as live. */
  private frozenSummary(): { value: LLMContext['market_summary']; source: SummarySource } {
    const btcFunding = loadFrozenFunding('BTCUSDT', 'DISCOVERY')?.records ?? [];
    const ethFunding = loadFrozenFunding('ETHUSDT', 'DISCOVERY')?.records ?? [];
    const btcCandles = loadFrozenCandles('BTCUSDT', 'DISCOVERY')?.candles ?? [];
    const ethCandles = loadFrozenCandles('ETHUSDT', 'DISCOVERY')?.candles ?? [];

    const btcTail = tailRate(btcFunding);

    return {
      source: 'frozen',
      value: {
        btc_funding_rate_current: btcTail,
        btc_funding_rate_7d_percentile: percentileRank(
          btcFunding.slice(-SETTLEMENTS_PER_WEEK).map((r) => r.fundingRate),
          btcTail,
        ),
        btc_spot_return_1h_pct: tailReturnPct(btcCandles),
        eth_funding_rate_current: tailRate(ethFunding),
        eth_spot_return_1h_pct: tailReturnPct(ethCandles),
      },
    };
  }

  private async buildLLMContext(): Promise<LLMContext> {
    const discovery = partitionWindow('DISCOVERY');
    const stats = this.getStats();
    const summary = await this.marketSummary();
    const limit = this.breaker.maxLogEntriesInContext;

    // Only entries that actually carry a hypothesis can be described. An entry
    // without one is one written before the log stored hypotheses, and inventing
    // a signal and target to fill the shape would put a fabricated idea in front
    // of the model as though it had been tested.
    const recentKills = this.log
      .readAll()
      .filter((e) => e.gate_decision === 'KILL' && typeof e.hypothesis === 'object' && e.hypothesis !== null)
      .slice(-limit)
      .map((e) => {
        const h = e.hypothesis as ProposedHypothesis;
        return {
          factor_id: e.hypothesis_id,
          signal: h.signal,
          target: h.target,
          kill_reason: (e.gate_reason ?? 'insufficient_obs') as KillReason,
          ic: e.ic,
          t_stat: e.t_stat,
        };
      });

    return {
      session: {
        session_id: this.sessionId,
        hypotheses_attempted: stats.hypotheses_attempted,
        hypotheses_promoted: stats.hypotheses_promoted,
        hypotheses_killed: stats.hypotheses_killed,
        hypotheses_retired: stats.retired_factors,
        current_fdr_level: this.policy.fdr_level,
        discovery_window_start: new Date(discovery.startMs).toISOString(),
        discovery_window_end: new Date(discovery.endMs).toISOString(),
      },
      promoted_factors: this.ledger.leaderboard().slice(0, limit).map((f) => ({
        factor_id: f.factor_id,
        signal: f.signal,
        target: f.target,
        window_minutes: f.window_minutes,
        direction: f.direction,
        ic: f.ic,
        t_stat: f.t_stat,
        hit_rate: f.hit_rate,
        n_obs: f.n_obs,
        paper_pnl_usdt: f.paper_pnl_usdt,
        decay_half_life_days: f.decay_half_life_days,
        status: f.status,
      })),
      recent_kills: recentKills,
      market_summary: summary,
      market_summary_source: this.marketSummaryCache?.source ?? 'frozen',
      allowed_signals: this.allowedSignals(),
      allowed_targets: [...RTOKEN_SYMBOLS] as RTokenSymbol[],
      allowed_families: this.allowedFamilies(),
    };
  }

  private allowedFamilies(): ExperimentFamily[] {
    const enabled = (this.policy as unknown as { families_enabled?: unknown }).families_enabled;
    const list = Array.isArray(enabled) ? enabled.filter((f): f is string => typeof f === 'string') : [];
    const known = EXPERIMENT_FAMILIES.filter((f) => list.includes(f));
    return known.length > 0 ? [...known] : [...EXPERIMENT_FAMILIES];
  }

  private allowedSignals(): SignalId[] {
    const out = new Set<SignalId>();
    for (const family of this.allowedFamilies()) {
      for (const s of FAMILY_SIGNALS[family]) out.add(s);
    }
    return [...out];
  }

  /**
   * Emit the provenance banner at session start.
   *
   * Printed rather than assumed. Two things a reader has to be told before any
   * verdict means anything: whether the run is backed by the committed dataset
   * or by live network reads, and whether the store covers every series the
   * session will read. A partial store still produces a `dataset_sha256`, and
   * without this line that hash would read as attestation for data it does not
   * describe.
   */
  private emitProvenanceNote(): void {
    const hash = frozenDatasetHash();
    const coverage = frozenCoverage({
      symbols: [...REFERENCE_COINS, ...RTOKEN_SYMBOLS],
      partitions: ['DISCOVERY', 'VALIDATION', 'LOCKED_TEST'],
    });
    const capability = this.capabilityNow();

    this.bus.emit(
      'session_started',
      hash === null
        ? 'NO frozen dataset is present — every backtest will read the live Bitget API, and ' +
          'dataset_sha256 will be null in every entry. Verdicts from this session are not ' +
          'comparable to one backed by the committed dataset.'
        : `frozen dataset ${hash.slice(0, 19)}… covers ${coverage.present.length} series` +
          (coverage.complete
            ? ' (complete — the hash describes every leg of every verdict)'
            : ` — INCOMPLETE, missing: ${coverage.missing.join(', ')}. Verdicts whose signal legs ` +
              `fall back to the live API are recorded as 'live' and this hash does not describe them.`),
      {},
    );

    this.bus.emit(
      'session_started',
      `generator chain: ${describeChain(this.generator.config)}; execution: ${capability.detail}`,
      {},
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultLogPath(): string {
  // scripts/ and src/ both live under apps/agent, and the log is a submission
  // artifact at a fixed, committed location — so it is resolved from the
  // process's working directory rather than from this module's own path, which
  // would put it somewhere different under a bundled build.
  return 'logs/decisions.jsonl';
}

function originFor(reason: KillReason): 'schema_rejected' | 'duplicate' | 'lookback_bias' | 'tested' {
  switch (reason) {
    case 'schema_validation_failed':
      return 'schema_rejected';
    case 'duplicate_family':
      return 'duplicate';
    case 'lookback_bias_detected':
      return 'lookback_bias';
    default:
      return 'tested';
  }
}

function fmt(x: number, d = 4): string {
  return Number.isFinite(x) ? x.toFixed(d) : String(x);
}

function describeProposal(p: ProposedHypothesis): string {
  return (
    `${p.signal} ${p.target} ${p.condition.operator} ${p.condition.threshold} ` +
    `(lookback ${p.condition.lookback_minutes}m) → ${p.direction} over ${p.forward_return_minutes}m`
  );
}

function tailRate(records: readonly { fundingRate: number }[]): number {
  return records.length ? records[records.length - 1]!.fundingRate : 0;
}

/** Percent return over the last hour of a candle list. */
function tailReturnPct(candles: readonly { ts: number; close: number }[]): number {
  if (candles.length < 2) return 0;
  const last = candles[candles.length - 1]!;
  const target = last.ts - 60 * MINUTE_MS;
  let prev = candles[0]!;
  for (const c of candles) {
    if (c.ts <= target) prev = c;
    else break;
  }
  if (prev.close === 0) return 0;
  return ((last.close - prev.close) / prev.close) * 100;
}

/**
 * Funding settlements hold for 8 hours, so a "current rate" read from the store
 * is only meaningful if the store reaches the partition end. Exported for the
 * same reason `FUNDING_INTERVAL_MS` is: so a reader can check the claim.
 */
export const __summaryUsesFundingInterval = FUNDING_INTERVAL_MS;
