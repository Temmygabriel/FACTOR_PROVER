/**
 * The state a reader sees when there is no reading to show.
 *
 * Two rules from spec §9 govern every sentence here:
 *
 *  "Never: 'Something went wrong.' Always: what failed and what was not
 *   affected." — so each variant names the endpoint, the status if there was
 *   one, and then says explicitly that nothing on the screen is a stale value
 *   dressed as a live one.
 *
 *  A cold start is not an outage. The agent runs on Render's free tier and
 *  sleeps when idle; ~50 seconds of silence on the first request of a session is
 *  normal behaviour, and rendering it as a failure would teach a reader to
 *  distrust a system that is working. So `waking` is its own state with its own
 *  copy, and it is shown BEFORE any failure is known.
 *
 * There is no red here. Red is spent on the KILLED verdict and the circuit-break
 * state (spec §7, §8); an unreachable backend is not a verdict, and borrowing the
 * colour would make the two mean less.
 */

import { API_BASE_URL, type ApiFailure } from '@/lib/api';
import { fmtIsoExact } from '@/lib/format';
import { Button } from './Button';

export interface BackendNoticeProps {
  /** The read this describes, for the waking state, e.g. "GET /api/status". */
  endpoint: string;
  /** What the reader is not being shown, e.g. "the decision log". */
  subject: string;
  failure: ApiFailure | null;
  /** A request has been outstanding long enough that a cold start is likely. */
  waking: boolean;
  /** Failed connection attempts so far, for the stream. */
  attempts?: number;
  onRetry?: () => void;
}

export function BackendNotice({
  endpoint,
  subject,
  failure,
  waking,
  attempts,
  onRetry,
}: BackendNoticeProps) {
  return (
    <div className="border border-rule bg-surface px-4 py-3">
      {waking && !failure ? (
        <>
          <p className="text-heading font-semibold text-ink">Waking the backend.</p>
          <p className="mt-1 max-w-[80ch] text-label text-ink-light">
            {endpoint} has not answered yet. The agent runs on Render&rsquo;s free tier, which
            sleeps when idle; a cold start takes about 50 seconds. This is a wait, not an
            error — the page fills in on its own.
          </p>
          <p className="mt-2 font-mono text-caption text-ink-light">
            waiting on {API_BASE_URL}
            {attempts && attempts > 0 ? ` · attempts ${attempts}` : ''}
          </p>
        </>
      ) : failure ? (
        <>
          {/*
            The headline is composed by ApiFailure, which knows the method, the
            path and the status — "GET /api/leaderboard returned HTTP 503". The
            spec's error copy names exactly those three things.
          */}
          <p className="text-heading font-semibold text-ink">{failure.headline}.</p>
          <p className="mt-1 max-w-[80ch] text-label text-ink-light">
            {failure.kind === 'timeout'
              ? `No answer within ${Math.round(
                  failure.elapsed_ms / 1000,
                )}s. A cold start takes about 50 seconds, so the service may still be
                starting. Retry, or wait — the page retries on its own.`
              : failure.kind === 'unreachable'
                ? `Nothing answered at ${API_BASE_URL}. Check that the agent is running and that NEXT_PUBLIC_API_BASE_URL points at it.`
                : failure.detail}
          </p>
          <p className="mt-2 max-w-[80ch] text-label text-ink">
            {subject} is not shown, because there is no reading to show. Nothing on this
            screen is a cached or estimated value.
          </p>
          {onRetry ? (
            <div className="mt-3">
              <Button onClick={onRetry}>Retry now</Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * The strip shown when a poll failed but an earlier reading is still on screen.
 * Says how old the reading is rather than quietly presenting it as current —
 * every number here is supposed to be traceable, and an undated number is not.
 */
export function StaleNotice({
  failure,
  readAt,
  onRetry,
}: {
  failure: ApiFailure | null;
  readAt: string | null;
  onRetry: () => void;
}) {
  if (!failure || failure.kind === 'aborted') return null;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border border-rule bg-surface px-3 py-2">
      <p className="text-caption text-ink-light">
        Showing the last reading
        {readAt ? ` from ${fmtIsoExact(readAt)}` : ''} — {failure.headline.toLowerCase()}.
        Live updates are stopped until it answers.
      </p>
      <Button onClick={onRetry}>Retry</Button>
    </div>
  );
}
