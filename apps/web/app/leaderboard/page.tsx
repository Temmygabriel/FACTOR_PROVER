'use client';

/**
 * Factor leaderboard.
 *
 * The screen exists to make one point: the kills are shown, in full, next to the
 * promotes. There is no filter, no tab and no collapsed section that would let a
 * reader see only the winners — a leaderboard that hides its kills is not a
 * research record (spec §6 Screen 2).
 *
 * It reads without a stream. Promotions are rare by construction, so a 30s poll
 * of three endpoints is enough to keep the screen current and avoids holding a
 * second SSE connection open for a page that changes a few times an hour.
 */

import { useMemo, useState } from 'react';
import { BackendNotice, StaleNotice } from '@/components/BackendNotice';
import { FactorLeaderboard } from '@/components/FactorLeaderboard';
import { Glossary, Term } from '@/components/Term';
import { Panel } from '@/components/Panel';
import { COLUMN_TIPS, SIGNAL_PLAIN, VERDICT_MEANING } from '@/lib/copy';
import { fmtDateUtc, fmtInt } from '@/lib/format';
import { getLeaderboard, getLog, getStatus, isAborted } from '@/lib/api';
import type { DecisionRow } from '@/lib/types';
import { useResource } from '@/lib/useResource';

/** Kills shown before the reader asks for the rest. */
const KILL_PAGE_SIZE = 50;
/** Ceiling on "Show all", so one click cannot pull an unbounded log. */
const MAX_KILL_PAGES = 10;

function isKillRow(row: DecisionRow): boolean {
  return row.decision !== 'PROMOTE' && row.decision !== 'CIRCUIT_BREAK';
}

export default function LeaderboardPage() {
  const status = useResource(getStatus, { intervalMs: 30_000 });
  const leaderboard = useResource(getLeaderboard, { intervalMs: 30_000 });
  const log = useResource((signal) => getLog({ limit: KILL_PAGE_SIZE }, signal), {
    intervalMs: 30_000,
  });

  const [olderKills, setOlderKills] = useState<DecisionRow[]>([]);
  const [allLoaded, setAllLoaded] = useState(false);
  const [loadingKills, setLoadingKills] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const killRows = useMemo(() => {
    const first = (log.data?.entries ?? []).filter(isKillRow);
    if (olderKills.length === 0) return first;
    // A poll can deliver a newer first page while older pages are on screen, so
    // the two sets are merged by entry id rather than concatenated; the same
    // entry must not be counted twice in a table this one is reading as a record.
    const seen = new Set(first.map((row) => row.entry_id));
    const extra = olderKills.filter((row) => !seen.has(row.entry_id));
    return [...first, ...extra];
  }, [log.data, olderKills]);

  const factors = useMemo(
    () => [...(leaderboard.data?.factors ?? [])].sort((a, b) => b.ic - a.ic),
    [leaderboard.data],
  );

  async function loadAllKills() {
    setLoadingKills(true);
    setLoadError(null);
    try {
      const collected: DecisionRow[] = [];
      let cursor = log.data?.next_cursor ?? null;
      let pages = 0;
      while (cursor && pages < MAX_KILL_PAGES) {
        const page = await getLog({ limit: 100, before: cursor });
        collected.push(...page.entries.filter(isKillRow));
        cursor = page.next_cursor;
        pages += 1;
      }
      setOlderKills(collected);
      setAllLoaded(true);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? `${error.message}. The older entries were not loaded; what is shown is unchanged.`
          : 'the request failed; what is shown is unchanged.',
      );
    } finally {
      setLoadingKills(false);
    }
  }

  function collapseKills() {
    setOlderKills([]);
    setAllLoaded(false);
  }

  const statusData = status.data;
  const attempted = statusData?.stats.hypotheses_attempted ?? log.data?.total ?? 0;
  const fdrLevel = statusData?.provenance.fdr_level ?? 0.1;

  return (
    <div className="flex flex-col gap-6">
      <section className="border-b border-rule pb-4">
        <h1 className="text-heading font-semibold text-ink">Factor leaderboard</h1>
        <p className="mt-1 font-mono text-label text-ink-light">
          {statusData ? (
            <>
              Session {statusData.provenance.session_id} ·{' '}
              {fmtInt(statusData.stats.hypotheses_attempted)} hypotheses ·{' '}
              {fmtDateUtc(statusData.provenance.started_at)}
            </>
          ) : (
            'session not reported — the counters below come from the log alone'
          )}
        </p>
      </section>

      {log.stale ? (
        <StaleNotice failure={log.failure} readAt={log.readAt} onRetry={log.reload} />
      ) : null}

      {loadError ? (
        <p className="border border-rule bg-surface px-4 py-2 text-label text-ink">{loadError}</p>
      ) : null}

      {leaderboard.data ? (
        <FactorLeaderboard
          factors={factors}
          emptyReason={leaderboard.data.empty_reason}
          killRows={killRows}
          killCount={statusData?.stats.hypotheses_killed ?? killRows.length}
          attempted={attempted}
          fdrLevel={fdrLevel}
          allKillsLoaded={allLoaded}
          loadingKills={loadingKills}
          onLoadAllKills={loadAllKills}
          onCollapseKills={collapseKills}
          killPageSize={KILL_PAGE_SIZE}
        />
      ) : leaderboard.waking || (leaderboard.failure && !isAborted(leaderboard.failure)) ? (
        <BackendNotice
          endpoint="GET /api/leaderboard"
          subject="The promoted factors"
          failure={isAborted(leaderboard.failure) ? null : leaderboard.failure}
          waking={leaderboard.waking}
          onRetry={leaderboard.reload}
        />
      ) : (
        <Panel title="Promoted factors">
          <p className="text-label text-ink-light">Reading the leaderboard…</p>
        </Panel>
      )}

      <Panel
        title="What the columns mean"
        fill="surface"
        footnote={
          <span>
            Hover any column header for the same definition. Signal names: BTC funding rate
            is{' '}
            <Term tip={SIGNAL_PLAIN.btc_funding_rate ?? ''}>
              the 8-hourly payment on Bitget&rsquo;s BTC perpetual
            </Term>
            ; the spot-return signals are price changes over the lookback window.
          </span>
        }
      >
        <Glossary
          items={[
            ['IC', COLUMN_TIPS.ic],
            ['t-statistic', COLUMN_TIPS.t],
            ['p-value', COLUMN_TIPS.p],
            ['BH threshold', COLUMN_TIPS.bh],
            ['observations', COLUMN_TIPS.obs],
            ['baseline IC', COLUMN_TIPS.baseline],
            ['paper P&L', COLUMN_TIPS.pnl],
            ['decay half-life', COLUMN_TIPS.decay],
            ['window', COLUMN_TIPS.window],
            ['lookback', COLUMN_TIPS.lookback],
            ['PROMOTED', VERDICT_MEANING.PROMOTED],
            ['KILLED', VERDICT_MEANING.KILLED],
            ['AUTO-KILLED', VERDICT_MEANING['AUTO-KILLED']],
            ['RETIRED', VERDICT_MEANING.RETIRED],
          ]}
        />
      </Panel>
    </div>
  );
}
