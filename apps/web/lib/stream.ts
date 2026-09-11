'use client';

/**
 * The SSE feed.
 *
 * Three things here are deliberate:
 *
 *  1. HEARTBEATS ARE NOT EVENTS. Render's free tier sleeps an idle service and
 *     proxies drop silent connections, so the server sends periodic heartbeat
 *     frames. They keep the connection alive; they are not research. They update
 *     a liveness clock and never enter the feed, because a feed that fills with
 *     "heartbeat" lines is a feed nobody reads.
 *
 *  2. RECONNECTION IS OURS, NOT THE BROWSER'S. EventSource reconnects on its own
 *     with a fixed delay and no visibility, which is exactly wrong for a backend
 *     that cold-starts: we would not know whether the silence was a dead server
 *     or a sleeping one. Closing the socket and scheduling the retry here gives
 *     the UI an attempt count and a backoff it can show.
 *
 *  3. NAMED AND UNNAMED FRAMES. The contract does not say whether frames arrive
 *     as `data:` or `event: verdict`. All twelve event names are listened for,
 *     plus `message`, so neither choice by the server half silently produces an
 *     empty feed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from './api';
import type {
  DecisionMetrics,
  DecisionRow,
  StreamEventRead,
  StreamEventType,
} from './types';

/** Every type in the contract, so a server that names its frames still works. */
export const STREAM_EVENT_TYPES: readonly StreamEventType[] = [
  'session_started',
  'hypothesis_proposed',
  'backtest_completed',
  'verdict',
  'promotion',
  'paper_order',
  'circuit_break',
  'circuit_reset',
  'tier_failure',
  'session_stopped',
  'error',
  'heartbeat',
] as const;

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'unreachable';

/** After this many consecutive failures the UI stops saying "reconnecting". */
const UNREACHABLE_AFTER_ATTEMPTS = 6;
/** Feed length. Enough for a demo session's worth of visible history. */
const FEED_CAP = 120;

export interface StreamFeed {
  status: StreamStatus;
  /** Newest first. Heartbeats are never in here. */
  events: StreamEventRead[];
  attempts: number;
  /**
   * Monotonic count of non-heartbeat frames received. The run view passes it to
   * useResource as `reloadOn`, so one verdict refreshes the status, the log and
   * the leaderboard without the view needing to know which endpoint a given
   * event changes. A count rather than a timestamp because two frames can share
   * a timestamp, and a key that fails to change is a view that fails to refresh.
   */
  revision: number;
  lastEventAt: string | null;
  lastHeartbeatAt: string | null;
  /** Attempt a connection now instead of waiting out the backoff. */
  reconnectNow: () => void;
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, 8s, then a steady 15s. A cold start needs the early attempts to
  // be close together (the socket is refused while the service boots) and a
  // long outage needs them to be cheap.
  return Math.min(1000 * 2 ** attempt, 15_000);
}

export function useStream(enabled = true): StreamFeed {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [events, setEvents] = useState<StreamEventRead[]>([]);
  const [attempts, setAttempts] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [nonce, setNonce] = useState(0);

  const sourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  const reconnectNow = useCallback(() => {
    attemptRef.current = 0;
    setAttempts(0);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

    let disposed = false;

    const open = () => {
      if (disposed) return;
      const source = new EventSource(`${API_BASE_URL}/api/stream`);
      sourceRef.current = source;

      const handle = (raw: MessageEvent) => {
        let parsed: StreamEventRead;
        try {
          parsed = JSON.parse(raw.data as string) as StreamEventRead;
        } catch {
          // A frame we cannot parse is not research either. Keep the connection.
          return;
        }
        if (!parsed || typeof parsed.type !== 'string') return;

        if (parsed.type === 'heartbeat') {
          setLastHeartbeatAt(new Date().toISOString());
          return;
        }

        setLastEventAt(new Date().toISOString());
        setRevision((count) => count + 1);
        setEvents((previous) => [parsed, ...previous].slice(0, FEED_CAP));
      };

      source.onopen = () => {
        attemptRef.current = 0;
        setAttempts(0);
        setStatus('live');
      };

      source.onmessage = handle as (event: MessageEvent) => void;
      // Every name, heartbeat included. Skipping heartbeat here would have been
      // the one hole in the rule this file is written around: a server that
      // frames its keep-alives as `event: heartbeat` never reaches `onmessage`,
      // so `lastHeartbeatAt` would stay null forever and the feed's own
      // liveness line could never say the socket was alive. `handle` returns
      // before a heartbeat can enter the feed either way, so registering it
      // costs nothing and closes the gap.
      for (const type of STREAM_EVENT_TYPES) {
        source.addEventListener(type, handle as EventListener);
      }

      source.onerror = () => {
        if (disposed) return;
        source.close();
        sourceRef.current = null;
        const attempt = attemptRef.current;
        attemptRef.current = attempt + 1;
        setAttempts(attempt + 1);
        setStatus(attempt + 1 >= UNREACHABLE_AFTER_ATTEMPTS ? 'unreachable' : 'reconnecting');
        timerRef.current = setTimeout(open, backoffMs(attempt));
      };
    };

    setStatus('connecting');
    open();

    return () => {
      disposed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [enabled, nonce]);

  return { status, events, attempts, revision, lastEventAt, lastHeartbeatAt, reconnectNow };
}

/** The most recent event carrying a decided row — the live verdict. */
export function latestDecidedEvent(events: StreamEventRead[]): StreamEventRead | null {
  return events.find((event) => event.entry !== undefined) ?? null;
}

/** The most recent event that named a hypothesis, decided or not. */
export function latestHypothesisEvent(events: StreamEventRead[]): StreamEventRead | null {
  return events.find((event) => event.entry?.hypothesis || event.hypothesis) ?? null;
}

/** What the hypothesis panel should show right now. */
export interface CurrentHypothesis {
  hypothesis: StreamEventRead['hypothesis'] | DecisionRow['hypothesis'];
  hypothesisId: string | null;
  generator: string | null;
  metrics: Partial<DecisionMetrics> | null;
  /** Non-null once a verdict exists — which is what makes the stamp appear. */
  entry: DecisionRow | null;
}

const EMPTY_CURRENT: CurrentHypothesis = {
  hypothesis: null,
  hypothesisId: null,
  generator: null,
  metrics: null,
  entry: null,
};

function fromEntry(entry: DecisionRow): CurrentHypothesis {
  return {
    hypothesis: entry.hypothesis,
    hypothesisId: entry.hypothesis_id,
    generator: entry.generator,
    metrics: entry.metrics,
    entry,
  };
}

/**
 * The newest thing that happened to a hypothesis, from the stream first and the
 * log second.
 *
 * The fallback matters more than it looks. The contract lets
 * `hypothesis_proposed` and `backtest_completed` carry nothing but a message, so
 * a reader who loads the page mid-session has no stream history to read a
 * hypothesis from. Falling back to the newest log row means the last verdict —
 * which is the whole point of the screen — is on screen within a second of load
 * rather than only after the next hypothesis is proposed.
 */
export function deriveCurrent(
  events: StreamEventRead[],
  rows: DecisionRow[],
): CurrentHypothesis {
  const named = events.find((event) => event.entry || event.hypothesis);
  if (named) {
    if (named.entry) return fromEntry(named.entry);
    return {
      hypothesis: named.hypothesis ?? null,
      hypothesisId: named.hypothesis_id ?? null,
      generator: null,
      metrics: named.metrics ?? null,
      entry: null,
    };
  }
  const newestRow = rows[0];
  if (newestRow) return fromEntry(newestRow);
  return EMPTY_CURRENT;
}
