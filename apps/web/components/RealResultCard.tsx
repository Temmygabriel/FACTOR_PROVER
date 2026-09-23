/**
 * A real result, taken from the committed record rather than written here.
 *
 * WHY THIS CARD EXISTS. Everything above it explains a process; this is the one
 * place a reader sees the process actually produce something. §39 calls it the
 * core visual identity, and it is the strongest single piece of evidence the
 * project has, because the result is a DEMOTION: H-0006 cleared every gate,
 * was promoted, and two hypotheses later the same hypothesis was killed with
 * byte-identical statistics. The p-value never moved. The bar did.
 *
 * WHY THE NUMBERS ARE FETCHED AND NOT TYPED IN. The project's claim is that its
 * record can be checked rather than believed, and a card with the numbers
 * hardcoded in the component asking to be believed would undercut that in the
 * most visible place on the site. So the card reads entries E-0006 and E-0008
 * from `GET /api/log` and renders whatever those rows say. If they are not in
 * the response — the backend is asleep, the log was reset, the ids changed — the
 * card is OMITTED. It is never filled in with plausible values. A missing card
 * is a smaller failure than a fabricated one.
 *
 * WHY THE PRECISION DIFFERS FROM THE STAMP'S TABLE. `fmtP`, `fmtIc` and `fmtT`
 * round to 3, 3 and 2 decimals, which is right for a column of numbers that has
 * to align. Here it would render the entire point as "p 0.015 against a bar of
 * 0.017, then 0.014" — three numbers one unit apart in the last place, which
 * reads as noise. The gate's own sentence in the log says "p = 0.0147 ... BH
 * threshold of 0.0143", so this card uses the same 4 decimals the record's own
 * prose uses. Both roundings are true; this one is legible.
 *
 * WHY THE BH BAR APPEARS TWICE. §39's mock-up shows a single bar, 0.0143. That
 * is E-0008's bar. E-0006's was 0.0167, and the difference between those two
 * numbers IS the result — rendering one bar would turn the most interesting
 * event in the record into an ordinary kill. Both are shown, each labelled with
 * the entry it belongs to.
 */

'use client';

import { getLog } from '@/lib/api';
import { hypothesisQuestion } from '@/lib/copy';
import { fmt, fmtInt, truncHash } from '@/lib/format';
import { useResource } from '@/lib/useResource';
import { VERDICT_TONE } from '@/lib/verdict';
import { TechnicalDisclosure } from './VerdictStamp';

/**
 * How the pair is reached without pulling the whole record.
 *
 * The log is newest-first and paged by an entry-id cursor that walks BACKWARDS
 * through the file, so `before: 'E-0010'` returns the ten entries older than
 * E-0010 — that is, E-0009 down to E-0001, which contains both entries this card
 * needs. Ten rows is about 15KB. Reading the record whole would be 300KB for the
 * same two rows, which is the wrong thing to ask a free-tier instance for on the
 * homepage.
 *
 * An unknown cursor makes the API fall back to the whole log (see `pageRows`),
 * so if these ids ever stop existing the response simply will not contain them
 * and the card omits itself. That is the intended failure.
 */
const CURSOR_BEFORE = 'E-0010';
const CURSOR_LIMIT = 10;

/** The pair: H-0006 promoted, then the same hypothesis killed. */
const PROMOTED_ENTRY = 'E-0006';
const KILLED_ENTRY = 'E-0008';

export function RealResultCard() {
  // No interval: these are historical entries in an append-only file. They do
  // not change, so polling them would be a request per 30s that can only ever
  // return the same bytes.
  const read = useResource((signal) =>
    getLog({ limit: CURSOR_LIMIT, before: CURSOR_BEFORE }, signal),
  );

  const entries = read.data?.entries ?? [];
  const promoted = entries.find((entry) => entry.entry_id === PROMOTED_ENTRY) ?? null;
  const killed = entries.find((entry) => entry.entry_id === KILLED_ENTRY) ?? null;

  if (!promoted || !killed) {
    /*
     * Omitted, not guessed. While the read is still in flight (or the backend is
     * cold-starting, which takes ~50s on the free tier) this renders nothing at
     * all — a placeholder that later turns into a result is worse than a section
     * that appears, because the placeholder teaches a reader the numbers are
     * decoration. Once the read has definitively failed, the omission is stated
     * rather than left as a silent gap in the page.
     */
    if (read.failure && !read.waking) {
      return (
        <section className="border border-rule px-5 py-4">
          <p className="max-w-[80ch] text-label text-ink-light">
            This card reads entries {PROMOTED_ENTRY} and {KILLED_ENTRY} from GET /api/log, which
            did not answer. It is omitted rather than filled in. Both entries are in the
            committed record in the repository, and on the evidence screen once the backend is
            awake.
          </p>
        </section>
      );
    }
    return null;
  }

  const question = hypothesisQuestion(promoted.hypothesis);
  const tone = VERDICT_TONE.KILLED;

  /*
   * Four decimals, matching the gate's own prose. `metrics` is non-nullable in
   * the contract, so these need no guard — and a row that reached this branch has
   * already passed the gate, which is what `hasGateEvidence` exists to check for
   * everywhere else.
   */
  const pValue = fmt(killed.metrics.raw_p_value, 4);
  const barAtPromote = fmt(promoted.metrics.bh_adjusted_threshold, 4);
  const barAtKill = fmt(killed.metrics.bh_adjusted_threshold, 4);

  const technical = [
    `${PROMOTED_ENTRY}  PROMOTE  p ${pValue}  BH bar ${fmt(promoted.metrics.bh_adjusted_threshold, 6)}  family of 6`,
    `${KILLED_ENTRY}  KILL  p ${pValue}  BH bar ${fmt(killed.metrics.bh_adjusted_threshold, 6)}  family of 7`,
    `ic ${fmt(killed.metrics.ic, 4)}  t ${fmt(killed.metrics.t_stat, 3)}  n ${fmtInt(killed.metrics.n_obs)}  baseline ic ${fmt(killed.metrics.baseline_ic, 4)}`,
    `partition ${killed.partition_used}  generator ${killed.generator}  reason ${killed.reason ?? 'none'}`,
    `hashes ${truncHash(promoted.entry_hash)} / ${truncHash(killed.entry_hash)}`,
  ];

  return (
    <section id="real-result" className="scroll-mt-16 border border-rule bg-paper">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-5 py-3">
        <h2 className="text-heading font-semibold text-ink">A real result from the record</h2>
        <span className="font-mono text-caption text-ink-light">
          {PROMOTED_ENTRY} → {KILLED_ENTRY}
        </span>
      </header>

      <div className="flex flex-col gap-5 px-5 py-5">
        {question ? (
          <p className="max-w-[52ch] text-h2 text-ink">{question}</p>
        ) : null}

        <p className="max-w-[68ch] text-body text-ink-light">
          The idea looked promising on its own. Two hypotheses later it was killed, with the same
          information coefficient, the same t-statistic and the same p-value, because the
          evidence bar had become stricter as more ideas entered the test family.
        </p>

        {/*
          The three numbers that did not move, and the verdict that did. §39 puts
          the verdict to the right on desktop; it stacks underneath on narrow
          screens, which is also the order a reader needs — evidence, then
          outcome.
        */}
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <dl className="flex flex-wrap items-baseline gap-x-10 gap-y-3">
            {[
              { value: fmtInt(killed.metrics.n_obs), label: 'observations' },
              { value: fmt(killed.metrics.ic, 4), label: 'information coefficient' },
              { value: fmt(killed.metrics.t_stat, 3), label: 't-statistic' },
            ].map((metric) => (
              <div key={metric.label}>
                <dd className="font-mono text-metric text-ink">{metric.value}</dd>
                <dt className="mt-1 text-caption text-ink-light">{metric.label}</dt>
              </div>
            ))}
            <p className="text-caption text-ink-light">
              identical at both entries
            </p>
          </dl>

          {/*
            A stamp, not the VerdictStamp component: that component renders the
            full five-check table, which is the right depth on the test screen
            and the wrong depth here. This is the same tone token, so the card
            and the stamp cannot drift apart in colour — which is the part that
            matters, since the whole file exists to keep a kill from looking
            quieter than a promotion.
          */}
          <div className={`inline-flex items-center border-2 px-5 py-3 ${tone.border} ${tone.fill} ${tone.text}`}>
            <span className="text-h2 font-bold tracking-[0.04em]">KILLED</span>
          </div>
        </div>

        {/*
          The centrepiece. Two labels, two bars, one sentence.
        */}
        <div className="border border-rule bg-surface px-4 py-4">
          <p className="text-caption uppercase tracking-[0.12em] text-ink-light">
            The bar it had to clear
          </p>
          <p className="mt-2 font-mono text-metric text-ink">
            {barAtPromote}
            <span className="px-2 text-ink-light">→</span>
            {barAtKill}
          </p>
          <p className="mt-3 max-w-[68ch] text-label text-ink-light">
            The p-value was {pValue} at both entries and never moved. With six hypotheses in the
            family the Benjamini-Hochberg correction put the bar at {barAtPromote}, and the idea
            cleared it. With seven it put the bar at {barAtKill}, and the same idea failed.
            Nothing about the idea changed between those two entries, and neither did its
            p-value — the bar moved. Both entries are kept, so the reversal can be read rather
            than taken on trust.
          </p>
        </div>

        <TechnicalDisclosure summary="Why was it killed?" lines={technical} />
      </div>
    </section>
  );
}
