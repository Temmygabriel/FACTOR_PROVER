/**
 * "Why was it killed?" — the sentence that turns a verdict into a result
 * (reconfiguration brief §10).
 *
 * §9's ladder puts a "Why?" rung after the numbers, and §10 gives its shape:
 * plain question, then the reason in English, with the technical vocabulary —
 * "Benjamini-Hochberg" — available underneath a disclosure rather than being the
 * first sentence. The sentences come from `killSentences` in lib/copy.ts, built
 * from the row's own numbers, so this component authors no copy of its own and
 * cannot drift from the reason code the gate actually recorded.
 *
 * WHY THIS IS VISIBLE AND NOT BEHIND A DISCLOSURE. §9 draws "Why was it killed?"
 * with a ▼ beside it, which would make it expanded-on-click. It is rendered open
 * here instead, and that is a deliberate departure. VerdictStamp's own header
 * argues the case: most hypotheses are killed, so a kill has to read as a RESULT
 * rather than as an error, an absence, or a dimmed row. A kill whose explanation
 * is behind a click reads as an error with no explanation — which is the exact
 * failure the rest of this screen is built to avoid. The genuinely technical
 * material is what goes behind the disclosures, and §10 says so: the phrase
 * "Benjamini-Hochberg" belongs there, not this sentence.
 *
 * WHEN THERE IS NOTHING TO ADD, THIS RENDERS NOTHING. `killSentences` returns an
 * empty array for a CIRCUIT_BREAK row, whose metrics are placeholders rather than
 * measurements, and for a kill with no reason recorded. Those rows keep their
 * second line from the stamp's own `VERDICT_MEANING` fallback, and repeating that
 * definition under a "Why?" heading directly below it would be a heading over a
 * restatement of the line above.
 *
 * WHY THE BAR IS PROSE HERE AND NOT A NUMBER. The bar's value is one of the four
 * figures in the KeyMetrics strip a few pixels above this block, and printing it
 * again under its own label would put one threshold on the screen twice under two
 * headings. So this renders only what the strip cannot: which bar it was, and why
 * it sits where it does. The caller passes `bar={null}` for a row that has no
 * gate evidence, because a schema kill is explained by the schema and appending a
 * multiple-testing explanation to it would explain the wrong thing.
 */

import { type BarStatement, killSentences } from '@/lib/copy';
import type { DecisionRow } from '@/lib/types';
import type { Verdict } from '@/lib/verdict';

interface Props {
  verdict: Verdict;
  /** The decided row. Already through `hasGateEvidence` at the call site. */
  entry: DecisionRow;
  /**
   * The bar this row was judged against, from `barItMustClear`. Null for a row
   * with no gate evidence — see the header note.
   */
  bar: BarStatement | null;
}

/**
 * The heading is the question the reader actually has, and it differs by
 * verdict. A promotion asked "why did it pass?" is the same question as a kill's
 * and gets the same treatment — a promote is not handed a vaguer explanation than
 * a kill, which is the equal-weight rule from lib/verdict.ts carried into copy.
 *
 * RETIRED and CIRCUIT BREAK are worded for what they are rather than folded into
 * the kill language: a retired factor was promoted and decayed, and a circuit
 * break is a halt of the loop, not a verdict on a factor at all.
 */
const WHY_HEADING: Record<Verdict, string> = {
  PROMOTED: 'Why did it pass?',
  KILLED: 'Why was it killed?',
  'AUTO-KILLED': 'Why was it killed?',
  RETIRED: 'Why was it retired?',
  'CIRCUIT BREAK': 'Why did the loop halt?',
};

export function WhyResult({ verdict, entry, bar }: Props) {
  const sentences = killSentences(entry);
  if (sentences.length === 0 && !bar) return null;

  return (
    <div className="border-t border-rule pt-4">
      <h3 className="text-h3 font-semibold text-ink">{WHY_HEADING[verdict]}</h3>

      {sentences.map((sentence, index) => (
        <p key={index} className="mt-2 max-w-[70ch] text-body text-ink">
          {sentence}
        </p>
      ))}

      {bar ? (
        /*
         * The bar's own explanation, and deliberately not its value — that is a
         * cell in the strip above. It carries no `COLUMN_TIPS.bh` tooltip either:
         * that tooltip's text is what `bar.lines` already says in a full sentence,
         * and having both would be the same explanation twice.
         */
        <div className="mt-3">
          <p className="text-caption text-ink-light">({bar.caption})</p>
          {bar.lines.map((line, index) => (
            <p key={index} className="mt-1 max-w-[70ch] text-label text-ink-light">
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
