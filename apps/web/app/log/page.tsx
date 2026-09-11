'use client';

/**
 * Decision log — the tamper-evidence screen.
 *
 * Every entry, both hashes, and a chain check the reader can trigger. The result
 * of that check is shown INLINE, never in a modal (spec §6 Screen 3), and it is
 * never claimed before it is run: until the check has been performed this screen
 * says the chain has not been verified in this session, rather than printing a
 * reassuring line that no computation supports.
 *
 * Pagination is by the API's own `next_cursor`, and pages accumulate rather than
 * replace so that a poll refreshing the newest page cannot erase the older
 * entries a reader has already loaded.
 */

import { useMemo, useState } from 'react';
import { BackendNotice, StaleNotice } from '@/components/BackendNotice';
import { Button } from '@/components/Button';
import { DecisionLog } from '@/components/DecisionLog';
import { fmtInt, fmtIsoExact } from '@/lib/format';
import { getLog, isAborted, verifyChain } from '@/lib/api';
import type { ChainVerification, DecisionRow } from '@/lib/types';
import { useNow, useResource } from '@/lib/useResource';

/** Entries per page request. */
const PAGE_SIZE = 25;

type VerifyState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: ChainVerification }
  | { status: 'failed'; message: string };

export default function LogPage() {
  const log = useResource((signal) => getLog({ limit: PAGE_SIZE }, signal), {
    intervalMs: 30_000,
  });

  const [older, setOlder] = useState<DecisionRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyState>({ status: 'idle' });
  const now = useNow();

  const firstPage = useMemo(() => log.data?.entries ?? [], [log.data]);

  const entries = useMemo(() => {
    if (older.length === 0) return firstPage;
    const seen = new Set(firstPage.map((row) => row.entry_id));
    return [...firstPage, ...older.filter((row) => !seen.has(row.entry_id))];
  }, [firstPage, older]);

  // The cursor to continue from: the accumulated tail if pages were loaded,
  // otherwise the first page's cursor.
  const nextCursor = cursor ?? log.data?.next_cursor ?? null;
  const hasMore = older.length > 0 ? cursor !== null : (log.data?.next_cursor ?? null) !== null;

  async function loadOlder() {
    setLoadingOlder(true);
    setLoadError(null);
    try {
      const from = older.length > 0 ? cursor : (log.data?.next_cursor ?? null);
      if (!from) return;
      const page = await getLog({ limit: PAGE_SIZE, before: from });
      setOlder((previous) => [...previous, ...page.entries]);
      setCursor(page.next_cursor);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? `${error.message}. No entries were added.`
          : 'the request failed. No entries were added.',
      );
    } finally {
      setLoadingOlder(false);
    }
  }

  async function runVerify() {
    setVerify({ status: 'running' });
    try {
      const result = await verifyChain();
      setVerify({ status: 'done', result });
    } catch (error) {
      setVerify({
        status: 'failed',
        message:
          error instanceof Error
            ? `${error.message}. The chain was not verified.`
            : 'the request failed. The chain was not verified.',
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="border-b border-rule pb-4">
        <h1 className="text-heading font-semibold text-ink">Decision log</h1>
        <p className="mt-1 text-label text-ink-light">
          {log.data
            ? `${fmtInt(log.data.total)} entries · each entry hashes the one before it, so altering or removing a line breaks every hash after it.`
            : 'the entry count is not available yet'}
        </p>
        <div className="mt-2" aria-live="polite">
          {verify.status === 'idle' ? (
            <p className="text-caption text-ink-light">
              Chain not verified in this session. The check recomputes every digest from
              the stored entries; it does not read a cached result.
            </p>
          ) : verify.status === 'running' ? (
            <p className="text-caption text-ink-light">Verifying…</p>
          ) : verify.status === 'failed' ? (
            <p className="text-label text-ink">{verify.message}</p>
          ) : verify.result.valid === true ? (
            <p className="font-mono text-label text-ink">
              VALID — {verify.result.checked ? `all ${fmtInt(verify.result.checked)} hashes` : 'every hash'}{' '}
              verified
              {verify.result.verified_at
                ? ` (verified ${fmtIsoExact(verify.result.verified_at)})`
                : ''}
            </p>
          ) : verify.result.valid === false ? (
            <p className="font-mono text-label text-ink">
              BROKEN
              {verify.result.broken_entry_id
                ? ` — first mismatch at ${verify.result.broken_entry_id}`
                : ''}
              {verify.result.detail ? `. ${verify.result.detail}` : ''}
            </p>
          ) : (
            /*
             * GET /api/log/verify has no response shape in the wire contract, so
             * an answer this client cannot read is reported as it arrived rather
             * than being read as a pass. Silence must never look like VALID.
             */
            <p className="text-label text-ink">
              The verification endpoint answered without a result this client can read
              {verify.result.detail ? `: ${verify.result.detail}` : '.'} The chain is
              therefore unverified.
            </p>
          )}
        </div>
      </section>

      {log.stale ? (
        <StaleNotice failure={log.failure} readAt={log.readAt} onRetry={log.reload} />
      ) : null}

      {loadError ? (
        <p className="border border-rule bg-surface px-4 py-2 text-label text-ink">{loadError}</p>
      ) : null}

      {log.data ? (
        <DecisionLog
          entries={entries}
          now={now}
          variant="full"
          hasMore={hasMore}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
          meta={
            <span>
              {entries.length} of {fmtInt(log.data.total)}
              {nextCursor ? ` · cursor ${nextCursor.slice(0, 12)}` : ''}
            </span>
          }
          actions={
            <Button onClick={runVerify} disabled={verify.status === 'running'}>
              {verify.status === 'running' ? 'Verifying…' : 'Verify chain'}
            </Button>
          }
          footnote="Hover a hash to see the full digest; entry ids and both hashes are shown so the chain is readable without documentation. A demotion is appended as a new entry — nothing in this file is ever edited."
        />
      ) : log.waking || (log.failure && !isAborted(log.failure)) ? (
        <BackendNotice
          endpoint="GET /api/log"
          subject="The decision log"
          failure={isAborted(log.failure) ? null : log.failure}
          waking={log.waking}
          onRetry={log.reload}
        />
      ) : (
        <p className="text-label text-ink-light">Reading the log…</p>
      )}
    </div>
  );
}
