'use client';

/**
 * Decision log — the tamper-evidence screen.
 *
 * Every entry, both hashes, and a chain check that runs when the screen opens
 * rather than when a button is pressed. The check IS the product's claim, and a
 * claim a reader has to ask for reads as an audit trail; so it runs on arrival
 * and says in words that it is running — "Verifying chain integrity…" is the
 * screen reporting what it is doing, and a spinner would hide exactly the part
 * worth showing. The button stays as a re-check.
 *
 * The banner reports six answers and collapses none of them, because the
 * differences between them are the point:
 *
 *   intact      the endpoint re-hashed n > 0 entries and the chain held.
 *   broken      ok: false — the log's own bytes did not reproduce the chain.
 *   empty       ok with 0 entries. Vacuous: an empty log has no chain to be
 *               intact, so it reports nothing to verify and never a pass.
 *   unavailable the endpoint could not read a log at all. "Nothing to check" and
 *               "checked and found broken" are different statements.
 *   unreadable  a 2xx answer whose shape this client cannot read. Silence must
 *               never look like a pass.
 *   no answer   the request ended without a body. Not red: red is the verdict on
 *               a broken chain, and a backend that did not answer has said
 *               nothing about the record.
 *
 * Pagination is by the API's own `next_cursor`, and pages accumulate rather than
 * replace so that a poll refreshing the newest page cannot erase the older
 * entries a reader has already loaded.
 *
 * TWO RECORDS, AND THE RULE THAT KEEPS THEM APART. There is a canonical record,
 * in which no model proposed anything, and a model-proposed one. `?record=`
 * selects between them and the response echoes back which one it answered with.
 * An ABSENT echo is not "the same as what I asked for" — it means the server is
 * older than record selection and ignored the parameter, so on a request for the
 * model's record it would return the canonical rows under a heading claiming
 * they are the model's. Every read on this page is therefore gated on `shown`,
 * and the selector is withheld entirely when no echo ever arrives. The one
 * exception, and why it is not a hole, is argued on `mayRenderAs` in lib/api.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackendNotice, StaleNotice } from '@/components/BackendNotice';
import { Button } from '@/components/Button';
import { DecisionLog } from '@/components/DecisionLog';
import { RecordExplainer } from '@/components/RecordExplainer';
import { fmtClockUtc, fmtInt } from '@/lib/format';
import { ApiFailure, getLog, isAborted, mayRenderAs, verifyChain } from '@/lib/api';
import { RECORD_COPY, proposerSentence } from '@/lib/copy';
import type { DecisionRow, RecordId, VerifyResponse } from '@/lib/types';
import { useNow, useResource } from '@/lib/useResource';

/** Entries per page request. */
const PAGE_SIZE = 25;

type VerifyState =
  | { status: 'running' }
  | { status: 'done'; result: VerifyResponse; verifiedAt: string }
  | { status: 'failed'; message: string };

/**
 * The banner's three fills, each a complete literal so Tailwind's scanner emits
 * it (the same reason lib/verdict.ts keeps its tones literal).
 *
 * The 6% wash is spelled `[0.06]` and not `/6`: 6 is not a step on Tailwind's
 * opacity scale, so `bg-promoted/6` would emit no rule at all and the banner
 * would come out unwashed. It is the same literal VERDICT_TONE.PROMOTED.fill
 * uses, so this banner and the PROMOTED stamp are one green rather than two.
 *
 * The neutral fill is for every state where the chain was not checked, including
 * an unreachable endpoint — see the header. Only a chain that failed a check
 * takes the killed red.
 */
const BANNER_TONE = {
  intact: 'border-promoted bg-promoted/[0.06]',
  broken: 'border-killed bg-killed/[0.06]',
  unproven: 'border-rule bg-surface',
} as const;

function ChainIntegrityBanner({ verify }: { verify: VerifyState }) {
  const shell = 'border px-4 py-3';

  if (verify.status === 'running') {
    return (
      <div className={`${shell} ${BANNER_TONE.unproven}`} aria-live="polite">
        <p className="text-label text-ink">Verifying chain integrity…</p>
        <p className="mt-1 max-w-[80ch] text-caption text-ink-light">
          The check recomputes each entry&rsquo;s digest from the log&rsquo;s own bytes and
          checks the link every entry records to the one before it. Nothing is claimed here
          until it answers.
        </p>
      </div>
    );
  }

  if (verify.status === 'failed') {
    return (
      <div className={`${shell} ${BANNER_TONE.unproven}`} aria-live="polite">
        <p className="text-label text-ink">{verify.message}</p>
        <p className="mt-1 max-w-[80ch] text-caption text-ink-light">
          The chain is unverified, not disproved: the check returned no result, so this screen
          claims nothing either way about the record.
        </p>
      </div>
    );
  }

  const { result, verifiedAt } = verify;
  const failures = result.failures;

  /*
   * Read before `ok`. The endpoint reports a log it could not open through
   * `unavailable_reason`, with ok false and no failures, and that is not a
   * verdict on the chain. Checked the other way round, a log that does not exist
   * yet would be stamped as a log that has been tampered with.
   */
  if (result.unavailable_reason) {
    return (
      <div className={`${shell} ${BANNER_TONE.unproven}`} aria-live="polite">
        <p className="text-label text-ink">Nothing to verify yet.</p>
        <p className="mt-1 max-w-[80ch] text-caption text-ink-light">
          The endpoint reports: {result.unavailable_reason}
        </p>
        <p className="mt-1 max-w-[80ch] text-caption text-ink-light">
          No entry was checked, so nothing is claimed here about the chain either way. Not
          checked and checked-and-broken are different statements.
        </p>
      </div>
    );
  }

  if (result.ok === false) {
    const first = failures[0];
    const entryId = first?.entry_id ?? null;
    const detail = first?.detail ?? null;

    return (
      <div className={`${shell} ${BANNER_TONE.broken}`} aria-live="polite">
        <p className="font-mono text-label text-killed">
          ✗ chain broken
          {entryId ? ` — first mismatch at ${entryId}` : ''}
          {typeof first?.line === 'number' ? ` (line ${first.line})` : ''}
          {detail ? `. ${detail}` : ''}
        </p>
        {failures.length > 1 ? (
          <p className="mt-1 font-mono text-label text-killed">
            {fmtInt(failures.length)} mismatches in all; the first is above.
          </p>
        ) : null}
        <p className="mt-1 max-w-[80ch] text-caption text-ink-light">
          Recomputing from the log&rsquo;s own bytes did not reproduce the chain the file
          records.
        </p>
      </div>
    );
  }

  if (result.ok === true) {
    const checked = result.entries_checked;

    /*
     * An empty log verifies vacuously — there is no chain to break — so it is
     * reported as nothing to verify rather than as a pass. `!(checked > 0)`
     * rather than `=== 0` so a count that arrives as a negative or a NaN lands
     * here too: neither is a number of entries a chain was proven over, and the
     * alternative is a green banner reading "✓ -3 entries · chain intact".
     */
    if (!(checked > 0)) {
      return (
        <div className={`${shell} ${BANNER_TONE.unproven}`} aria-live="polite">
          <p className="font-mono text-label text-ink">
            {fmtInt(checked)} entries · nothing to verify yet
          </p>
          <p className="mt-1 max-w-[80ch] text-caption text-ink-light">
            A check over an empty log passes without testing anything, so it is not shown as a
            pass. Every gate decision appends one entry, and this record holds none yet.
          </p>
        </div>
      );
    }

    if (typeof checked === 'number' && checked > 0) {
      return (
        <div className={`${shell} ${BANNER_TONE.intact}`} aria-live="polite">
          {/*
            The timestamp is when this answer arrived, not a time the server
            claims to have verified at: VerifyResponse carries no such field, and
            the alternative to the arrival time is a made-up one.
          */}
          <p className="font-mono text-label text-promoted">
            ✓ {fmtInt(checked)} entries · chain intact · verified {fmtClockUtc(verifiedAt)}
          </p>
          <div className="mt-1 max-w-[80ch] text-label text-ink-light">
            <p>Every kill and every promotion is in this record.</p>
            <p>It cannot be edited without breaking the chain.</p>
          </div>
        </div>
      );
    }
  }

  /*
   * Unreachable through the type, and kept anyway. These types describe the wire,
   * they do not check it, and a 2xx whose `ok` is neither true nor false would
   * otherwise fall out of this function having rendered nothing — which on this
   * screen reads as a chain with nothing wrong with it.
   */
  return (
    <div className={`${shell} ${BANNER_TONE.unproven}`} aria-live="polite">
      <p className="text-label text-ink">
        The verification endpoint answered without a result this client can read.
      </p>
      <p className="mt-1 max-w-[80ch] text-caption text-ink-light">
        The chain is therefore unverified.
      </p>
    </div>
  );
}

export default function LogPage() {
  /**
   * Which committed record this screen is reading.
   *
   * `reloadOn` re-runs the read when this changes, but it does NOT clear `data`:
   * for as long as the new read is in flight, `log.data` still holds the previous
   * record's rows. Falling through to those would put the canonical record under
   * a heading saying it is the model's — precisely the mislabelling record
   * selection was added to prevent. So nothing below reads `log.data` to decide
   * what to show. Everything goes through `shown`.
   */
  const [record, setRecord] = useState<RecordId>('committed');

  const log = useResource((signal) => getLog({ limit: PAGE_SIZE, record }, signal), {
    intervalMs: 30_000,
    reloadOn: record,
  });

  /**
   * The rows on screen, or null while the reading in hand belongs to another
   * record. Null is a state the page renders — "Reading the log…" — not a state
   * it papers over with the last answer.
   *
   * The decision is `mayRenderAs` in lib/api.ts: a pure function with its own
   * probe, because it is the single line between a reader and a record labelled
   * as something it is not, and a rule that load-bearing should not have to be
   * read out of a component to be checked.
   */
  const shown = mayRenderAs(record, log.data) ? log.data : null;

  /*
   * Whether this deployment can select records at all — tested against
   * `log.data` rather than `shown`. Once any answer has carried the echo the
   * deployment supports selection, including while a switch is in flight, when
   * `log.data` still holds the previous record's answer, echo and all. Reading it
   * from `shown` would drop the selector out from under the reader mid-click,
   * since `shown` is null for exactly that moment.
   */
  const serverCanSelect = log.data?.record !== undefined;

  const [older, setOlder] = useState<DecisionRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * The chain verdict, held WITH the record it is a verdict on.
   *
   * Switching records starts a new check, but the previous check's answer can
   * still be in flight. Keeping the record alongside the state means a late
   * answer is only ever rendered against the record it describes; a verdict for
   * the other record cannot be shown as this one's.
   */
  const [verify, setVerify] = useState<{ record: RecordId; state: VerifyState }>({
    record: 'committed',
    state: { status: 'running' },
  });

  const now = useNow();

  /**
   * The rows on screen: the reading's own page, plus any older pages loaded, and
   * NOTHING when there is no valid reading.
   *
   * The empty case is the point. `older` is cleared by an effect, and an effect
   * runs after the render that changed `record` — so for one commit, `older`
   * still holds the other record's rows while `shown` is already null. Falling
   * through to it would hand the record explainer a set of canonical rows to
   * search for "the closest the model came", and it would find one: a
   * deterministic entry rendered under a heading about the model. Deriving the
   * whole list from `shown` makes that unrepresentable rather than unlikely.
   */
  const entries = useMemo(() => {
    if (!shown) return [];
    if (older.length === 0) return shown.entries;
    const seen = new Set(shown.entries.map((row) => row.entry_id));
    return [...shown.entries, ...older.filter((row) => !seen.has(row.entry_id))];
  }, [shown, older]);

  const proposer = useMemo(() => proposerSentence(shown?.generators), [shown]);

  /*
   * A cursor belongs to its record. Both files number their entries densely from
   * E-0001, so an id carried across a switch points at an unrelated row — E-0006
   * is the PROMOTE in one record and a KILL in the other. Cleared on every
   * change, before the new reading lands.
   */
  useEffect(() => {
    setOlder([]);
    setCursor(null);
    setLoadError(null);
  }, [record]);

  // The cursor to continue from: the accumulated tail if pages were loaded,
  // otherwise the first page's cursor.
  const nextCursor = cursor ?? shown?.next_cursor ?? null;
  const hasMore = older.length > 0 ? cursor !== null : (shown?.next_cursor ?? null) !== null;

  async function loadOlder() {
    setLoadingOlder(true);
    setLoadError(null);
    try {
      const from = older.length > 0 ? cursor : (shown?.next_cursor ?? null);
      if (!from) return;
      const page = await getLog({ limit: PAGE_SIZE, before: from, record });
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

  const runVerify = useCallback(
    async (signal?: AbortSignal) => {
      setVerify({ record, state: { status: 'running' } });
      try {
        const result = await verifyChain(record, signal);
        setVerify({
          record,
          state: { status: 'done', result, verifiedAt: new Date().toISOString() },
        });
      } catch (error) {
        // An unmount aborts the request; there is no reader left to report to.
        if (error instanceof ApiFailure && isAborted(error)) return;
        // ApiFailure composes the spec's error copy from the method, the path and
        // the status — "GET /api/log/verify returned HTTP 503". Reported as it
        // arrived rather than as "something went wrong".
        const headline =
          error instanceof ApiFailure
            ? error.headline
            : error instanceof Error
              ? error.message
              : 'the verification request did not complete';
        setVerify({
          record,
          state: { status: 'failed', message: headline.endsWith('.') ? headline : `${headline}.` },
        });
      }
    },
    [record],
  );

  useEffect(() => {
    const controller = new AbortController();
    void runVerify(controller.signal);
    return () => controller.abort();
  }, [runVerify]);

  /*
   * A verdict for the other record is not a verdict on this one. While the check
   * for the selected record is outstanding, "running" is the only thing that can
   * honestly be shown — see the verify state's comment above.
   */
  const activeVerify: VerifyState =
    verify.record === record ? verify.state : { status: 'running' };

  /*
   * The path of the record on screen, taken from the check's own answer rather
   * than from a table of filenames kept here. `/api/log/verify` reports
   * `log_path` per record, so a reader can go from this page to the file in the
   * repository without the page having to know, and keep in step with, what the
   * files are called.
   */
  const recordPath = activeVerify.status === 'done' ? activeVerify.result.log_path : null;

  return (
    <div className="flex flex-col gap-6">
      <ChainIntegrityBanner verify={activeVerify} />

      {/*
        Sits between the chain verdict and the record it is a verdict on, which
        is the one place a reader is certain to pass. See the component header for
        why the selector is withheld rather than disabled when the server cannot
        select, and why the worked example is derived from the rows in hand.
      */}
      <RecordExplainer
        selected={record}
        onSelect={setRecord}
        serverCanSelect={serverCanSelect}
        rows={entries}
      />

      <section className="border-b border-rule pb-4">
        <h1 className="text-heading font-semibold text-ink">Decision log</h1>
        {/*
          Which record, in the record's own name, directly under the heading — the
          explanation above scrolls away, and the table below is fifteen screens
          of rows that would otherwise be unlabelled. The file path is appended
          only once the chain check has reported it, so it is the endpoint's path
          for this record rather than a filename typed here.
        */}
        <p className="mt-1 font-mono text-caption text-ink-light">
          {RECORD_COPY[record].title}
          {recordPath ? ` · ${recordPath}` : ''}
        </p>
        <p className="mt-1 text-label text-ink-light">
          {shown
            ? `${fmtInt(shown.total)} entries · each entry hashes the one before it, so altering or removing a line breaks every hash after it.`
            : 'the entry count is not available yet'}
        </p>
        {/*
          Who proposed these hypotheses, in words, from the server's tally over
          the whole file. It sits directly under the entry count because that is
          the sentence a reader is already reading when they start wondering
          whether a model wrote this — and because the pre-flight checklist
          reports the generator chain's LIVE tiers, which is a fact about the
          deployment rather than about the record on this screen. Absent tally
          renders nothing: see `proposerSentence`.
        */}
        {proposer ? (
          <p className="mt-2 max-w-[80ch] text-label text-ink">{proposer}</p>
        ) : null}
      </section>

      {log.stale && shown ? (
        <StaleNotice failure={log.failure} readAt={log.readAt} onRetry={log.reload} />
      ) : null}

      {loadError ? (
        <p className="border border-rule bg-surface px-4 py-2 text-label text-ink">{loadError}</p>
      ) : null}

      {shown ? (
        <DecisionLog
          entries={entries}
          now={now}
          variant="full"
          hasMore={hasMore}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
          meta={
            <span>
              {entries.length} of {fmtInt(shown.total)}
              {nextCursor ? ` · cursor ${nextCursor.slice(0, 12)}` : ''}
            </span>
          }
          actions={
            <Button
              onClick={() => void runVerify()}
              disabled={activeVerify.status === 'running'}
            >
              {activeVerify.status === 'running' ? 'Verifying…' : 'Verify chain'}
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
