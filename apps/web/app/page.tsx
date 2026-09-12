'use client';

/**
 * Live loop view — the default route, and the screen the demo opens on.
 *
 * Reading order is fixed: the session line, then the provenance, then the
 * hypothesis and its stamp, then the state of the loop, then the record. The
 * stamp is the largest element on the page in both outcomes, and the session
 * counter line ("43 attempted · 1 promoted · 42 killed") is the second thing the
 * eye lands on, per spec §6 Screen 1.
 *
 * DEGRADATION. Three reads arrive independently — status, the log, and the SSE
 * stream — and any of them can be missing on its own:
 *
 *   - the stream can be live while REST is cold-starting, and vice versa;
 *   - the log can answer while status does not.
 *
 * So nothing here is gated on everything succeeding: each panel renders what it
 * has, and the panel that has nothing says which endpoint is missing and what
 * that means. There is no full-page spinner and no blank page, because a blank
 * page cannot tell a reader whether the loop is idle or the backend is asleep.
 */

import { useMemo, useState } from 'react';
import { BackendNotice, StaleNotice } from '@/components/BackendNotice';
import { Button } from '@/components/Button';
import { CircuitBreakerPanel, type ResetOutcome } from '@/components/CircuitBreakerPanel';
import { DecisionLog } from '@/components/DecisionLog';
import { HypothesisPanel } from '@/components/HypothesisPanel';
import { LiveFeed } from '@/components/LiveFeed';
import { Panel } from '@/components/Panel';
import { ProvenancePanel } from '@/components/ProvenancePanel';
import { SessionStatsPanel } from '@/components/SessionStatsPanel';
import { StatusChip } from '@/components/StatusChip';
import { fmtInt } from '@/lib/format';
import {
  getLog,
  getStatus,
  isAborted,
  postPause,
  postReset,
  postResume,
} from '@/lib/api';
import { deriveCurrent, useStream } from '@/lib/stream';
import type { StatusResponse } from '@/lib/types';
import { useNow, useResource } from '@/lib/useResource';

/** Recent decisions shown on this view. The full record lives on /log. */
const RECENT_LIMIT = 12;

/**
 * The killed count, with the schema-wall share named as a SUBSET rather than as
 * a fourth category.
 *
 * The agent computes `hypotheses_killed` as `attemptsMade - promoted`
 * (session/loop.ts), which deliberately includes the proposals the schema wall
 * stopped before any backtest — the comment there explains that counting only
 * judged candidates would make promoted + killed fall short of attempted and
 * read as lost data. Printed as its own `·` segment, though, the schema count
 * looked additive: "43 attempted · 1 promoted · 42 killed · 5 stopped by the
 * schema wall" invites a reader to add 42 and 5 and find 47 non-promotions in a
 * 43-attempt session. Two true numbers can still compose a false sentence, and
 * this line is the second thing the eye lands on.
 */
function killedSegment(stats: StatusResponse['stats']): string {
  const killed = `${fmtInt(stats.hypotheses_killed)} killed`;
  if (stats.hypotheses_schema_rejected <= 0) return killed;
  return `${killed} (${fmtInt(stats.hypotheses_schema_rejected)} of them by the schema wall, before any backtest)`;
}

export default function LoopPage() {
  const stream = useStream();
  const status = useResource(getStatus, {
    intervalMs: 15_000,
    reloadOn: stream.revision,
  });
  const log = useResource((signal) => getLog({ limit: RECENT_LIMIT }, signal), {
    intervalMs: 30_000,
    reloadOn: stream.revision,
  });

  // Relative times ("2 min ago") are dated against one instant per render pass,
  // and re-dated on a slow tick so they do not go stale while the page idles.
  const now = useNow();

  const entries = useMemo(() => log.data?.entries ?? [], [log.data]);
  const current = useMemo(() => deriveCurrent(stream.events, entries), [stream.events, entries]);

  const statusData = status.data;
  const phase = statusData?.phase ?? null;
  const running = phase === 'running' && current.hypothesis !== null && current.entry === null;

  const [control, setControl] = useState<{ pending: boolean; text: string | null }>({
    pending: false,
    text: null,
  });
  const [reset, setReset] = useState<{
    pending: boolean;
    outcome: ResetOutcome | null;
  }>({ pending: false, outcome: null });

  const reloadAll = () => {
    status.reload();
    log.reload();
  };

  async function toggleLoop() {
    setControl({ pending: true, text: null });
    try {
      const response = phase === 'running' ? await postPause() : await postResume();
      setControl({ pending: false, text: `${response.phase}: ${response.detail}` });
      reloadAll();
    } catch (error) {
      setControl({
        pending: false,
        text:
          error instanceof Error
            ? `${error.message} — the loop was not changed.`
            : 'the request failed; the loop was not changed.',
      });
    }
  }

  async function requestReset(requestedBy: string) {
    setReset({ pending: true, outcome: null });
    try {
      const response = await postReset(requestedBy);
      setReset({ pending: false, outcome: { ok: response.ok, detail: response.detail } });
      reloadAll();
    } catch (error) {
      setReset({
        pending: false,
        outcome: {
          ok: false,
          detail:
            error instanceof Error
              ? `${error.message}. The breaker was not reset.`
              : 'the request failed. The breaker was not reset.',
        },
      });
    }
  }

  /*
   * The log section: the table when a reading exists, the notice when one is
   * owed. BackendNotice already distinguishes "still waking" from "failed", so
   * the three-way choice collapses to two.
   */
  function renderLog() {
    if (log.data) {
      return (
        <DecisionLog
          entries={entries}
          now={now}
          variant="compact"
          meta={<span>{fmtInt(log.data.total)} total</span>}
          footnote="The twelve most recent decisions. The full record, with both hashes per entry, is on the log screen."
        />
      );
    }
    if (log.waking || (log.failure && !isAborted(log.failure))) {
      return (
        <BackendNotice
          endpoint="GET /api/log"
          subject="Recent decisions"
          failure={isAborted(log.failure) ? null : log.failure}
          waking={log.waking}
          onRetry={log.reload}
        />
      );
    }
    return (
      <Panel title="Decision log">
        <p className="text-label text-ink-light">Reading the log…</p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/*
        The session header. Before the first reading arrives it still renders its
        shell, so the page has a shape while the backend wakes instead of
        appearing to be nothing.
      */}
      <section className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b border-rule pb-4">
        <div>
          <h1 className="text-heading font-semibold text-ink">
            {statusData ? `Session ${statusData.provenance.session_id}` : 'Session'}
          </h1>
          <p className="mt-1 font-mono text-label text-ink-light">
            {statusData ? (
              <>
                {fmtInt(statusData.stats.hypotheses_attempted)} attempted ·{' '}
                {fmtInt(statusData.stats.hypotheses_promoted)} promoted ·{' '}
                {killedSegment(statusData.stats)} ·{' '}
                {fmtInt(statusData.stats.retired_factors)} retired
              </>
            ) : (
              'no counter reading yet'
            )}
          </p>
        </div>

        <div className="flex items-center gap-6">
          <StatusChip phase={phase} pulse={running} />
          {phase === 'running' || phase === 'paused' ? (
            <Button onClick={toggleLoop} disabled={control.pending}>
              {control.pending ? 'Sending…' : phase === 'running' ? 'Pause loop' : 'Resume loop'}
            </Button>
          ) : null}
        </div>
      </section>

      {control.text ? <p className="text-label text-ink">{control.text}</p> : null}

      {statusData ? (
        <ProvenancePanel provenance={statusData.provenance} />
      ) : (
        <BackendNotice
          endpoint="GET /api/status"
          subject="The session header, the provenance, the session statistics and the circuit breaker"
          failure={isAborted(status.failure) ? null : status.failure}
          waking={status.waking}
          onRetry={status.reload}
        />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <HypothesisPanel
          // `?? null` because the panel's contract is explicit — null means "no
          // hypothesis in flight" — while the live state is `undefined` until the
          // first stream event arrives. The two are the same thing to this panel
          // (`phase` is what distinguishes an idle loop from a running one), and
          // normalising here keeps the component's prop type honest rather than
          // widening it to accept a case it does not reason about.
          hypothesis={current.hypothesis ?? null}
          hypothesisId={current.hypothesisId}
          generator={current.generator}
          metrics={current.metrics}
          entry={current.entry}
          phase={phase}
        />

        <div className="flex flex-col gap-6">
          {statusData ? (
            <SessionStatsPanel status={statusData} />
          ) : (
            <Panel title="Session stats" fill="surface">
              <p className="text-label text-ink-light">
                No reading from GET /api/status, so there are no statistics to show. Nothing
                here is estimated.
              </p>
            </Panel>
          )}

          <LiveFeed
            status={stream.status}
            events={stream.events}
            attempts={stream.attempts}
            lastEventAt={stream.lastEventAt}
            lastHeartbeatAt={stream.lastHeartbeatAt}
            onReconnect={stream.reconnectNow}
          />
        </div>
      </div>

      {statusData ? (
        <CircuitBreakerPanel
          breaker={statusData.circuit_breaker}
          counters={statusData.circuit_counters}
          onReset={requestReset}
          pending={reset.pending}
          outcome={reset.outcome}
        />
      ) : null}

      {log.stale ? (
        <StaleNotice failure={log.failure} readAt={log.readAt} onRetry={log.reload} />
      ) : null}

      {renderLog()}
    </div>
  );
}
