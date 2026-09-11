/**
 * Server-Sent Events transport for the live session feed.
 *
 * One long-lived HTTP response per browser, fanned out from the session event
 * bus. Three things about the deployment shape this file, and all three are
 * reasons the obvious implementation is wrong:
 *
 *  1. RENDER'S FREE TIER SLEEPS IDLE SERVICES, and the proxies in front of it
 *     drop connections that go quiet. A session can legitimately produce nothing
 *     for a minute while a backtest runs, so silence is not evidence of a dead
 *     client. A keep-alive frame is therefore mandatory, not a nicety.
 *
 *  2. THE INSTANCE HAS 512MB. Every connected client is a held-open socket plus
 *     a listener closure plus 250 replayed events. Unbounded, a public URL with
 *     a crawler problem exhausts memory and takes the session down with it. The
 *     client count is capped and the cap is reported, so the refusal is visible
 *     rather than a mystery hang.
 *
 *  3. THE CONNECTION WILL DROP. Mobile networks, laptop lids, and free-tier
 *     restarts all close it. A client that reconnects gets the bus's bounded
 *     replay, so it resumes with context instead of starting mid-sentence.
 *
 * WHY THE KEEP-ALIVE IS A REAL EVENT AND NOT AN SSE COMMENT.
 * An SSE comment (`: ping`) is the cheaper idiom and it is what the contract's
 * comment section originally suggested. It was rejected because the frontend
 * switches on the event `type` and shows the reader how fresh the feed is; a
 * client that has received nothing but comments cannot distinguish "the session
 * is thinking" from "the socket is dead but not yet closed", which is exactly the
 * ambiguity a live feed must not have. So heartbeats are emitted as `heartbeat`
 * events, which the contract already declares.
 *
 * They are emitted to connected sockets ONLY and never enter the bus history.
 * A heartbeat is a property of the connection, not an event in the session, and
 * letting them into the bounded replay would evict real verdicts from the window
 * a reconnecting client needs.
 */

import type { Response } from 'express';
import type { StreamEvent } from '../api/contract.js';
import { redactSecrets } from '../api/redact.js';
import type { SessionEventBus } from '../session/events.js';

/** Cadence of the keep-alive. Comfortably under any proxy's idle timeout. */
const HEARTBEAT_MS = 15_000;

/**
 * Concurrent stream clients.
 *
 * Sized for the audience this actually has — a hackathon judge opening the page,
 * plus a few — not for a public broadcast. The cost of being wrong in the low
 * direction is a clear 503; the cost of being wrong in the high direction is an
 * out-of-memory kill that ends the research session.
 */
const MAX_CLIENTS = 50;

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * One SSE frame. `JSON.stringify` escapes newlines, so `data` stays one line.
 *
 * Redaction is applied to the SERIALISED form rather than to named fields. That
 * is deliberate: it means the pass covers every field the event carries, now and
 * in future, without anyone having to remember to add a new field to a list here.
 * The substitution is exact-string, and API keys are alphanumeric, so JSON
 * escaping cannot alter the characters a key is matched on.
 */
function frame(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${redactSecrets(JSON.stringify(event))}\n\n`;
}

export class SseHub {
  private readonly bus: SessionEventBus;
  private readonly clients = new Set<Response>();
  private readonly maxClients: number;

  constructor(bus: SessionEventBus, opts: { maxClients?: number } = {}) {
    this.bus = bus;
    this.maxClients = opts.maxClients ?? MAX_CLIENTS;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get atCapacity(): boolean {
    return this.clients.size >= this.maxClients;
  }

  /**
   * Attach a new SSE client.
   *
   * Returns `false` when at capacity, WITHOUT having written anything, so the
   * route can answer with a proper `503` and the `ApiError` shape. Accepting the
   * connection and then closing it would look to the browser like a backend
   * crash rather than a stated limit.
   */
  attach(res: Response): boolean {
    if (this.atCapacity) return false;

    let closed = false;
    // Declared before `detach` because `detach` closes over them, and `detach`
    // can run during the REPLAY below — which happens before either exists. As
    // `const`s they would be in the temporal dead zone at that moment, so a write
    // failure while catching a client up would raise a ReferenceError from inside
    // the error path instead of cleanly detaching. `send` builds the frame inside
    // its `try`, so this is reachable through a throw from `JSON.stringify` or
    // from redaction, not only from a failed write.
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: () => void = () => {};

    const detach = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      this.clients.delete(res);
      unsubscribe();
    };

    /**
     * A dead socket does not raise on write in Node — it returns false or throws
     * asynchronously. Treated as a detach trigger either way, because a write
     * that fails means there is nobody left to receive the feed.
     */
    const send = (event: StreamEvent): void => {
      if (closed) return;
      try {
        res.write(frame(event));
      } catch {
        detach();
      }
    };

    try {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Tells nginx-likes not to buffer: buffering defeats streaming entirely and
      // presents as "the feed arrives in one lump when the response ends".
      res.setHeader('X-Accel-Buffering', 'no');
      // Long enough that a reconnect does not storm, short enough that a phone
      // coming back from sleep recovers promptly.
      res.write('retry: 3000\n\n');
      res.flushHeaders?.();
    } catch {
      // The socket died between the capacity check and here, so there is nobody
      // to tell. This must not propagate: the route would try to answer a
      // half-written SSE response with a JSON error, and a client that
      // disconnected during a page navigation would leave a 500 in the log.
      //
      // Returns `true` rather than `false` because the response is OURS from
      // here — `false` means "at capacity, send a 503", which is a different
      // thing entirely and would be a lie about why the stream is not available.
      detach();
      try {
        res.end();
      } catch {
        // Already gone.
      }
      return true;
    }

    this.clients.add(res);

    unsubscribe = this.bus.subscribe(send);

    // Started AFTER the replay, so a client that has just been caught up does
    // not immediately receive a heartbeat saying nothing has happened.
    heartbeat = setInterval(() => {
      send({ type: 'heartbeat', at: isoNow(), message: 'keep-alive' });
    }, HEARTBEAT_MS);
    // Does not hold the event loop open: a session that finishes should let the
    // process exit rather than being pinned by 50 idle sockets.
    heartbeat.unref?.();

    // `close` fires for both a client disconnect and a server-side end.
    res.on('close', detach);
    res.on('error', detach);
    return true;
  }

  /** Detach every client. Used on shutdown so sockets close cleanly. */
  closeAll(): void {
    for (const res of [...this.clients]) {
      try {
        res.end();
      } catch {
        // Already gone; the `close` handler has removed it.
      }
      this.clients.delete(res);
    }
  }
}
