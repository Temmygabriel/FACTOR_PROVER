/**
 * Secret redaction at the HTTP boundary.
 *
 * This is a SECOND line of defence, not the first. The first is that secrets are
 * never put anywhere they could be echoed: the Gemini client sends its key in
 * `x-goog-api-key` rather than a `?key=` query parameter, precisely so the secret
 * never lands in a URL. `provider.ts` already redacts configured key values out
 * of failure messages before they reach the decision log, because that log is a
 * committed public artifact.
 *
 * This module exists because the live API has a wider blast radius than the log.
 * `last_error` is served from `/api/status` to any browser, and `/api/stream`
 * pushes error events to every connected client. A key that leaked into an error
 * string would be readable by anyone who opened the page — and unlike a leaked
 * log line, it could not be un-published. So every string the server sends is
 * passed through here on the way out.
 *
 * Two passes, for two different failure modes:
 *
 *   1. EXACT VALUES, from the configured keys. This is the reliable pass: it
 *      catches a key regardless of how it was mangled into the message.
 *   2. SHAPE PATTERNS, for keys this process does not know about. If a provider
 *      echoes a credential that was never in our configuration — a proxy's token,
 *      a key belonging to a different service — pass 1 cannot see it. Pass 2 is
 *      deliberately narrow: it matches the documented prefixes and the
 *      query-parameter and Authorization shapes, and nothing looser, because an
 *      over-broad pattern would start mangling legitimate diagnostic text such as
 *      a hypothesis id or a hash.
 */

import { loadGeneratorConfig } from '../llm/provider.js';

/** Cached because env is fixed for the life of a server process. */
let cachedSecrets: string[] | null = null;

function secrets(): string[] {
  if (cachedSecrets !== null) return cachedSecrets;
  let out: string[] = [];
  try {
    const cfg = loadGeneratorConfig();
    out = [cfg.groqApiKey, cfg.geminiApiKey, cfg.openaiApiKey].filter(
      (k): k is string => typeof k === 'string' && k.length >= 8,
    );
  } catch {
    // A config error must never be the reason redaction is skipped. Passing
    // through with pass 2 alone is strictly better than throwing here, because
    // throwing would mean the caller renders the unredacted string instead.
    out = [];
  }
  cachedSecrets = out;
  return out;
}

/** Test seam: env can change between tests in one process. */
export function __resetRedactionCacheForTest(): void {
  cachedSecrets = null;
}

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Credentials in query strings: ?key=..., &api_key=..., &access_token=...
  [/([?&](?:key|api_key|apikey|access_token|auth_token|token)=)[^&\s"'<>]+/gi, '$1[redacted]'],
  // Authorization headers, in either the raw or the serialised form.
  [/(\b(?:authorization|proxy-authorization)\b["'\s:=]+(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
   '$1[redacted]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // Documented key prefixes. Kept tight on purpose — see the file comment.
  [/\b(?:gsk_|sk-|sk_|xai-|AIza)[A-Za-z0-9_-]{10,}/g, '[redacted]'],
];

/**
 * Redact secrets from a string bound for a client.
 *
 * Non-strings and empty strings pass through unchanged so callers can apply this
 * unconditionally without a null check at every call site.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const secret of secrets()) out = out.split(secret).join('[redacted]');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
