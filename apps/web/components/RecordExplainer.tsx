/**
 * There are two records, and this says so.
 *
 * WHY THIS IS HERE. The demo leads with a model proposing hypotheses; this
 * screen opens on a record in which no model proposed anything. Both facts are
 * true, and the page already carried the evidence for each of them separately —
 * `generator` on every row, and `proposerSentence` reading the server's tally
 * over the whole file. What it did not carry was the sentence that puts them
 * together, and a reader who has just watched Groq propose a hypothesis and then
 * meets a page where every row says `deterministic` is one step away from the
 * wrong conclusion. This section is that step, taken out of their hands.
 *
 * WHY THE SELECTOR IS WITHHELD RATHER THAN DISABLED. A server deployed before
 * record selection existed ignores `?record=llm` and answers with the canonical
 * record — a 200 and a page of entirely true rows. `LogResponse.record` is the
 * echo that distinguishes that from a real answer, and it is absent in exactly
 * that case. So when the echo is missing this renders a control that does
 * nothing under a heading that claims it did: the reader gets the canonical
 * record under a label saying it is the model's. That is the mislabelling the
 * parameter was added to prevent, reached by the back door, and it would be
 * worse than the original problem because the page would look like it had
 * checked. The control is therefore not rendered at all, and the reason is
 * stated instead.
 *
 * WHY THE WORKED EXAMPLE NEEDS THE MODEL RECORD SELECTED, AND COSTS NO REQUEST.
 * The example is derived from the rows in hand rather than fetched. That keeps
 * this section free — the page already makes its two calls, and a third poll
 * every 30s to decorate a paragraph is the wrong thing to ask of a free-tier
 * instance. The consequence is that the strongest single demonstration the model
 * has to offer appears when the model's record is opened, which is also the one
 * place a reader is looking for it. It is never rendered from a fetch of its own
 * that might be answering about a record other than the one on screen.
 */

'use client';

import { Button } from './Button';
import {
  MODEL_PROPOSES_GATE_DECIDES,
  RECORD_COPY,
  closestBhKill,
  hypothesisQuestion,
} from '@/lib/copy';
import { fmt, truncHash } from '@/lib/format';
import { RECORD_IDS } from '@/lib/types';
import type { DecisionRow, RecordId } from '@/lib/types';
import { VERDICT_TONE } from '@/lib/verdict';

/**
 * The strongest example in the rows in hand of the model proposing and the gate
 * deciding anyway. Which row that is, and why it is chosen by rule, is
 * documented on `closestBhKill` in lib/copy.ts.
 *
 * The gate's own sentence is rendered verbatim as `row.detail`. That is the
 * point of the card: the numbers around it are formatted for legibility, but the
 * sentence explaining the verdict is the record's, not this component's. A
 * paraphrase here would be the one place on the page where the product's account
 * of its own decision replaced the decision's account of itself.
 */
function ClosestMiss({ row }: { row: DecisionRow }) {
  const question = hypothesisQuestion(row.hypothesis);
  const tone = VERDICT_TONE.KILLED;

  return (
    <div className="border border-rule bg-surface px-4 py-4">
      <p className="text-caption uppercase tracking-[0.12em] text-ink-light">
        The closest the model came
      </p>

      {question ? <p className="mt-2 max-w-[56ch] text-h3 text-ink">{question}</p> : null}

      <p className="mt-2 font-mono text-caption text-ink-light">
        {row.entry_id} · {row.hypothesis_id} · proposed by {row.generator} · entry hash{' '}
        {truncHash(row.entry_hash)}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3">
        <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <div>
            <dd className="font-mono text-metric text-ink">{fmt(row.metrics.raw_p_value, 4)}</dd>
            <dt className="mt-1 text-caption text-ink-light">p-value the model’s idea reached</dt>
          </div>
          <div>
            <dd className="font-mono text-metric text-ink">
              {fmt(row.metrics.bh_adjusted_threshold, 4)}
            </dd>
            <dt className="mt-1 text-caption text-ink-light">
              the bar the gate required at its rank
            </dt>
          </div>
        </dl>

        {/*
          The same tone token the verdict stamp and the real-result card use, so
          a kill here cannot come out quieter or louder than a kill anywhere else
          on the site.
        */}
        <span
          className={`inline-flex items-center border-2 px-4 py-2 text-h3 font-bold tracking-[0.04em] ${tone.border} ${tone.fill} ${tone.text}`}
        >
          KILLED
        </span>
      </div>

      {row.detail ? (
        <p className="mt-4 max-w-[68ch] text-label text-ink">{row.detail}</p>
      ) : null}

      <p className="mt-3 max-w-[68ch] text-caption text-ink-light">
        The model chose this question and the gate killed it on the evidence, at a bar the model
        never saw and does not set. The gate’s sentence above is quoted from the entry, not
        written here.
      </p>
    </div>
  );
}

export function RecordExplainer({
  selected,
  onSelect,
  serverCanSelect,
  rows,
}: {
  /** Which record the page is showing. */
  selected: RecordId;
  onSelect: (record: RecordId) => void;
  /**
   * Whether the server reported which record it answered with. False means an
   * instance older than record selection — see the header.
   */
  serverCanSelect: boolean;
  /** The rows of the SELECTED record that are in hand. */
  rows: DecisionRow[];
}) {
  const copy = RECORD_COPY[selected];
  const example = selected === 'llm' ? closestBhKill(rows) : null;

  return (
    <section className="border border-rule bg-paper">
      <header className="border-b border-rule px-5 py-3">
        <h2 className="text-heading font-semibold text-ink">There are two records</h2>
      </header>

      <div className="flex flex-col gap-4 px-5 py-4">
        <p className="max-w-[80ch] text-body text-ink">{MODEL_PROPOSES_GATE_DECIDES}</p>

        <p className="max-w-[80ch] text-label text-ink-light">
          Both records are committed to the repository and both are judged by the same gate. They
          are two documents because one cannot hold both facts: merged, either the canonical
          session stops being the record that exists, or the model’s session is not in a record at
          all. The chain check above runs against the record selected here, and the entry count and
          the proposer sentence below describe that record only.
        </p>

        {serverCanSelect ? (
          <div className="flex flex-wrap items-center gap-2">
            {RECORD_IDS.map((id) => (
              <Button
                key={id}
                variant={id === selected ? 'primary' : 'default'}
                aria-pressed={id === selected}
                onClick={() => onSelect(id)}
              >
                {RECORD_COPY[id].label}
              </Button>
            ))}
          </div>
        ) : (
          <p className="max-w-[80ch] border border-rule bg-surface px-3 py-2 text-label text-ink-light">
            This deployment cannot select records: the API did not report which record it answered
            with, which is how an instance deployed before record selection behaves. It would answer
            the same record either way, so the control is withheld rather than shown and ignored.
          </p>
        )}

        <div className="border-t border-rule pt-4">
          <p className="text-h3 font-semibold text-ink">{copy.title}</p>
          <p className="mt-2 max-w-[80ch] text-label text-ink-light">{copy.what}</p>
          <p className="mt-2 max-w-[80ch] text-label text-ink-light">{copy.why}</p>
          <p className="mt-3 max-w-[80ch] text-caption text-ink-light">{copy.not}</p>
        </div>

        {example ? <ClosestMiss row={example} /> : null}
      </div>
    </section>
  );
}
