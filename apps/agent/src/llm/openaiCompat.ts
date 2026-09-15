/**
 * OpenAI-compatible chat client — used for Groq, and for OpenAI itself if a key
 * is ever supplied.
 *
 * Groq's free tier is the project's primary generator: no card required, and the
 * endpoint speaks the OpenAI chat-completions dialect, so the same code serves
 * both providers with only a base URL and model name changing.
 *
 * `response_format: json_object` is requested so the model is constrained to
 * emit JSON rather than JSON-with-a-friendly-introduction. Even so, the reply is
 * parsed defensively — a model that ignores the instruction must produce a clean
 * tier failure, not a crash mid-loop.
 */

export interface ChatParams {
  apiKey: string;
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  /** Seconds. Groq is fast; a hung request must not stall the loop. */
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  /**
   * Provider-specific fields merged into the request body. Used for Groq's
   * `reasoning_effort` on gpt-oss models: a reasoning model spends output
   * tokens thinking, and with a tight `max_tokens` it can spend the entire
   * budget reasoning and return an empty message. Kept as an explicit escape
   * hatch rather than hardcoded, since the parameter is not part of the OpenAI
   * dialect and other OpenAI-compatible providers reject unknown fields.
   */
  extraBody?: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  model: string;
}

export class ProviderError extends Error {
  /** HTTP status when the failure came from a response. */
  status?: number;
  /** True when the failure is worth retrying on the next tier. */
  retryable: boolean;
  /**
   * How long the provider asked us to wait before re-sending, in milliseconds.
   * Set only on a rate limit, and only when the response carried a usable hint.
   *
   * This is deliberately NOT `Retry-After`. Measured against Groq's free tier on
   * 2026-09-14, a single 429 carried BOTH `retry-after: 3` and
   * `x-ratelimit-reset-tokens: 46.755s`. They disagree because `Retry-After`
   * describes when the request may be re-sent while the token bucket needs most
   * of a minute to refill — so a client that honours the short one re-sends
   * almost immediately, collects another 429, and turns a rate limit into a hot
   * loop. The reset hint is the number that reflects capacity actually
   * returning, so it wins and `Retry-After` is only a fallback.
   */
  retryAfterMs?: number;

  constructor(
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? true;
    this.retryAfterMs = opts.retryAfterMs;
  }

  /**
   * True when the provider refused because we asked too often — not because it
   * is broken.
   *
   * The distinction is load-bearing and cannot be recovered from the message
   * text. A rate limit is a fact about OUR request rate; an outage is a fact
   * about the provider. Recording the first as the second halts a session that
   * was working and blames the wrong component in the record.
   */
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * Parse a Go-style duration into milliseconds.
 *
 * Groq emits its rate-limit reset headers in this format: `46.755s`, `1m2.5s`,
 * `500ms`, `2m`. Returns null for anything not understood, so a change of format
 * on the provider's side degrades to "no hint" rather than to a wrong number
 * that would be slept on.
 */
export function parseDurationMs(raw: string | null): number | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s === '') return null;

  const asMs = s.match(/^(\d+(?:\.\d+)?)ms$/);
  if (asMs) return Number(asMs[1]);

  const compound = s.match(/^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!compound || (compound[1] === undefined && compound[2] === undefined)) return null;

  const ms = Number(compound[1] ?? 0) * 60_000 + Number(compound[2] ?? 0) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * How long a 429 asked us to wait, in milliseconds. Undefined when the provider
 * said nothing usable, in which case the caller backs off on its own schedule.
 *
 * Typed structurally rather than as `Headers` so this stays independent of which
 * fetch implementation's types are in scope.
 */
function rateLimitResetMs(headers: { get(name: string): string | null }): number | undefined {
  const fromBucket = parseDurationMs(headers.get('x-ratelimit-reset-tokens'));
  if (fromBucket !== null) return fromBucket;

  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; type?: string };
}

export async function chatCompletion(params: ChatParams): Promise<ChatResult> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${params.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user },
        ],
        temperature: params.temperature ?? 0.9,
        max_tokens: params.maxTokens ?? 800,
        response_format: { type: 'json_object' },
        ...(params.extraBody ?? {}),
      }),
      signal: controller.signal,
    });

    const raw = await res.text();

    if (!res.ok) {
      // 429 and 5xx are worth trying the next tier for; 401/400 are not — a bad
      // key or a bad request will fail identically on every provider.
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(
        `chat completion failed: HTTP ${res.status} ${raw.slice(0, 200)}`,
        {
          status: res.status,
          retryable,
          // Only a 429 carries a meaningful wait; for a 5xx there is nothing to
          // read and the caller's own schedule is the honest default.
          retryAfterMs: res.status === 429 ? rateLimitResetMs(res.headers) : undefined,
        },
      );
    }

    let body: ChatCompletionResponse;
    try {
      body = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      throw new ProviderError(`response was not JSON: ${raw.slice(0, 200)}`, {
        retryable: true,
      });
    }

    if (body.error) {
      throw new ProviderError(`provider error: ${body.error.message ?? 'unknown'}`, {
        retryable: true,
      });
    }

    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new ProviderError('response contained no message content', { retryable: true });
    }

    return { text, model: params.model };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError(`request timed out after ${timeoutMs}ms`, { retryable: true });
    }
    throw new ProviderError(
      `request failed: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the first JSON object out of a model reply.
 *
 * `response_format` usually makes this unnecessary, but a model that wraps its
 * JSON in a code fence or a sentence should cost one regex, not a lost
 * iteration. Returns null when there is no object to find.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to extraction
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
