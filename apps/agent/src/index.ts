/**
 * The HTTP surface: Express, the SSE stream, and the process lifecycle.
 *
 * Everything this file serves is a READ of session state that already exists, or
 * a CONTROL action an operator asked for. It computes no statistics of its own
 * and holds no second copy of anything — every number it returns was produced by
 * the loop, the gate, or the log, and is traceable back to a log entry. That is
 * the point: a reader must be able to check the UI's numbers against the
 * committed artifact, and they can only do that if the UI is not inventing any.
 *
 * Three decisions here are worth stating, because the obvious alternative is
 * wrong in each case.
 *
 * 1. ASYNC HANDLERS ARE WRAPPED. Express 4 does not catch a rejected promise
 *    from a handler. On Node 15+ that is an unhandled rejection, which by default
 *    terminates the process — so an unguarded `async` route means a single
 *    transient network error in one request kills a multi-hour research session.
 *    Every handler goes through `wrap()`.
 *
 * 2. ONE CONTROL ROUTE IS TOKEN-GATED, AND IT IS NOT THE INTERESTING ONE. The
 *    deployment is a public URL on the free tier. `POST /api/reset` clears a
 *    circuit-breaker trip — a decision about a session's future rather than an
 *    interaction with it — so it takes an `x-admin-token` header when
 *    `ADMIN_TOKEN` is set. `POST /api/start` and `/api/stop` are never gated: a
 *    judge pressing the button is the product being demonstrated, and trading
 *    that away to stop a stranger ending a session is a bad trade. The server
 *    says which routes are open at boot rather than leaving the exposure
 *    implicit.
 *
 * 3. REDACTION HAPPENS ON THE WAY OUT. `last_error` and stream events can carry
 *    provider error text, and this API is readable by anyone with the URL. Every
 *    string is passed through `redactSecrets` at the boundary — the one place
 *    that cannot be bypassed by a new call site forgetting to do it.
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';

import type { ApiError, ControlResponse, LogResponse, VerifyResponse } from './api/contract.js';
import { redactSecrets } from './api/redact.js';
import { verifyDecisionLog } from './log/verify.js';
import { SessionLoop, type SessionLoopOptions } from './session/loop.js';
import { SseHub } from './stream/sse.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env['PORT'] ?? 8080);

/**
 * Allowed browser origins for the frontend.
 *
 * An explicit allowlist rather than a reflected origin. `cors({origin: true})`
 * would let ANY website call this API from a visitor's browser, and two of these
 * routes change session state — a page the operator merely visited could stop
 * their session. A read-only API could get away with reflection; this one cannot.
 */
function allowedOrigins(): string[] {
  const raw = process.env['WEB_ORIGIN'] ?? '';
  const listed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Localhost is always permitted so the frontend can be developed against a
  // deployed backend. It is not a meaningful exposure: a request from a page
  // served on the operator's own machine is the operator.
  return [...listed, 'http://localhost:3000', 'http://127.0.0.1:3000'];
}

const ADMIN_TOKEN = (process.env['ADMIN_TOKEN'] ?? '').trim();

/**
 * The two control routes a VISITOR is allowed to use, and the one they are not.
 *
 * These were a single list behind a single token, which forced a bad choice:
 * either the token was unset and a stranger could end the session mid-demo, or
 * it was set and a judge could not start one. Both of those are wrong, because
 * the routes do not have the same owner.
 *
 * `/api/start` and `/api/stop` belong to whoever is using the product. A judge
 * deciding whether this thing works needs to press the button themselves —
 * watching a session someone else started is not the same evidence. Gating them
 * would trade the product's central demo, "here, try it", for protection against
 * a nuisance: the worst a stranger can do is stop a session, and the loop can be
 * started again.
 *
 * `/api/reset` belongs to the operator. It clears a circuit-breaker trip, which
 * is a decision about a session's future rather than an interaction with it, and
 * no visitor has a reason to reach for it. It is the one that would actually
 * ruin a demo, because a reset from a stranger is silent and the next judge sees
 * an empty product with no indication anything happened.
 *
 * So the token, when set, gates reset alone. Setting it no longer costs a judge
 * anything, which is what makes it safe to recommend setting it at all.
 */
const OPEN_CONTROL_ROUTES = ['/api/start', '/api/stop'] as const;
const ADMIN_CONTROL_ROUTES = ['/api/reset'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(res: Response, status: number, error: string, detail: string): void {
  const body: ApiError = { error, detail: redactSecrets(detail) };
  res.status(status).json(body);
}

/**
 * Wrap an async handler so a rejection becomes a 500 instead of killing the
 * process. See note 1 at the top of this file.
 */
function wrap(
  fn: (req: Request, res: Response) => Promise<void> | void,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out instanceof Promise) out.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

/** Parse `?limit=`, refusing nonsense with a 400 rather than coercing it. */
function parseLimit(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) return null;
  return n;
}

/**
 * Read an optional positive integer from the environment.
 *
 * Returns null when the variable is unset or blank, so the caller leaves the
 * corresponding option undefined and the module's own default stands — rather
 * than restating that default here, where it would silently drift out of step.
 *
 * A value that is present but not a positive integer is REPORTED rather than
 * swallowed. An iteration cap that quietly does nothing is worse than no cap:
 * the operator believes a bound is in force, and on a free tier that belief is
 * exactly what stops them watching the service.
 */
function intEnv(name: string): number | null {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    console.warn(`[api] ${name}="${raw}" is not a positive integer; ignoring it`);
    return null;
  }
  return n;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function createApp(loop: SessionLoop) {
  const app = express();
  const hub = new SseHub(loop.bus);

  app.disable('x-powered-by');
  app.use(
    cors({
      origin: allowedOrigins(),
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'x-admin-token'],
      maxAge: 600,
    }),
  );
  // A small limit on purpose: this instance has 512MB and no route accepts a
  // large body, so a big one is either a mistake or an attack.
  app.use(express.json({ limit: '32kb' }));

  // --- keep-warm ----------------------------------------------------------
  //
  // Render's free tier sleeps an idle service after ~15 minutes and then takes
  // 30-60s to wake. A cron ping here keeps the session's process alive. It
  // deliberately touches nothing — no config reload, no upstream call — so that
  // pinging it can neither fail nor perturb a running session.
  app.get(
    '/health',
    wrap((_req, res) => {
      res.json({ ok: true, phase: loop.currentPhase, uptime_s: Math.round(process.uptime()) });
    }),
  );

  // --- reads --------------------------------------------------------------

  app.get(
    '/api/status',
    wrap((_req, res) => {
      const status = loop.getStatus();
      // Redacted defensively even though the loop is not supposed to put
      // anything sensitive here: this value is provider error text, which is
      // arbitrary by nature, and it is served to any browser.
      res.json({ ...status, last_error: status.last_error === null ? null : redactSecrets(status.last_error) });
    }),
  );

  app.get(
    '/api/leaderboard',
    wrap((_req, res) => {
      res.json(loop.getLeaderboard());
    }),
  );

  app.get(
    '/api/log',
    wrap((req, res) => {
      const limit = parseLimit(req.query['limit'], 50, 500);
      if (limit === null) {
        return fail(res, 400, 'invalid_query', 'limit must be an integer between 1 and 500');
      }
      const beforeRaw = req.query['before'];
      if (beforeRaw !== undefined && typeof beforeRaw !== 'string') {
        return fail(res, 400, 'invalid_query', 'before must be a single entry_id string');
      }

      const page: LogResponse = loop.getLog({ limit, before: beforeRaw ?? null });
      // A cursor that matches nothing yields an empty page with a null cursor
      // rather than an error: it means the caller has paged past the end, which
      // is the expected end of iteration, not a fault.
      res.json(page);
    }),
  );

  // --- hash-chain verification -------------------------------------------
  //
  // Cached briefly. The verifier reads and SHA-256s the whole log, so an
  // unauthenticated endpoint that does that per request is a mild amplification
  // vector; ten seconds means a judge refreshing the page costs one hash, and
  // costs nothing in freshness because the log only grows during a session.
  const VERIFY_TTL_MS = 10_000;
  let verifyCache: { at: number; value: VerifyResponse } | null = null;

  app.get(
    '/api/log/verify',
    wrap((_req, res) => {
      const now = Date.now();
      if (verifyCache !== null && now - verifyCache.at < VERIFY_TTL_MS) {
        return void res.json(verifyCache.value);
      }

      const base = {
        log_path: loop.logPath,
        reproduce: 'npm run verify-log --workspace apps/agent',
      };

      let body: VerifyResponse;
      try {
        const result = verifyDecisionLog(loop.logPath);
        body = {
          ...base,
          ok: result.ok,
          entries_checked: result.entriesChecked,
          head_hash: result.headHash,
          // Redacted even though these are internally generated strings: they
          // quote log content, and the log can contain provider error text.
          failures: result.failures.map((f) => ({
            kind: f.kind,
            line: f.line,
            entry_id: f.entry_id,
            detail: redactSecrets(f.detail),
          })),
          unavailable_reason: null,
        };
      } catch (err) {
        // A missing log is a legitimate state — no session has written one yet —
        // and must not read as a verification failure. Reporting `ok: false`
        // with a reason keeps "nothing to check" distinct from "checked and
        // found broken", which is the distinction the whole endpoint rests on.
        //
        // The reason is written for a reader, not copied from the error. A raw
        // ENOENT string carries an absolute path (`C:\Users\...` in development,
        // `/opt/render/project/src/...` in production), which discloses the
        // deployment's filesystem layout and tells a sceptical reader nothing
        // about whether the chain is intact.
        const code = (err as { code?: unknown } | null)?.code;
        const reason =
          code === 'ENOENT'
            ? `no decision log at ${loop.logPath} yet — no session has recorded an entry`
            : 'the decision log exists but could not be read';
        console.error('[api] log verification could not read the log:', redactSecrets(String(err)));
        body = {
          ...base,
          ok: false,
          entries_checked: 0,
          head_hash: null,
          failures: [],
          unavailable_reason: reason,
        };
      }

      verifyCache = { at: now, value: body };
      res.json(body);
    }),
  );

  // --- stream -------------------------------------------------------------

  app.get(
    '/api/stream',
    wrap((_req, res) => {
      if (!hub.attach(res)) {
        return fail(
          res,
          503,
          'stream_capacity',
          `the stream is at capacity (${hub.clientCount} clients); retry shortly`,
        );
      }
      // `attach` owns the response from here: it has already written the headers
      // and closes itself on disconnect. Anything else done to `res` here would
      // truncate the feed.
    }),
  );

  // --- control ------------------------------------------------------------

  // `app.all` rather than `app.use`: `use` matches by PREFIX, so `/api/stopwatch`
  // would have been dragged through the token gate too. Harmless — it fails
  // closed — but it makes the 404 for an unrelated path depend on a credential.
  //
  // Only the operator's route is listed. `/api/start` and `/api/stop` are
  // deliberately absent: see OPEN_CONTROL_ROUTES for why a visitor keeping the
  // ability to drive the loop is worth more than the nuisance it permits.
  app.all([...ADMIN_CONTROL_ROUTES], (req, res, next) => {
    if (ADMIN_TOKEN === '') return next();
    const supplied = req.header('x-admin-token');
    // Constant-time comparison is not warranted here: the token does not protect
    // data, it guards against a stray request ending a session, and there is no
    // oracle to attack.
    if (supplied === ADMIN_TOKEN) return next();
    return fail(res, 401, 'unauthorized', 'this route requires a valid x-admin-token header');
  });

  app.post(
    '/api/start',
    wrap((_req, res) => {
      res.json(loop.start() satisfies ControlResponse);
    }),
  );

  app.post(
    '/api/stop',
    wrap((_req, res) => {
      res.json(loop.stop() satisfies ControlResponse);
    }),
  );

  app.post(
    '/api/reset',
    wrap((req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const requestedBy = body['requested_by'];
      // Required, not defaulted. The contract puts this field here so that
      // clearing a circuit-breaker trip is attributable to a person — a trip
      // means "a human decides what happens next", and defaulting the name to
      // "unknown" would quietly defeat the only thing this field is for.
      if (typeof requestedBy !== 'string' || requestedBy.trim() === '') {
        return fail(
          res,
          400,
          'invalid_body',
          'requested_by is required and must be a non-empty string: a circuit-breaker reset has to be attributable to a person',
        );
      }
      res.json(loop.reset(requestedBy.trim()) satisfies ControlResponse);
    }),
  );

  // --- fallthrough --------------------------------------------------------

  app.use((_req, res) => {
    fail(res, 404, 'not_found', 'no such route');
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    // Logged in full server-side, redacted on the wire.
    console.error('[api] unhandled route error:', message);
    if (res.headersSent) {
      res.end();
      return;
    }
    fail(res, 500, 'internal_error', message);
  });

  return { app, hub };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function main(): void {
  // Both bounds are optional and default to the loop's own values: an unset
  // maxIterations means "run until stopped", which is the intended behaviour of
  // an autonomous session. They are settable because a deployment on a free tier
  // wants a way to bound a run, and .env.example had been documenting these two
  // names since before anything read them.
  const loopOptions: SessionLoopOptions = {};
  const maxIterations = intEnv('MAX_LOOP_ITERATIONS_PER_RUN');
  const iterationDelayMs = intEnv('LOOP_ITERATION_DELAY_MS');
  if (maxIterations !== null) loopOptions.maxIterations = maxIterations;
  if (iterationDelayMs !== null) loopOptions.iterationDelayMs = iterationDelayMs;

  const loop = new SessionLoop(loopOptions);
  const { app, hub } = createApp(loop);

  const server = createServer(app);

  console.log(
    `[api] loop bounds: max_iterations=${maxIterations ?? 'unbounded'}, ` +
      `iteration_delay_ms=${iterationDelayMs ?? 'default'}`,
  );

  // Stated on every boot, not only when something is misconfigured. Which
  // routes a stranger can reach is the kind of thing that should be readable
  // from the logs of the process that is actually running, rather than
  // reconstructed from the source and an environment variable that may or may
  // not have been set in a dashboard. This is also what makes
  // OPEN_CONTROL_ROUTES load-bearing rather than a comment with a type.
  console.log(
    `[api] control routes: ${OPEN_CONTROL_ROUTES.join(', ')} are OPEN by design ` +
      '(a visitor drives the loop); ' +
      (ADMIN_TOKEN === ''
        ? `${ADMIN_CONTROL_ROUTES.join(', ')} is ALSO OPEN — ADMIN_TOKEN is not set`
        : `${ADMIN_CONTROL_ROUTES.join(', ')} requires x-admin-token`),
  );

  if (ADMIN_TOKEN === '') {
    console.warn(
      '[api] ADMIN_TOKEN is not set, so POST /api/reset is OPEN to anyone who can ' +
        'reach this URL. /api/start and /api/stop are open either way and that is ' +
        'deliberate — a visitor driving the loop is the product working. Reset is ' +
        'the operator\'s: set ADMIN_TOKEN before leaving this unattended, and note ' +
        'that doing so no longer takes the start button away from a judge.',
    );
  }

  /**
   * A rejected promise must not end the session.
   *
   * Every await in this process is a network call to a free public API that is
   * allowed to be slow or down. The loop already handles its own failures; this
   * is the backstop for anything that slips past, and it is a log rather than an
   * exit because a research session that has been running for hours is worth
   * more than the tidiness of failing fast.
   */
  process.on('unhandledRejection', (reason) => {
    console.error('[api] unhandled rejection:', redactSecrets(String(reason)));
  });

  /**
   * An uncaught exception is different: the process state is unknown, so it is
   * logged in full and then exited, letting the platform restart a clean one.
   * Continuing after one would risk a session that looks alive but is writing
   * nonsense — the failure mode this entire project exists to avoid.
   */
  process.on('uncaughtException', (err) => {
    console.error('[api] uncaught exception, exiting:', err);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down`);
    try {
      loop.stop(`process received ${signal}`);
    } catch (err) {
      console.error('[api] error stopping the loop:', err);
    }
    hub.closeAll();
    server.close(() => process.exit(0));
    // Render sends SIGTERM and then SIGKILLs shortly after. If a socket will not
    // close, exit anyway rather than being killed mid-write.
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, () => {
    console.log(`[api] factor-prover agent listening on :${PORT}`);
    console.log(`[api] session ${loop.sessionId}, phase ${loop.currentPhase}`);
  });
}

/**
 * Only boot when run directly. Importing this module — which the tests do, to
 * exercise `createApp` — must not open a port or install signal handlers.
 *
 * `pathToFileURL` rather than hand-building a `file://` string: on Windows
 * `process.argv[1]` is `C:\...`, and a naive concatenation produces
 * `file://C:\...`, which is not the URL `import.meta.url` holds.
 */
const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) main();
