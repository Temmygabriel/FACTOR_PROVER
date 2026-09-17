'use client';

/**
 * The live event feed beside the loop.
 *
 * Heartbeats are filtered here as well as in the hook. The server sends them to
 * keep a sleeping proxy from dropping the connection, and a feed that filled
 * with them would be a feed nobody reads; filtering at the renderer as well as
 * the source means the invariant holds even if a frame arrives by another route.
 *
 * The connection line reports the reconnection state and the attempt count,
 * because a reader watching a silent screen needs to know whether the loop is
 * quiet or the socket is down. Those look identical otherwise.
 */

import { fmtClockUtc, fmtIsoExact, truncHash } from '@/lib/format';
import { killReasonPlain, killReasonTag } from '@/lib/copy';
import type { StreamEventRead } from '@/lib/types';
import type { StreamStatus } from '@/lib/stream';
import { verdictForDecision } from '@/lib/verdict';
import { Button } from './Button';
import { Panel } from './Panel';
import { VerdictStamp } from './VerdictStamp';

export interface LiveFeedProps {
  status: StreamStatus;
  events: StreamEventRead[];
  attempts: number;
  lastEventAt: string | null;
  lastHeartbeatAt: string | null;
  onReconnect: () => void;
}

function connectionLine(
  status: StreamStatus,
  attempts: number,
  lastHeartbeatAt: string | null,
): string {
  switch (status) {
    case 'live':
      return lastHeartbeatAt
        ? `live · last keep-alive ${fmtClockUtc(lastHeartbeatAt)}`
        : 'live';
    case 'connecting':
      return 'connecting — a cold start takes about 50 seconds';
    case 'reconnecting':
      return `reconnecting · attempt ${attempts}`;
    case 'unreachable':
      return `not connected · ${attempts} attempts failed`;
  }
}

export function LiveFeed({
  status,
  events,
  attempts,
  lastEventAt,
  lastHeartbeatAt,
  onReconnect,
}: LiveFeedProps) {
  const visible = events.filter((event) => event.type !== 'heartbeat');

  return (
    <Panel
      title="Live feed"
      meta={<span>{lastEventAt ? `last event ${fmtClockUtc(lastEventAt)}` : 'no events yet'}</span>}
      actions={
        status === 'live' ? null : <Button onClick={onReconnect}>Reconnect</Button>
      }
      footnote={
        <span>
          {connectionLine(status, attempts, lastHeartbeatAt)}. Keep-alive frames are not
          listed: they mean the connection is alive, not that anything happened.
        </span>
      }
    >
      {visible.length === 0 ? (
        /*
         * The first version of this line answered a question the reader had not
         * asked yet — it explained the CONNECTION ("the loop may be idle, or the
         * stream may not be connected") to someone who did not yet know what the
         * panel was for. Driving the deployed site produced the plain version of
         * the problem: "the feed am not sure of what feed it is". So the panel
         * says what it shows and where the control is, and the connection state
         * stays in the footnote below, where a reader who is already looking for
         * it will find it.
         */
        <p className="py-1 text-label text-ink-light">
          Nothing yet. As the loop works, one line appears here per event — the hypothesis
          it proposed, the backtest that scored it, and the gate&rsquo;s verdict on it. If
          the loop is not running, the control is at the top of this page.
        </p>
      ) : (
        <ol className="flex max-h-[22rem] flex-col overflow-y-auto">
          {visible.map((event, index) => (
            <li
              key={`${event.at}-${event.type}-${index}`}
              className="border-b border-rule py-2 last:border-b-0"
            >
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-mono text-caption text-ink-light">
                  {fmtClockUtc(event.at)} · {event.type.replace(/_/g, ' ')}
                </span>
                {event.entry ? (
                  <span className="font-mono text-caption text-ink-light">
                    {event.entry.entry_id} · {truncHash(event.entry.entry_hash)}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-label text-ink">{event.message}</p>

              {event.entry ? (
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <VerdictStamp
                    verdict={verdictForDecision(event.entry)}
                    size="small"
                  />
                  <span className="text-caption text-ink-light">
                    {killReasonPlain(event.entry.reason) ??
                      killReasonTag(event.entry.reason) ??
                      'cleared every check'}
                  </span>
                </div>
              ) : null}

              {event.tier_failure ? (
                <p className="mt-1 text-caption text-ink-light">
                  generator tier failed: {event.tier_failure.tier} — {event.tier_failure.message}
                </p>
              ) : null}

              {event.error ? (
                <p className="mt-1 text-caption text-ink">{event.error}</p>
              ) : null}

              {event.breaker ? (
                <p className="mt-1 text-caption text-ink-light">
                  {event.breaker.tripped
                    ? `tripped: ${event.breaker.reason ?? 'reason not reported'} at ${fmtIsoExact(
                        event.breaker.tripped_at,
                      )}`
                    : event.breaker.detail}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
