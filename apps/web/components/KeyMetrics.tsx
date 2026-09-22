/**
 * The key numbers, directly under the verdict (reconfiguration brief §10).
 *
 * §10 asks for "2–4 numbers that explain the result" and gives an example:
 *
 *     IC        0.0939
 *     p-value   0.0147
 *     BH bar    0.0143
 *     675       observations
 *
 * Those four are what this renders, in that order. Every one of them is a
 * measured value from the row's own `metrics`; none is derived, rounded up, or
 * computed here.
 *
 * WHY THE PRECISION IS NOT THE BRIEF'S FOUR DECIMALS. The brief's example is
 * illustrative, and this file is bound by a rule the project already wrote down:
 * `fmtThreshold` in lib/format.ts is the formatter "for a p-value wherever the
 * p-value is being COMPARED to the bar rather than listed in a column". In this
 * strip the p-value and the bar sit side by side in the same row — that IS a
 * comparison — so both sides go through `fmtThreshold`, which is also exactly
 * what the stamp's check table does two elements below. Using the brief's four
 * decimals would put the same p-value on the screen at two different precisions,
 * and would reintroduce the collision `fmtThreshold` exists to prevent: at the
 * family sizes this loop reaches, a raw p of 0.000510 and a bar of 0.000498 both
 * round to "0.0005" at four decimals, which renders a kill as "p 0.0005 did not
 * survive the bar (0.0005)" — a sentence that contradicts itself.
 *
 * IC uses `fmtIc`, not the brief's 0.0939, for the same reason pointed the other
 * way: `fmtIc` is the IC formatter everywhere else in the product, including the
 * check table below this strip, and a second IC precision on one screen is how
 * two numbers that are the same number start looking like different ones.
 *
 * WHY NOTHING HERE IS COLOURED. The panel this sits in used to colour a single
 * IC green or red by its sign. On a strip of four numbers that would pick IC out
 * as the one that matters, which it is not — p against the bar is what decided
 * this row. Colour in this product means a verdict or the sign of a number, and
 * the sign of the IC is still legible as the minus sign `fmtIc` preserves. The
 * verdict immediately above carries the only colour on this screen.
 *
 * AN UNKNOWN VALUE RENDERS AS THE HOUSE EM-DASH, NEVER AS ZERO. All three
 * formatters return `ABSENT` for a null, undefined or non-finite input, so a
 * field the backtest never filled in cannot appear here as a measured 0. The
 * caller is expected to have checked `hasGateEvidence` first — an AUTO-KILLED or
 * CIRCUIT BREAK row writes literal placeholder zeros, and this strip would print
 * them as results.
 */

import { fmtIc, fmtInt, fmtThreshold } from '@/lib/format';
import type { DecisionMetrics } from '@/lib/types';

interface Props {
  /**
   * The row's own metrics. Partial metrics are fine and expected mid-run; the
   * formatters render anything absent as `ABSENT` rather than as a zero.
   */
  metrics: Partial<DecisionMetrics>;
}

export function KeyMetrics({ metrics }: Props) {
  const rows = [
    { label: 'IC', value: fmtIc(metrics.ic) },
    { label: 'p-value', value: fmtThreshold(metrics.raw_p_value) },
    { label: 'BH bar', value: fmtThreshold(metrics.bh_adjusted_threshold) },
    { label: 'observations', value: fmtInt(metrics.n_obs) },
  ];

  return (
    /*
     * A `<dl>`, because these are label/value pairs and that is what the element
     * is for. It wraps rather than scrolling: at phone width four cells do not
     * fit on one line, and a horizontally scrolling metric strip hides the
     * comparison between the p-value and the bar, which is the one thing these
     * two numbers are here to be read against each other.
     */
    <dl className="flex flex-wrap items-baseline gap-x-10 gap-y-4 border-t border-rule pt-4">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-0.5">
          <dt className="text-caption text-ink-light">{row.label}</dt>
          {/*
            Mono at 500 — the weight the 500 in layout.tsx's IBM Plex Mono
            `weight` array exists for (brief §24). Heavier than 500 is not
            loaded and is not wanted: mono at 600+ stops reading as a measurement
            and starts reading as a code block.
          */}
          <dd className="font-mono text-metric font-medium text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
