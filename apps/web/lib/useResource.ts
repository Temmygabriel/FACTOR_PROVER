'use client';

/**
 * One read of one endpoint, with the three states this product cares about kept
 * apart on purpose:
 *
 *   loading  — a request is outstanding.
 *   waking   — it has been outstanding long enough that a sleeping Render
 *              service is the likely explanation. This is NOT an error, and the
 *              UI must not treat it as one: a cold start is ~50s of normal
 *              behaviour, and showing a red failure for it would teach a reader
 *              to distrust a working system.
 *   failure  — the request ended without a body. The previously-read value, if
 *              any, stays on screen but is marked stale rather than being
 *              silently presented as current. A stale number shown as live is
 *              the one failure this dashboard cannot afford, because every
 *              number here is supposed to be traceable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure } from './api';

/**
 * How long a request may be outstanding before the UI mentions a cold start.
 * Chosen against the measured behaviour (~50s) rather than as a timeout: this
 * only decides when to explain the wait, never when to give up.
 */
const WAKING_AFTER_MS = 2500;

export interface Resource<T> {
  data: T | null;
  failure: ApiFailure | null;
  loading: boolean;
  /** A request has been outstanding long enough that a cold start is likely. */
  waking: boolean;
  /** The last attempt failed but an earlier reading is still displayed. */
  stale: boolean;
  /** When the displayed reading was read, ISO. Null while nothing has arrived. */
  readAt: string | null;
  reload: () => void;
}

export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: {
    /** Poll period. 0 disables polling. */
    intervalMs?: number;
    /** Change this to force an immediate reload (e.g. a stream event arrived). */
    reloadOn?: string | number | null;
  } = {},
): Resource<T> {
  const { intervalMs = 0, reloadOn = null } = options;

  const [data, setData] = useState<T | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [waking, setWaking] = useState(false);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // The fetcher is usually an inline arrow, so its identity changes every
  // render. Holding it in a ref keeps the effect keyed on the nonce and the
  // caller's reload trigger instead of re-firing on every parent render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;

    setLoading(true);
    const wakeTimer = setTimeout(() => {
      if (mounted) setWaking(true);
    }, WAKING_AFTER_MS);

    fetcherRef
      .current(controller.signal)
      .then((value) => {
        if (!mounted) return;
        setData(value);
        setFailure(null);
        setReadAt(new Date().toISOString());
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        if (error instanceof ApiFailure && error.kind === 'aborted') return;
        setFailure(
          error instanceof ApiFailure
            ? error
            : new ApiFailure({
                kind: 'unreachable',
                method: 'GET',
                path: 'the request',
                status: null,
                detail: error instanceof Error ? error.message : 'the request failed',
                elapsed_ms: 0,
              }),
        );
      })
      .finally(() => {
        if (!mounted) return;
        clearTimeout(wakeTimer);
        setWaking(false);
        setLoading(false);
      });

    return () => {
      mounted = false;
      clearTimeout(wakeTimer);
      controller.abort();
    };
  }, [nonce, reloadOn]);

  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = setInterval(reload, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, reload]);

  return {
    data,
    failure,
    loading,
    waking,
    stale: failure !== null && data !== null,
    readAt,
    reload,
  };
}

/**
 * A clock for relative timestamps ("2 min ago").
 *
 * Rows are dated against one instant per render pass rather than each calling
 * `Date.now()` as it renders, so two rows in the same table cannot disagree
 * about how long ago something was. The tick keeps the values from going stale
 * while a page sits idle.
 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
