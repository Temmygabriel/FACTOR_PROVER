/**
 * The generator chain's failure taxonomy — the rule that decides whether a bad
 * iteration is "the provider is down" or "we asked too fast".
 *
 * WHY THIS FILE EXISTS. The first live session halted itself after eight
 * hypotheses with `reason: max_consecutive_llm_failures` and the detail "the
 * provider is down and the loop is generating hypotheses it cannot attribute to
 * a model". The provider was not down. It was returning HTTP 429 with
 * `x-ratelimit-reset-tokens: 46.755s` — the loop, running on a free tier with an
 * 8,000-token-per-minute budget and a 1.5-second iteration delay, was asking
 * roughly ten times faster than it was allowed to. A pacing decision this loop
 * made was recorded as an outage at the provider, and the session died for it.
 *
 * Two things are asserted here, and the second is the one that matters:
 *
 *   1. A 429 is classified `rate_limited` and does NOT advance the provider
 *      circuit.
 *   2. A genuine transport failure STILL trips it. A test that only proved the
 *      first would pass just as happily against a chain that had stopped
 *      counting failures at all, which would be a worse bug than the one being
 *      fixed.
 *
 * The network is stubbed. Nothing here talks to a provider.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HypothesisGenerator,
  countsAsProviderFailure,
  type GeneratorConfig,
  type TierFailure,
} from '../src/llm/provider.js';
import { parseDurationMs } from '../src/llm/openaiCompat.js';
import type { LLMContext } from '../src/types.js';

// ---------------------------------------------------------------------------
// Stub transport
// ---------------------------------------------------------------------------

/** A response shaped like the parts of `Response` that `chatCompletion` reads. */
function stubResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

/** The exact shape Groq's free tier returns when the token bucket is empty. */
const RATE_LIMIT_BODY =
  '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in ' +
  'organization `org_x` on tokens per minute (TPM): Limit 8000, Used 6321, ' +
  'Requested 2077. Please try again in 46.755s.","type":"tokens"}}';

/**
 * Headers copied from a real Groq 429.
 *
 * The pair is the point: `retry-after: 3` and `x-ratelimit-reset-tokens: 46.755s`
 * disagree by a factor of fifteen. Honouring the short one re-sends into a bucket
 * that is still empty.
 */
const RATE_LIMIT_HEADERS = { 'retry-after': '3', 'x-ratelimit-reset-tokens': '46.755s' };

const VALID_PROPOSAL = {
  signal: 'btc_funding_rate',
  condition: { operator: 'gt', threshold: 0.00005, lookback_minutes: 60 },
  target: 'RCOINUSDT',
  direction: 'positive',
  forward_return_minutes: 30,
  experiment_family: 'funding_to_rtoken',
};

const okBody = (): string =>
  JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PROPOSAL) } }] });

/**
 * Queue one stubbed reply per call, in order. The last entry repeats, so a test
 * can set a two-step sequence and then let a loop run.
 */
function stubFetchSequence(...responses: Array<ReturnType<typeof stubResponse>>): void {
  const mock = vi.fn(async () => responses[Math.min(mock.mock.calls.length - 1, responses.length - 1)]);
  vi.stubGlobal('fetch', mock);
}

/** Every reply is a 429. */
function stubAlwaysRateLimited(): void {
  stubFetchSequence(stubResponse(429, RATE_LIMIT_BODY, RATE_LIMIT_HEADERS));
}

function fetchCallCount(): number {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A chain with ONE model tier (groq) and no keys for the others, which is the
 * deployed configuration. `maxRateLimitWaitMs` is 5 so the suite does not
 * actually sleep for the provider's 46 seconds; the cap is exercised rather than
 * bypassed, and the cap is itself asserted below.
 */
function config(over: Partial<GeneratorConfig> = {}): GeneratorConfig {
  return {
    primary: 'groq',
    groqApiKey: 'gsk_stub_key_long_enough_to_redact',
    groqModel: 'openai/gpt-oss-120b',
    geminiApiKey: null,
    geminiModel: 'gemini-2.0-flash',
    openaiApiKey: null,
    openaiModel: 'gpt-4o-mini',
    allowDeterministicFallback: true,
    maxConsecutiveFailures: 3,
    maxRateLimitRetries: 2,
    maxRateLimitWaitMs: 5,
    ...over,
  };
}

const CONTEXT: LLMContext = {
  session: {
    session_id: 'S-test',
    hypotheses_attempted: 0,
    hypotheses_promoted: 0,
    hypotheses_killed: 0,
    hypotheses_retired: 0,
    current_fdr_level: 0.1,
    discovery_window_start: '2026-06-15T00:00:00Z',
    discovery_window_end: '2026-08-05T23:59:59Z',
  },
  promoted_factors: [],
  recent_kills: [],
  market_summary: {
    btc_funding_rate_current: 0.000033,
    btc_funding_rate_7d_percentile: 55,
    btc_spot_return_1h_pct: 0.12,
    eth_funding_rate_current: 0.000041,
    eth_spot_return_1h_pct: -0.08,
  },
  market_summary_source: 'frozen',
  allowed_signals: [
    'btc_funding_rate',
    'eth_funding_rate',
    'btc_spot_return',
    'eth_spot_return',
    'btc_funding_x_spot',
  ],
  allowed_targets: ['RCOINUSDT', 'RNVDAUSDT', 'RGOOGLUSDT', 'RAAPLUSDT', 'RAMZNUSDT', 'RSPYUSDT', 'RQQQUSDT'],
  allowed_families: ['funding_to_rtoken', 'btc_momentum_to_rtoken', 'combined_cross_asset'],
};

const kinds = (failures: readonly TierFailure[]): string[] => failures.map((f) => f.kind);

// ---------------------------------------------------------------------------
// The reset hint
// ---------------------------------------------------------------------------

describe('parseDurationMs', () => {
  it('reads the Go-style durations Groq emits', () => {
    // 46.755s is the value measured on the real 429 that killed the live session.
    expect(parseDurationMs('46.755s')).toBe(46_755);
    expect(parseDurationMs('1m2.5s')).toBe(62_500);
    expect(parseDurationMs('2m')).toBe(120_000);
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('0.25s')).toBe(250);
  });

  it('returns null rather than a wrong number for anything it does not understand', () => {
    // A provider-side format change must degrade to "no hint" — which the caller
    // treats as a conservative default — never to a plausible-looking wrong wait.
    expect(parseDurationMs(null)).toBeNull();
    expect(parseDurationMs('')).toBeNull();
    expect(parseDurationMs('soon')).toBeNull();
    expect(parseDurationMs('46.755')).toBeNull();
    expect(parseDurationMs('-5s')).toBeNull();
    expect(parseDurationMs('0s')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The rule the loop asks
// ---------------------------------------------------------------------------

describe('countsAsProviderFailure', () => {
  const failure = (kind: TierFailure['kind']): TierFailure => ({
    tier: 'groq',
    kind,
    message: 'x',
  });

  it('counts a transport failure', () => {
    expect(countsAsProviderFailure([failure('transport')])).toBe(true);
  });

  it('does NOT count a rate limit', () => {
    // The bug, stated as an assertion.
    expect(countsAsProviderFailure([failure('rate_limited')])).toBe(false);
  });

  it('does not count an unconfigured tier or an already-open circuit', () => {
    // Neither is an outage. Counting them would halt a session that is running
    // exactly as designed — the case where no provider key is configured at all.
    expect(countsAsProviderFailure([failure('unavailable')])).toBe(false);
    expect(countsAsProviderFailure([failure('circuit_open')])).toBe(false);
    expect(countsAsProviderFailure([])).toBe(false);
  });

  it('finds a transport failure among a rate limit and an unavailable tier', () => {
    expect(
      countsAsProviderFailure([failure('rate_limited'), failure('transport'), failure('unavailable')]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End to end through the real generator
// ---------------------------------------------------------------------------

describe('a rate-limited tier', () => {
  it('is reported as rate_limited, never as a transport failure', async () => {
    stubAlwaysRateLimited();
    const gen = new HypothesisGenerator(config({ maxRateLimitRetries: 0 }));

    const outcome = await gen.generate(CONTEXT, 0);

    expect(kinds(outcome.tierFailures)).toContain('rate_limited');
    expect(kinds(outcome.tierFailures)).not.toContain('transport');
    // The message must carry the provider's own words, so a reader can see the
    // 429 and the bucket limit rather than a summary of them.
    expect(outcome.tierFailures[0]?.message).toMatch(/429/);
    expect(outcome.tierFailures[0]?.message).toMatch(/Limit 8000/);
  });

  it('does not open the provider circuit, however many times in a row it happens', async () => {
    stubAlwaysRateLimited();
    const gen = new HypothesisGenerator(config({ maxRateLimitRetries: 0 }));

    // Well past the threshold of 3. Before the fix, the third consecutive call
    // opened the circuit and the chain stopped calling models at all.
    for (let i = 0; i < 6; i += 1) await gen.generate(CONTEXT, i);

    expect(gen.circuitOpen).toBe(false);
    expect(kinds((await gen.generate(CONTEXT, 6)).tierFailures)).not.toContain('circuit_open');
  });

  it('keeps calling the model every iteration instead of giving up on it', async () => {
    stubAlwaysRateLimited();
    const gen = new HypothesisGenerator(config({ maxRateLimitRetries: 0 }));

    for (let i = 0; i < 6; i += 1) await gen.generate(CONTEXT, i);

    // One request per iteration, six iterations. If the circuit had opened, the
    // later iterations would never have reached the network at all.
    expect(fetchCallCount()).toBe(6);
  });

  it('does not reset the transport-failure counter either', async () => {
    // A 429 is not a success. Treating it as one would let a loop that is being
    // throttled between every real outage hide a provider that really is failing.
    stubFetchSequence(
      stubResponse(500, 'upstream error'),
      stubResponse(500, 'upstream error'),
      stubResponse(429, RATE_LIMIT_BODY, RATE_LIMIT_HEADERS),
      stubResponse(500, 'upstream error'),
    );
    const gen = new HypothesisGenerator(config({ maxRateLimitRetries: 0 }));

    const a = await gen.generate(CONTEXT, 0);
    const b = await gen.generate(CONTEXT, 1);
    expect(kinds(a.tierFailures)).toContain('transport');
    expect(kinds(b.tierFailures)).toContain('transport');
    expect(gen.circuitOpen).toBe(false);

    const c = await gen.generate(CONTEXT, 2);
    expect(kinds(c.tierFailures)).toContain('rate_limited');
    expect(gen.circuitOpen).toBe(false);

    // Three real failures total, so the third one trips it. Had the 429 reset
    // the counter, this would need three more 500s to reach the same place.
    const d = await gen.generate(CONTEXT, 3);
    expect(gen.circuitOpen).toBe(true);
    expect(kinds(d.tierFailures)).toContain('circuit_open');
  });
});

describe('a rate-limited tier that recovers', () => {
  it('answers from the model, and still records that it was throttled', async () => {
    stubFetchSequence(
      stubResponse(429, RATE_LIMIT_BODY, RATE_LIMIT_HEADERS),
      stubResponse(200, okBody()),
    );
    const gen = new HypothesisGenerator(config({ maxRateLimitRetries: 2 }));

    const outcome = await gen.generate(CONTEXT, 0);

    expect(outcome.tier).toBe('groq');
    expect(outcome.proposal).not.toBeNull();
    expect(outcome.schemaError).toBeNull();
    // Recorded even though it succeeded: a silent 46-second wait is exactly the
    // kind of thing that belongs in the record rather than being inferred from a
    // gap between timestamps.
    expect(kinds(outcome.tierFailures)).toContain('rate_limited');
    expect(kinds(outcome.tierFailures)).not.toContain('transport');
    expect(fetchCallCount()).toBe(2);
  });

  it('gives up after maxRateLimitRetries and falls back rather than hanging', async () => {
    stubAlwaysRateLimited();
    const gen = new HypothesisGenerator(config({ maxRateLimitRetries: 2 }));

    const outcome = await gen.generate(CONTEXT, 0);

    expect(fetchCallCount()).toBe(3); // the original plus two retries
    expect(outcome.tier).toBe('deterministic');
    expect(outcome.tierFailures[0]?.message).toMatch(/still rate limited after 2 retries/);
  });

  it('respects maxRateLimitWaitMs as a ceiling', async () => {
    // The reset hint says 46.755s; the cap says 5ms. A provider returning an
    // absurd hint must not be able to stall a session for the length of it.
    stubAlwaysRateLimited();
    const gen = new HypothesisGenerator(config({ maxRateLimitRetries: 1, maxRateLimitWaitMs: 5 }));

    const started = Date.now();
    await gen.generate(CONTEXT, 0);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000); // nowhere near the 46.755s hint
  });
});

describe('a genuinely unreachable provider', () => {
  it('still trips the provider circuit at the policy threshold', async () => {
    // The other half of the fix. Reclassifying 429s must not have made the chain
    // blind to a provider that has actually stopped answering.
    stubFetchSequence(stubResponse(503, 'service unavailable'));
    const gen = new HypothesisGenerator(config({ maxConsecutiveFailures: 3 }));

    const first = await gen.generate(CONTEXT, 0);
    expect(kinds(first.tierFailures)).toContain('transport');
    expect(gen.circuitOpen).toBe(false);

    await gen.generate(CONTEXT, 1);
    expect(gen.circuitOpen).toBe(false);

    const third = await gen.generate(CONTEXT, 2);
    expect(gen.circuitOpen).toBe(true);
    expect(kinds(third.tierFailures)).toContain('transport');
    expect(kinds(third.tierFailures)).toContain('circuit_open');

    // And once open, the network is no longer touched.
    const callsWhenOpen = fetchCallCount();
    await gen.generate(CONTEXT, 3);
    expect(fetchCallCount()).toBe(callsWhenOpen);
  });

  it('resets the counter on a real success', async () => {
    stubFetchSequence(
      stubResponse(500, 'upstream error'),
      stubResponse(500, 'upstream error'),
      stubResponse(200, okBody()),
      stubResponse(500, 'upstream error'),
    );
    const gen = new HypothesisGenerator(config({ maxConsecutiveFailures: 3 }));

    await gen.generate(CONTEXT, 0);
    await gen.generate(CONTEXT, 1);
    expect(gen.circuitOpen).toBe(false);

    const recovered = await gen.generate(CONTEXT, 2);
    expect(recovered.proposal).not.toBeNull();

    // Two failures, a success, then one more failure: still under the threshold.
    await gen.generate(CONTEXT, 3);
    expect(gen.circuitOpen).toBe(false);
  });
});
