/**
 * Transport to the agent API.
 *
 * Two properties matter more than convenience here:
 *
 *  1. A FAILURE MUST BE DESCRIBABLE. The design spec's error copy is "[Endpoint]
 *     returned [HTTP status]", and "never 'Something went wrong'". So every
 *     failure is an ApiFailure carrying the method, the path, the status if
 *     there was one, and how long it took — enough for the UI to say what
 *     failed and what was NOT affected. A bare `catch (e)` would lose all of it.
 *
 *  2. A SLOW REQUEST IS NOT A BROKEN ONE. The agent runs on Render's free tier,
 *     which sleeps when idle: a cold start is ~50s. The read timeout is
 *     therefore 75s, well past a cold start, and callers distinguish "still
 *     waiting" from "gave up" (see useResource). A 5s timeout would have made
 *     every cold start look like an outage and taught a reader to distrust a
 *     working system.
 */

import type {
  ControlResponse,
  LeaderboardResponse,
  LogResponse,
  StatusResponse,
  VerifyResponse,
} from './types';

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8080'
).replace(/\/+$/, '');

export type FailureKind =
  /** fetch rejected — DNS, refused connection, CORS, offline. No status. */
  | 'unreachable'
  /** We gave up waiting. The likeliest cause by far is a Render cold start. */
  | 'timeout'
  /** The server answered, not with 2xx. */
  | 'http'
  /** The server answered 2xx with something that is not the contract. */
  | 'malformed'
  /** The caller aborted (unmount, superseding request). Not an error state. */
  | 'aborted';

export class ApiFailure extends Error {
  readonly kind: FailureKind;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly detail: string;
  readonly elapsed_ms: number;

  constructor(init: {
    kind: FailureKind;
    method: string;
    path: string;
    status: number | null;
    detail: string;
    elapsed_ms: number;
  }) {
    super(init.detail);
    this.name = 'ApiFailure';
    this.kind = init.kind;
    this.method = init.method;
    this.path = init.path;
    this.status = init.status;
    this.detail = init.detail;
    this.elapsed_ms = init.elapsed_ms;
  }

  /** "GET /api/status returned HTTP 503" — the spec's error copy, composed once. */
  get headline(): string {
    if (this.kind === 'http' && this.status !== null) {
      return `${this.method} ${this.path} returned HTTP ${this.status}`;
    }
    if (this.kind === 'timeout') {
      return `${this.method} ${this.path} did not answer within ${Math.round(
        this.elapsed_ms / 1000,
      )}s`;
    }
    if (this.kind === 'malformed') {
      return `${this.method} ${this.path} answered with a body outside the contract`;
    }
    return `${this.method} ${this.path} could not be reached`;
  }
}

const READ_TIMEOUT_MS = 75_000;

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, timeoutMs = READ_TIMEOUT_MS } = options;
  const started = Date.now();

  // Our own timeout is distinguishable from the caller's abort: if we aborted,
  // it is a timeout (worth reporting); if the caller did, it is a cleanup.
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      // The contract promises { error, detail } on every non-2xx. Read it, but
      // never let a broken error body replace the status code we do know.
      let detail = `HTTP ${response.status}`;
      try {
        const parsed = (await response.json()) as { error?: string; detail?: string };
        detail = [parsed.error, parsed.detail].filter(Boolean).join(' — ') || detail;
      } catch {
        /* body was not JSON; the status line is still the truth */
      }
      throw new ApiFailure({
        kind: 'http',
        method,
        path,
        status: response.status,
        detail,
        elapsed_ms: Date.now() - started,
      });
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiFailure({
        kind: 'malformed',
        method,
        path,
        status: response.status,
        detail: 'the response was not JSON',
        elapsed_ms: Date.now() - started,
      });
    }
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    if (signal?.aborted && !timedOut) {
      throw new ApiFailure({
        kind: 'aborted',
        method,
        path,
        status: null,
        detail: 'aborted by the caller',
        elapsed_ms: Date.now() - started,
      });
    }
    if (timedOut) {
      throw new ApiFailure({
        kind: 'timeout',
        method,
        path,
        status: null,
        detail: `no response after ${Math.round((Date.now() - started) / 1000)}s`,
        elapsed_ms: Date.now() - started,
      });
    }
    throw new ApiFailure({
      kind: 'unreachable',
      method,
      path,
      status: null,
      detail: error instanceof Error ? error.message : 'the request failed',
      elapsed_ms: Date.now() - started,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

export const getStatus = (signal?: AbortSignal) =>
  request<StatusResponse>('/api/status', { signal });

export const getLeaderboard = (signal?: AbortSignal) =>
  request<LeaderboardResponse>('/api/leaderboard', { signal });

/** Newest first. `before` is the previous response's `next_cursor`. */
export const getLog = (
  params: { limit?: number; before?: string | null } = {},
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.before) query.set('before', params.before);
  const suffix = query.toString();
  return request<LogResponse>(`/api/log${suffix ? `?${suffix}` : ''}`, { signal });
};

export const verifyChain = (signal?: AbortSignal) =>
  request<VerifyResponse>('/api/log/verify', { signal });

/**
 * The one write this app performs. `requested_by` is required by the contract
 * because a resume after a circuit break is a deliberate human act and the log
 * has to name the human — so the UI cannot send it anonymously.
 */
export const postReset = (requestedBy: string, signal?: AbortSignal) =>
  request<ControlResponse>('/api/reset', {
    method: 'POST',
    body: { requested_by: requestedBy },
    signal,
    // A control call is interactive: the operator is watching, so a 75s hang
    // would be worse than an error they can retry.
    timeoutMs: 20_000,
  });

export const postPause = (signal?: AbortSignal) =>
  request<ControlResponse>('/api/stop', { method: 'POST', signal, timeoutMs: 20_000 });

export const postResume = (signal?: AbortSignal) =>
  request<ControlResponse>('/api/start', { method: 'POST', signal, timeoutMs: 20_000 });

/** True when the failure is a cleanup rather than a state worth rendering. */
export const isAborted = (failure: ApiFailure | null): boolean =>
  failure?.kind === 'aborted';
