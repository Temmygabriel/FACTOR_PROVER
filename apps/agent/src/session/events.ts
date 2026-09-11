/**
 * The session event bus.
 *
 * One producer (the session loop), many consumers (the SSE endpoint, and
 * through it every browser watching the run). Kept deliberately dumb: it fans
 * out `StreamEvent`s and remembers the recent ones.
 *
 * WHY IT REMEMBERS. Render's free tier sleeps an idle service and proxies drop
 * silent connections; a browser that opens the page thirty seconds into a run
 * would otherwise see a feed that starts mid-sentence, with no session_started
 * and no context for the verdicts scrolling past. Replaying the last N events
 * on subscribe means a late joiner sees the same run the earlier ones did.
 *
 * The replay is BOUNDED, and that is a deliberate limitation rather than an
 * oversight: an unbounded history would let a long-running session hold every
 * event in memory forever, and this service is deployed on a 512MB free tier.
 * A consumer that needs the complete record reads the decision log, which is
 * the durable artifact — the bus is a live feed, not a second source of truth.
 */

import type { StreamEvent, StreamEventType } from '../api/contract.js';

export type StreamListener = (event: StreamEvent) => void;

/** How many recent events a new subscriber is caught up with. */
const DEFAULT_REPLAY_LIMIT = 250;

export class SessionEventBus {
  private readonly listeners = new Set<StreamListener>();
  private history: StreamEvent[] = [];
  private readonly replayLimit: number;
  private seq = 0;

  constructor(replayLimit: number = DEFAULT_REPLAY_LIMIT) {
    this.replayLimit = replayLimit;
  }

  /**
   * Publish an event.
   *
   * A listener that throws must not take down the loop that emitted — the loop
   * is doing the real work and a broken SSE client is not a reason to stop a
   * research session. Failures are swallowed here and the offending listener is
   * dropped, since a listener that throws once will throw on every subsequent
   * event and would otherwise spam.
   */
  emit(type: StreamEventType, message: string, extra: Partial<StreamEvent> = {}): StreamEvent {
    const event: StreamEvent = {
      type,
      at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      message,
      ...extra,
    };

    this.seq += 1;
    this.history.push(event);
    if (this.history.length > this.replayLimit) {
      this.history.splice(0, this.history.length - this.replayLimit);
    }

    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch {
        this.listeners.delete(fn);
      }
    }
    return event;
  }

  /**
   * Subscribe, catching up on recent events first.
   *
   * Replay happens BEFORE the listener is registered, so an event emitted
   * during the replay cannot arrive twice or be interleaved out of order.
   * Returns an unsubscribe function; the SSE endpoint calls it on disconnect,
   * which matters because a leaked listener holds a reference to a dead socket.
   */
  subscribe(fn: StreamListener, opts: { replay?: boolean } = {}): () => void {
    if (opts.replay !== false) {
      for (const e of [...this.history]) {
        try {
          fn(e);
        } catch {
          return () => {};
        }
      }
    }
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** Recent events, oldest first. For tests and for a resuming client. */
  get recent(): readonly StreamEvent[] {
    return [...this.history];
  }

  /** Monotonic count of events published. Useful for "is anything happening?". */
  get emittedCount(): number {
    return this.seq;
  }
}
