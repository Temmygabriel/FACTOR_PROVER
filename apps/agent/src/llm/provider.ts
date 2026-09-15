/**
 * The generator chain: Groq -> Gemini -> deterministic enumerator.
 *
 * WHY THREE TIERS. This project has no budget and no ability to attach a card,
 * so it runs entirely on free tiers. Free tiers are rate-limited, and a rate
 * limit that stops the loop stops the demo. The chain makes the loop's ability
 * to keep proposing independent of any single provider's mood.
 *
 * WHAT THIS LAYER IS NOT. It cannot influence a verdict. It returns a candidate
 * and reports which tier produced it. Everything that decides whether a
 * hypothesis lives or dies — bars, floors, the multiple-testing correction —
 * lives in gate_policy.json and is applied by src/gate/gate.ts. The chain's only
 * authority is over WHICH QUESTION GETS ASKED NEXT.
 *
 * THREE DISTINCT FAILURE KINDS, DELIBERATELY NOT CONFLATED:
 *
 *   TRANSPORT FAILURE — the request failed, timed out, or the reply was not
 *   parseable JSON. Nothing was learned about markets. This is a tier failure:
 *   the chain advances and the next tier tries. It must never become a KILL,
 *   because a KILL has to be a statement about the idea, not about the weather.
 *
 *   RATE LIMIT — the provider was healthy and refused because this loop asked
 *   faster than its budget allows. This is a fact about OUR pacing, not about
 *   the provider, and the two must not be recorded as each other. It does not
 *   advance the provider circuit, and it does not count as an outage to a caller
 *   deciding whether the session should halt. The chain waits for the reset hint
 *   and re-sends, up to a bounded number of times.
 *
 *   SCHEMA FAILURE — the model returned well-formed JSON that violates the
 *   hypothesis schema. The idea is genuinely malformed (an unknown signal, a
 *   window outside the family's preregistered bounds, a funding threshold above
 *   the cap). This is returned to the loop as a real, loggable KILL with reason
 *   `schema_validation_failed`, and the chain does NOT advance.
 *
 * The second choice is deliberate. Silently re-rolling until the model produces
 * something valid would hide the failure, and the failure is worth seeing: it is
 * the schema wall doing its job, and it appears in the demo as a KILLED verdict
 * rather than as a gap in the record.
 *
 * REPRODUCIBILITY. Nothing here is random. Temperature is derived from the
 * attempt index, and the fallback enumerator is a pure function of the attempt
 * index, so a session replayed with the same tier availability reproduces its
 * proposals exactly. That is what lets the decision log be audited rather than
 * merely believed.
 */

import {
  loadGatePolicy,
  type GatePolicy,
} from '../config.js';
import { validateProposal } from '../schema/validate.js';
import type { GeneratorTier, LLMContext, ProposedHypothesis } from '../types.js';
import { enumerateHypothesis } from './deterministic.js';
import { geminiGenerate } from './gemini.js';
import { chatCompletion, extractJsonObject, ProviderError } from './openaiCompat.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface GeneratorConfig {
  /** Tier to try first. The rest of the configured tiers follow, in order. */
  primary: GeneratorTier;
  groqApiKey: string | null;
  groqModel: string;
  geminiApiKey: string | null;
  geminiModel: string;
  openaiApiKey: string | null;
  openaiModel: string;
  /** When false, a total model blackout is a hard error instead of a fallback. */
  allowDeterministicFallback: boolean;
  /** Consecutive transport failures before the chain stops calling models. */
  maxConsecutiveFailures: number;
  /**
   * How many times to re-send a request the provider rate-limited, within the
   * same iteration, before treating the tier as unavailable for that iteration.
   *
   * Bounded on purpose. A rate limit that outlasts a couple of retries is a
   * pacing problem, and no amount of retrying fixes a loop that is asking faster
   * than its budget allows — the loop's own iteration delay has to. Retrying
   * forever would convert "too fast" into "hung".
   */
  maxRateLimitRetries: number;
  /**
   * Ceiling on a single rate-limit wait. A provider that returns an absurd reset
   * hint must not be able to stall a session for an hour.
   */
  maxRateLimitWaitMs: number;
}

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

function envOrNull(name: string): string | null {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Read the chain's configuration from the environment, with the circuit
 * breaker's threshold taken from the preregistered policy rather than from an
 * env var. The number of consecutive failures the system tolerates before it
 * stops trusting models is a policy decision, so it belongs in the policy file
 * alongside every other threshold — not in a deployment setting someone can
 * quietly change.
 */
export function loadGeneratorConfig(): GeneratorConfig {
  let maxConsecutiveFailures = 3;
  try {
    const policy: GatePolicy = loadGatePolicy().data;
    const n = policy.circuit_breaker?.max_consecutive_llm_failures;
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) {
      maxConsecutiveFailures = n;
    }
  } catch {
    // Policy unreadable: fall back to the documented default rather than
    // letting a config problem take down generation entirely.
  }

  const raw = (envOrNull('LLM_PROVIDER') ?? 'groq').toLowerCase();
  const allowed: readonly string[] = ['groq', 'gemini', 'openai', 'anthropic'];
  const primary = (allowed.includes(raw) ? raw : 'groq') as GeneratorTier;

  return {
    primary,
    groqApiKey: envOrNull('GROQ_API_KEY'),
    groqModel: envOrNull('GROQ_MODEL') ?? 'openai/gpt-oss-120b',
    geminiApiKey: envOrNull('GEMINI_API_KEY'),
    geminiModel: envOrNull('GEMINI_MODEL') ?? 'gemini-2.0-flash',
    openaiApiKey: envOrNull('OPENAI_API_KEY'),
    openaiModel: envOrNull('OPENAI_MODEL') ?? 'gpt-4o-mini',
    allowDeterministicFallback:
      (envOrNull('LLM_ALLOW_DETERMINISTIC_FALLBACK') ?? 'true').toLowerCase() !== 'false',
    maxConsecutiveFailures,
    maxRateLimitRetries: posIntOr('LLM_RATE_LIMIT_RETRIES', 2),
    maxRateLimitWaitMs: posIntOr('LLM_RATE_LIMIT_MAX_WAIT_MS', 65_000),
  };
}

/**
 * A positive integer from the environment, or the default.
 *
 * Rejects zero and negatives rather than clamping them: `LLM_RATE_LIMIT_RETRIES=0`
 * is a reasonable thing to want (disable retrying) but a negative is a typo, and
 * silently turning a typo into a different number is how a deployment ends up
 * doing something nobody chose.
 */
function posIntOr(name: string, fallback: number): number {
  const raw = envOrNull(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/**
 * Strip configured secrets out of any string that might reach the log.
 *
 * Upstream clients put keys in headers precisely so they stay out of URLs, but
 * an error body is arbitrary text and a provider is free to echo the request
 * back. The decision log is a committed submission artifact, so a key leaking
 * into a failure message would be committed to a public repository. Redacting
 * here means the log can be written verbatim without that risk.
 */
function redact(message: string, secrets: Array<string | null>): string {
  let out = message;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * Why a tier contributed no proposal.
 *
 * The distinction is load-bearing and cannot be recovered from the message
 * text: 'unavailable' means the tier was never called, 'transport' means it was
 * called and the provider failed, 'rate_limited' means it was called and refused
 * because we asked too often, 'circuit_open' means it was skipped because the
 * chain had already given up.
 *
 * A caller counting provider failures has to count only 'transport'. Counting
 * 'unavailable' as a failure would make a deployment with no API keys configured
 * (a legitimate, supported configuration in which the deterministic enumerator
 * carries the session) trip the breaker after three iterations and halt a
 * session that was working exactly as designed. Counting 'rate_limited' would
 * attribute a pacing decision made by this loop to an outage at the provider —
 * which is precisely the misattribution that halted the first live session.
 */
export type TierFailureKind = 'unavailable' | 'transport' | 'rate_limited' | 'circuit_open';

export interface TierFailure {
  tier: GeneratorTier;
  kind: TierFailureKind;
  message: string;
}

/**
 * Did this iteration fail because a provider could not be reached?
 *
 * The single place that question is answered. `src/session/loop.ts` uses it to
 * decide whether a failed iteration counts against the session breaker, and it
 * is exported so the rule can be tested directly instead of only through a
 * running loop. The distinction it encodes — "the provider is down" versus "we
 * asked too fast" — is the difference between halting a healthy session and
 * pacing it, and it should not be re-derived by each caller from an array of
 * kind strings.
 */
export function countsAsProviderFailure(failures: readonly TierFailure[]): boolean {
  return failures.some((f) => f.kind === 'transport');
}

export interface GenerationOutcome {
  /**
   * The candidate, or null when the proposal was schema-invalid. Null with
   * `schemaError` set is a legitimate, loggable outcome — not an error.
   */
  proposal: ProposedHypothesis | null;
  /** Which tier produced the proposal. Recorded verbatim in the decision log. */
  tier: GeneratorTier;
  /** Model name for model tiers; null for the enumerator. */
  model: string | null;
  /** Set when the tier returned JSON that the schema rejected. */
  schemaError: string | null;
  /** Transport failures encountered on the way to this outcome. */
  tierFailures: TierFailure[];
  /** True when the circuit breaker had tripped and models were skipped. */
  circuitOpen: boolean;
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/** Tiers in the order they are attempted, excluding the enumerator. */
function chainOrder(cfg: GeneratorConfig): GeneratorTier[] {
  const rest: GeneratorTier[] = (['groq', 'gemini', 'openai', 'anthropic'] as const).filter(
    (t) => t !== cfg.primary,
  );
  return [cfg.primary, ...rest];
}

function isConfigured(tier: GeneratorTier, cfg: GeneratorConfig): boolean {
  switch (tier) {
    case 'groq':
      return cfg.groqApiKey !== null;
    case 'gemini':
      return cfg.geminiApiKey !== null;
    case 'openai':
      return cfg.openaiApiKey !== null;
    case 'anthropic':
      // Not implemented in this build. Reported as unconfigured so the chain
      // falls through honestly rather than appearing to try and failing oddly.
      return false;
    case 'deterministic':
      return true;
  }
}

/** Why a tier is unavailable, for the log. Null when it is available. */
function unavailabilityReason(tier: GeneratorTier, cfg: GeneratorConfig): string | null {
  if (isConfigured(tier, cfg)) return null;
  if (tier === 'anthropic') {
    return 'anthropic tier is not implemented in this build (no client); chain advanced';
  }
  const varName =
    tier === 'groq' ? 'GROQ_API_KEY' : tier === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
  return `${varName} is not set; tier skipped`;
}

/**
 * Temperature as a function of attempt index.
 *
 * A fixed temperature makes a session produce one idea and then minor variants
 * of it. A random temperature would break replay. Deriving it from the attempt
 * index gives variety across a session while keeping any single attempt exactly
 * reproducible — the same attempt number always samples at the same temperature.
 */
function temperatureFor(attemptIndex: number): number {
  return 0.80 + ((attemptIndex % 5) * 0.04) + ((attemptIndex % 3) * 0.01);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Wait used when a rate-limited response carried no usable reset hint.
 *
 * A minute is the window Groq's free tier measures tokens over, so it is the
 * shortest wait that can plausibly help — and this path is only reached when the
 * provider declined to say, which is itself a reason to be conservative.
 */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * Added to every rate-limit wait.
 *
 * The reset hint describes the bucket at the moment the 429 was GENERATED, not
 * the moment this process reads it, so by the time the response has been parsed
 * some of the wait has already elapsed — and re-sending right on the boundary
 * races the refill. A fixed margin covers that without introducing randomness,
 * which matters because the file header promises nothing here is random and the
 * pacing path has no business breaking that promise.
 */
const RATE_LIMIT_MARGIN_MS = 2_000;

/**
 * Did this failure come from being asked too often, rather than from a provider
 * that is down?
 *
 * Narrowed to `ProviderError` on purpose. An arbitrary error whose message
 * happens to contain "429" — a schema error, a file error, a gRPC-ish string
 * from somewhere else — must not be able to talk the chain out of counting a
 * real outage.
 */
function isRateLimited(err: unknown): err is ProviderError {
  return err instanceof ProviderError && err.rateLimited;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HypothesisGenerator {
  private readonly cfg: GeneratorConfig;
  private readonly system: string;
  private consecutiveFailures = 0;
  /** How many hypotheses each tier has produced. Reported at session end. */
  private readonly produced: Record<string, number> = {};

  constructor(cfg: GeneratorConfig = loadGeneratorConfig()) {
    this.cfg = cfg;
    this.system = buildSystemPrompt();
  }

  get config(): GeneratorConfig {
    return this.cfg;
  }

  get stats(): Record<string, number> {
    return { ...this.produced };
  }

  /** True once transport failures have reached the policy threshold. */
  get circuitOpen(): boolean {
    return this.consecutiveFailures >= this.cfg.maxConsecutiveFailures;
  }

  /**
   * Produce one hypothesis.
   *
   * Never throws for a provider problem: a provider outage degrades the tier,
   * it does not stop the loop. It throws only when every tier has failed AND
   * the deterministic fallback has been explicitly disabled.
   */
  async generate(ctx: LLMContext, attemptIndex: number): Promise<GenerationOutcome> {
    const tierFailures: TierFailure[] = [];
    const secrets = [
      this.cfg.groqApiKey,
      this.cfg.geminiApiKey,
      this.cfg.openaiApiKey,
    ];

    const circuitWasOpen = this.circuitOpen;
    if (circuitWasOpen) {
      tierFailures.push({
        tier: this.cfg.primary,
        kind: 'circuit_open',
        message:
          `circuit open: ${this.consecutiveFailures} consecutive provider failures ` +
          `(policy threshold ${this.cfg.maxConsecutiveFailures}); model tiers skipped`,
      });
    } else {
      const user = buildUserPrompt(ctx);

      for (const tier of chainOrder(this.cfg)) {
        const reason = unavailabilityReason(tier, this.cfg);
        if (reason) {
          // Only record it if the tier was reachable in principle — a missing
          // key on a tier we never intended to use is noise, not a failure.
          if (tier === this.cfg.primary || isConfigured(tier, this.cfg)) {
            tierFailures.push({ tier, kind: 'unavailable', message: reason });
          }
          continue;
        }

        try {
          const text = await this.callTier(tier, { user, attemptIndex });
          return this.finishFromText(tier, text, tierFailures, circuitWasOpen);
        } catch (err) {
          const failure = err instanceof Error ? err : new Error(String(err));

          if (!isRateLimited(failure)) {
            // Transport failure. Advance the chain; do not let it become a KILL.
            if (this.noteTransportFailure(tier, failure, secrets, tierFailures)) break;
            continue;
          }

          const retry = await this.retryWhileRateLimited(tier, { user, attemptIndex }, failure);

          if ('text' in retry) {
            // Recorded even though it succeeded. A silent 47-second wait is
            // exactly the kind of thing that belongs in the record rather than
            // being inferred from a gap between timestamps.
            tierFailures.push({
              tier,
              kind: 'rate_limited',
              message: redact(
                `${failure.message} — waited, then the same tier answered within ` +
                  `the same iteration`,
                secrets,
              ),
            });
            return this.finishFromText(tier, retry.text, tierFailures, circuitWasOpen);
          }

          if (!isRateLimited(retry.err)) {
            // The bucket refilled and the provider then failed for a reason that
            // has nothing to do with our request rate. That IS an outage.
            if (this.noteTransportFailure(tier, retry.err, secrets, tierFailures)) break;
            continue;
          }

          // Still throttled after every retry. Record it as what it is — our own
          // request rate — and do NOT advance the provider circuit. Counting
          // this as a transport failure is what halted the first live session:
          // the session breaker tripped and its message then blamed "the
          // provider is down" for a pace this loop chose. The next tier may be a
          // different provider with an untouched bucket, so the chain continues
          // rather than breaking.
          tierFailures.push({
            tier,
            kind: 'rate_limited',
            message: redact(
              `${failure.message} — still rate limited after ` +
                `${this.cfg.maxRateLimitRetries} retries; tier skipped for this iteration`,
              secrets,
            ),
          });
        }
      }
    }

    if (!this.cfg.allowDeterministicFallback) {
      throw new Error(
        `every model tier failed and the deterministic fallback is disabled: ` +
          tierFailures.map((f) => `${f.tier}: ${f.message}`).join(' | '),
      );
    }

    // The enumerator cannot fail: it is a pure function of the attempt index
    // against a space that was validated at build time.
    const proposal = enumerateHypothesis(attemptIndex);
    this.produced['deterministic'] = (this.produced['deterministic'] ?? 0) + 1;
    return {
      proposal,
      tier: 'deterministic',
      model: null,
      schemaError: null,
      tierFailures,
      circuitOpen: circuitWasOpen,
    };
  }

  /**
   * Record a genuine transport failure and advance the provider circuit.
   *
   * Returns true when the chain should stop calling further model tiers — which
   * happens exactly once, on the failure that opens the circuit. Anything that
   * means "try the next tier" returns false.
   */
  private noteTransportFailure(
    tier: GeneratorTier,
    err: Error,
    secrets: Array<string | null>,
    tierFailures: TierFailure[],
  ): boolean {
    this.consecutiveFailures += 1;
    tierFailures.push({ tier, kind: 'transport', message: redact(err.message, secrets) });

    if (!this.circuitOpen) return false;

    tierFailures.push({
      tier,
      kind: 'circuit_open',
      message:
        `circuit opened after ${this.consecutiveFailures} consecutive failures; ` +
        `remaining model tiers skipped`,
    });
    return true;
  }

  /**
   * Wait out a rate limit and re-send, up to `maxRateLimitRetries` times.
   *
   * Returns the tier's reply, or the last error it produced — which may be
   * another 429 (still throttled) or something else entirely (the bucket
   * refilled and the provider then failed for an unrelated reason). The caller
   * decides which, because the two mean opposite things about the provider.
   *
   * The wait honours the provider's own reset hint, which is the only number
   * that knows how full the bucket is, and is capped so a bad header cannot hang
   * a session. No randomness is used: the file header promises replay
   * determinism and pacing has no reason to be an exception.
   */
  private async retryWhileRateLimited(
    tier: GeneratorTier,
    args: { user: string; attemptIndex: number },
    first: ProviderError,
  ): Promise<{ text: string } | { err: Error }> {
    let err: Error = first;

    for (let attempt = 1; attempt <= this.cfg.maxRateLimitRetries; attempt += 1) {
      const hinted = err instanceof ProviderError && err.retryAfterMs !== undefined
        ? err.retryAfterMs
        : DEFAULT_RATE_LIMIT_WAIT_MS;
      const waitMs = Math.min(hinted + RATE_LIMIT_MARGIN_MS, this.cfg.maxRateLimitWaitMs);

      await sleep(waitMs);

      try {
        return { text: await this.callTier(tier, args) };
      } catch (next) {
        err = next instanceof Error ? next : new Error(String(next));
        // A non-429 error during a rate-limit retry is not a rate limit, and
        // retrying it on this schedule would be waiting for the wrong thing.
        if (!isRateLimited(err)) break;
      }
    }

    return { err };
  }

  /** Dispatch to the right client. Returns raw model text. */
  private async callTier(
    tier: GeneratorTier,
    args: { user: string; attemptIndex: number },
  ): Promise<string> {
    const temperature = temperatureFor(args.attemptIndex);
    // Generous relative to the ~120-token reply: a reasoning model spends output
    // tokens thinking, and a tight budget yields an empty message rather than a
    // short one, which would read as a transport failure and burn a tier.
    const maxTokens = 2000;

    switch (tier) {
      case 'groq': {
        if (!this.cfg.groqApiKey) throw new ProviderError('groq key missing');
        const res = await chatCompletion({
          apiKey: this.cfg.groqApiKey,
          baseUrl: GROQ_BASE_URL,
          model: this.cfg.groqModel,
          system: this.system,
          user: args.user,
          temperature,
          maxTokens,
          // gpt-oss models reason before answering. `low` keeps latency and
          // token use down; the task is a bounded JSON emission, not a puzzle.
          extraBody: this.cfg.groqModel.includes('gpt-oss')
            ? { reasoning_effort: 'low' }
            : undefined,
        });
        return res.text;
      }
      case 'gemini': {
        if (!this.cfg.geminiApiKey) throw new ProviderError('gemini key missing');
        const res = await geminiGenerate({
          apiKey: this.cfg.geminiApiKey,
          model: this.cfg.geminiModel,
          system: this.system,
          user: args.user,
          temperature,
          maxTokens,
        });
        return res.text;
      }
      case 'openai': {
        if (!this.cfg.openaiApiKey) throw new ProviderError('openai key missing');
        const res = await chatCompletion({
          apiKey: this.cfg.openaiApiKey,
          baseUrl: 'https://api.openai.com/v1',
          model: this.cfg.openaiModel,
          system: this.system,
          user: args.user,
          temperature,
          maxTokens,
        });
        return res.text;
      }
      case 'anthropic':
        throw new ProviderError('anthropic tier is not implemented in this build');
      case 'deterministic':
        // Reached only via the fallback path, which does not go through here.
        throw new ProviderError('deterministic tier is not a model tier');
    }
  }

  /**
   * Turn model text into an outcome. A reply that parses but fails the schema
   * is returned as a schema failure, not retried and not treated as a transport
   * failure — see the file header for why.
   */
  private finishFromText(
    tier: GeneratorTier,
    text: string,
    tierFailures: TierFailure[],
    circuitOpen: boolean,
  ): GenerationOutcome {
    // Transport succeeded, so the failure counter resets. The counter measures
    // provider reachability, not model quality.
    this.consecutiveFailures = 0;

    const parsed = extractJsonObject(text);
    if (parsed === null) {
      return {
        proposal: null,
        tier,
        model: this.modelNameFor(tier),
        schemaError: `reply was not parseable JSON: ${text.slice(0, 160)}`,
        tierFailures,
        circuitOpen,
      };
    }

    const result = validateProposal(parsed);
    if (!result.ok) {
      return {
        proposal: null,
        tier,
        model: this.modelNameFor(tier),
        schemaError: result.error,
        tierFailures,
        circuitOpen,
      };
    }

    this.produced[tier] = (this.produced[tier] ?? 0) + 1;
    return {
      proposal: result.hypothesis,
      tier,
      model: this.modelNameFor(tier),
      schemaError: null,
      tierFailures,
      circuitOpen,
    };
  }

  private modelNameFor(tier: GeneratorTier): string | null {
    switch (tier) {
      case 'groq':
        return this.cfg.groqModel;
      case 'gemini':
        return this.cfg.geminiModel;
      case 'openai':
        return this.cfg.openaiModel;
      default:
        return null;
    }
  }
}

/**
 * A one-line, human-readable description of which tiers are live. Printed at
 * session start so the operator knows what the chain will actually do, rather
 * than discovering it from a failed run.
 */
export function describeChain(cfg: GeneratorConfig): string {
  const parts: string[] = [];
  for (const tier of chainOrder(cfg)) {
    parts.push(`${tier}${isConfigured(tier, cfg) ? '' : ' (no key)'}`);
  }
  parts.push(`deterministic${cfg.allowDeterministicFallback ? '' : ' (disabled)'}`);
  return `generator chain: ${parts.join(' -> ')}`;
}
