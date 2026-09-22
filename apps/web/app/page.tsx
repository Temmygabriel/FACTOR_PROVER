'use client';

/**
 * Live loop view — the default route, and the screen the demo opens on.
 *
 * READING ORDER is now the reconfiguration brief's §38: what this is, how it
 * works, the session's own numbers, a real result from the record, why the
 * record can be trusted, and only then the live instrument — session line,
 * provenance, hypothesis and stamp, loop state, record. The stamp is still the
 * largest element in the running view in both outcomes. What changed is that the
 * page no longer opens on a raw session id as its `<h1>`: a first-time reader
 * now meets the product before the machinery.
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
 *
 * The new sections above obey the same rule, and it is worth stating how: the
 * hero, the pipeline and the trust columns are static copy and need no backend
 * at all, and the real-result card omits itself rather than inventing numbers if
 * its read fails. So a cold backend costs a reader the live panels and nothing
 * above them.
 */

import { useMemo, useState } from 'react';
import { BackendNotice, StaleNotice } from '@/components/BackendNotice';
import { Button } from '@/components/Button';
import { CircuitBreakerPanel, type ResetOutcome } from '@/components/CircuitBreakerPanel';
import { DecisionLog } from '@/components/DecisionLog';
import { EmptyBench } from '@/components/EmptyBench';
import { HypothesisPanel } from '@/components/HypothesisPanel';
import { LiveFeed } from '@/components/LiveFeed';
import { OrientationStrip } from '@/components/OrientationStrip';
import { Panel } from '@/components/Panel';
import { ProcessPipeline } from '@/components/ProcessPipeline';
import type { StageState } from '@/components/ProcessStep';
import { ProductHero } from '@/components/ProductHero';
import { ProvenancePanel } from '@/components/ProvenancePanel';
import { RealResultCard } from '@/components/RealResultCard';
import { SessionStatsPanel } from '@/components/SessionStatsPanel';
import { StatusChip } from '@/components/StatusChip';
import { TrustSection } from '@/components/TrustSection';
import { sessionCounts } from '@/lib/copy';
import { fmtInt } from '@/lib/format';
import { canStartSession } from '@/lib/phase';
import {
  getLog,
  getStatus,
  isAborted,
  postPause,
  postReset,
  postResume,
} from '@/lib/api';
import { deriveCurrent, useStream } from '@/lib/stream';
import type { DecisionRow, SessionPhase, StatusResponse } from '@/lib/types';
import { useNow, useResource } from '@/lib/useResource';
import { verdictForDecision } from '@/lib/verdict';

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

/**
 * What the pipeline diagram is allowed to say about the loop right now.
 *
 * THE HARD PART IS NOT THE STATES, IT IS THE RESTRAINT. A diagram with five
 * nodes and three shades is very easy to make assert something that has not
 * happened — a node lit because a request went out, or because a previous
 * session had got that far. So every state below is earned from a value this
 * page already holds, and nothing is inferred from the mere fact that the loop
 * is switched on.
 *
 *  - DATA is the one node that is ALWAYS complete, and that is not a shortcut.
 *    The dataset is frozen and hashed and ships with the service; there is no
 *    moment at which it is not ready, so a diagram that showed it pending would
 *    be describing a state this system cannot be in.
 *  - Nothing else is lit unless the loop is actually running. An idle loop shows
 *    an idle diagram rather than the last session's final state, because this
 *    page cannot tell those apart from the counters alone and guessing would put
 *    a stale verdict on the screen.
 *  - IDEA is current only while the loop is running and has not yet produced a
 *    hypothesis to test. TEST is current once one is in flight.
 *  - All five are complete only when a verdict for the in-flight hypothesis has
 *    actually arrived, which is the single instant at which every stage has
 *    demonstrably happened.
 *
 * GATE and VERDICT are lit together rather than in sequence. They are one
 * atomic event in this system — `gate.ts` applies the policy and returns the
 * decision — and a diagram that animated between them would be depicting a
 * handoff that does not exist in the code.
 */
function pipelineStates(
  phase: SessionPhase | null,
  hypothesisInFlight: boolean,
  verdictArrived: boolean,
): StageState[] {
  if (phase !== 'running') {
    return ['idle', 'done', 'idle', 'idle', 'idle'];
  }
  if (verdictArrived) {
    return ['done', 'done', 'done', 'done', 'done'];
  }
  if (hypothesisInFlight) {
    return ['done', 'done', 'current', 'idle', 'idle'];
  }
  return ['current', 'done', 'idle', 'idle', 'idle'];
}

/**
 * The VERDICT node's tone, or null when there is no verdict to tint it with.
 *
 * A circuit break takes null rather than a colour, for the reason `lib/verdict.ts`
 * gives at length: a circuit break is a halt of the loop, not a judgement on a
 * factor, and tinting the node red would tell a reader a hypothesis had been
 * killed when what happened is that the loop stopped.
 */
function pipelineTone(entry: DecisionRow | null): 'promoted' | 'killed' | null {
  if (!entry) return null;
  const verdict = verdictForDecision(entry);
  if (verdict === 'PROMOTED') return 'promoted';
  if (verdict === 'KILLED' || verdict === 'AUTO-KILLED') return 'killed';
  return null;
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

  /*
   * The pipeline's inputs, kept as two named facts rather than inline booleans.
   * "A hypothesis is in flight" and "a verdict has arrived" are the two things
   * the diagram is allowed to react to, and naming them is what makes the rules
   * in `pipelineStates` checkable against the values they were written for.
   */
  const hypothesisInFlight = current.hypothesis !== null && current.entry === null;
  const verdictArrived = current.entry !== null;

  /*
   * The orientation strip's counts, which this page now renders itself. It reads
   * the SAME poll the header and the panels below use, so the strip and the
   * session line cannot disagree about the same instant — which is the property
   * `NavBar` was protecting when it passed these down, preserved here by
   * sourcing them from one status read rather than opening a second.
   */
  const counts = sessionCounts(statusData?.stats ?? null);

  /*
   * THIS SESSION has attempted nothing, so there is no verdict from it to render.
   *
   * The distinction between "this session" and "this project" is the whole
   * reason this comment is three paragraphs long. The predicate reads
   * `stats.hypotheses_attempted`, which comes from `attemptsMade` — a counter
   * that starts at zero on every boot and only moves when THIS process runs an
   * iteration. The committed decision log is read from disk and is entirely
   * unaffected by a restart. On a free tier that sleeps when idle, those two
   * diverge as a matter of routine, and the previous version of this comment
   * asserted the opposite: that the count "says whether the bench has done any
   * work". It does not. On 2026-09-13 the deployed service reported
   * `hypotheses_attempted: 0` and 201 committed entries at the same moment.
   *
   * So `isEmpty` gates the empty bench, and the empty bench is told the
   * committed total and must say so rather than reporting an absence. What it
   * must never do is read as "nothing has ever been tested".
   *
   * Keyed on the attempt count rather than on an empty log because the two
   * arrive at different moments, and it is the count that says whether the bench
   * has done any work IN THIS SESSION.
   *
   * This is the state a cold visitor meets most often: the deployed agent runs
   * on a free tier that sleeps when idle and loses its session when it wakes.
   * See PROGRESS.md finding 35.
   */
  const isEmpty = statusData !== null && statusData.stats.hypotheses_attempted === 0;

  /*
   * Whether the loop can be ASKED to start, which is a different question from
   * `isEmpty` above. `isEmpty` says this process has done no work yet; this says
   * the phase will accept a start. Conflating them is what removed the start
   * control from the page after the first run. See `lib/phase.ts`.
   */
  const canStart = canStartSession(phase);

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
        What this is, then how it works. Both are static copy and neither touches
        the network, so on a cold backend they are the two things a reader still
        gets — which is the point of putting them first.
      */}
      <ProductHero />

      {/* `#how-it-works` is the nav item's destination, from every route. */}
      <div id="how-it-works" className="scroll-mt-16">
        <ProcessPipeline
          states={pipelineStates(phase, hypothesisInFlight, verdictArrived)}
          verdict={pipelineTone(current.entry)}
        />
      </div>

      {/*
        The session counters, moved below the explanation (brief §7.2). On the
        run view this page owns the strip; `NavBar` renders it only on the other
        two routes, so it appears exactly once wherever a reader is standing.
      */}
      <OrientationStrip counts={counts} />

      <RealResultCard />

      <TrustSection />

      {/*
        The live instrument. Everything below this line is the screen the demo
        opens on and behaves as it did before the reconfiguration.

        `id="live-test"` is the hero's primary CTA target, and `scroll-mt-16`
        clears the 48px sticky bar so the heading is not hidden underneath it
        when the anchor lands.
      */}
      <section
        id="live-test"
        className="flex scroll-mt-16 flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b border-rule pb-4"
      >
        <div>
          {/*
            An `<h2>`, not the `<h1>` it used to be. The page's one `<h1>` is now
            the hero headline — a page with two top-level headings has no
            top-level heading, and a screen reader's outline would announce the
            session id as a peer of the product statement rather than as a
            section under it.
          */}
          <h2 className="text-heading font-semibold text-ink">
            {statusData ? `Session ${statusData.provenance.session_id}` : 'Session'}
          </h2>
          <p className="mt-1 font-mono text-label text-ink-light">
            {statusData ? (
              <>
                {/*
                  "in this session" is load-bearing, not padding. Every counter on
                  this line is this PROCESS's — `attemptsMade` starts at zero when
                  the server boots — while the log table below is read from the
                  committed file and can hold hundreds of rows at the same instant.
                  Unqualified, "0 attempted" directly above a 201-row record reads
                  as a claim about the project rather than about this run, and the
                  two panels then contradict each other on one screen. See
                  PROGRESS.md finding 35.
                */}
                {fmtInt(statusData.stats.hypotheses_attempted)} attempted in this session ·{' '}
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
          {/*
            The session header owns the loop control for EVERY phase, not only the
            running ones.

            It used to render only for `running` and `paused`, and the start
            control lived in the empty bench, which renders only while
            `hypotheses_attempted === 0`. From `stopped` with attempts behind it
            neither appeared, so there was no way to start the loop again from the
            interface — one run and the page was a dead end that explained
            nothing. Found by driving the deployed site, which is the only way it
            would have been found.

            One control in one place for every phase, so there is never a state
            with two ways to change the loop, and never one with none.
          */}
          {phase === 'running' || phase === 'paused' ? (
            <Button onClick={toggleLoop} disabled={control.pending}>
              {control.pending ? 'Sending…' : phase === 'running' ? 'Pause loop' : 'Resume loop'}
            </Button>
          ) : canStart ? (
            <Button onClick={toggleLoop} disabled={control.pending}>
              {control.pending ? 'Sending…' : 'Start research session'}
            </Button>
          ) : null}
        </div>
      </section>

      {/*
        Before the provenance panel, deliberately. On a session with no
        hypotheses the first question is "what is this and can I start it", and
        the provenance block answers a question the reader has not asked yet.

        This panel no longer carries the start control — the session header owns
        it for every phase. It is explanatory only, and the pre-flight rows below
        are the part worth keeping here: they are what a cold visitor reads before
        deciding whether to start anything.
      */}
      {isEmpty && statusData ? (
        <EmptyBench
          status={statusData}
          /*
           * What the COMMITTED record holds, which is a different quantity from
           * the zero in the header and is why it is passed at all. `log.data` is
           * the same poll the table below renders, so this cannot drift from the
           * rows it describes. Null means the log read has not answered yet —
           * rendered as "not read", never as zero.
           */
          committedEntries={log.data ? log.data.total : null}
          message={control.text}
        />
      ) : null}

      {control.text && !isEmpty ? <p className="text-label text-ink">{control.text}</p> : null}

      {/*
        `id="provenance"` is the trust section's destination for both "see the
        protocol" and "view data details". Two links landing on one panel is
        correct rather than lazy: the gate policy version and hash, the dataset
        hash and the frozen-file count are all printed in this one block, so it
        is genuinely where both answers live. Inventing a second destination
        would mean a link that promises something this page does not show.
      */}
      <div id="provenance" className="scroll-mt-16">
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
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* The orientation strip's "watch it happen live" anchor lands here. */}
        <div id="live-hypothesis">
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
            // The card's "bar it must clear" section reads the family size and
            // the session's rank-1 threshold from here. Same reading the header
            // above uses, so the two cannot disagree about the same instant.
            stats={statusData?.stats ?? null}
          />
        </div>

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
