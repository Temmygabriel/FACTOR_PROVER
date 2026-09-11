'use client';

/**
 * The verdict stamp.
 *
 * Design spec §8 calls this the most important component in the product and §11
 * says to build it first, because the whole submission's framing rests on it:
 * the claim is "a statistically honest falsifiable research protocol", and most
 * hypotheses are KILLED, so a kill has to read as a RESULT rather than as an
 * error, an absence, or a dimmed row.
 *
 * HOW EQUAL WEIGHT IS ENFORCED HERE, mechanically rather than by intention:
 *
 *  1. ONE geometry table. `SIZE` is keyed on `size` only. `verdict` selects a
 *     tone and a label — never a size, a border width, a font weight, padding,
 *     opacity, order or position. There is no branch in this file that renders a
 *     promise differently from a kill. A property a promote has is a property a
 *     kill has.
 *
 *  2. ONE colour per stamp, and it is the verdict's own. Everything inside a
 *     stamp — the label, the reason line, the numbers, and the met/not-met
 *     markers — is the same tone. A green tick inside a KILLED stamp would put
 *     the hierarchy straight back, and green-for-promote / red-for-kill makes
 *     one tone a celebration and the other an alarm. Met and not-met are
 *     separated by the WORD, which is unambiguous, rather than by a second
 *     colour, which is not.
 *
 *  3. The same evidence for both. Every stamp renders five check rows, each
 *     showing the measured value AND the bar it was judged against. A promote
 *     clears all five; a kill usually does not, and the row that failed is
 *     visible as a row, not as an error.
 *
 *  4. A second line always exists. When no reason is supplied the verdict's own
 *     definition is used, so no stamp has an empty second slot that would make
 *     one verdict look thinner than another.
 *
 *  5. The rows are ordered by the preregistered `kill_reason_precedence`
 *     (config/gate_policy.json, mirrored in lib/policy.ts), which runs from "the
 *     test was not meaningful" outward to "the test was meaningful and did not
 *     clear the bar". The first failing row is therefore the reason named on the
 *     second line, and a reader can see the reason being derived instead of
 *     being told it.
 */

import { CHECK_ROWS, VERDICT_MEANING } from '@/lib/copy';
import { fmt, fmtIc, fmtInt, fmtP, fmtT, fmtThreshold } from '@/lib/format';
import { CHECK_ORDER, PRESCRIBED } from '@/lib/policy';
import type { DecisionMetrics, GateChecks } from '@/lib/types';
import type { Verdict } from '@/lib/verdict';
import { VERDICT_TONE } from '@/lib/verdict';

export interface VerdictStampProps {
  verdict: Verdict;
  /** Second line, plain language. Falls back to the verdict's definition. */
  reason?: string | null;
  /** The evidence the gate saw. Omitted only where the wire format has none. */
  metrics?: DecisionMetrics | null;
  /** Which of the five bars this hypothesis passed. */
  checks?: GateChecks | null;
  size: 'large' | 'small';
  /**
   * Animates the stamp in once: 0.85 -> 1.0 over 180ms, ease-out, no bounce.
   * The parent should key the component by entry id so a new verdict animates
   * and a re-render of the same verdict does not.
   */
  animate?: boolean;
}

/**
 * Geometry, keyed on `size` alone. There is deliberately no `border` or `fill`
 * key here: those come from VERDICT_TONE, so that a verdict can change its
 * colour and never its weight. A geometry table that carried a colour would be
 * the first place a promote and a kill could differ in more than tone.
 */
const SIZE = {
  large: {
    box: 'w-full border-2 px-6 py-5',
    label: 'text-stamp font-bold tracking-[0.04em]',
    reason: 'mt-2 text-label',
  },
  small: {
    box: 'inline-flex items-center border px-2 py-0.5',
    label: 'text-caption font-semibold tracking-[0.02em]',
    reason: '',
  },
} as const;

interface CheckRowView {
  key: keyof GateChecks;
  label: string;
  value: string;
  bar: string;
  met: boolean;
}

/**
 * The five rows, keyed by check and then emitted in the preregistered
 * precedence order taken from lib/policy.ts. The indirection is the point: the
 * order is not written out here where it could drift from the policy file, it
 * is derived from the same constant the gate's precedence is documented as.
 */
function checkRows(metrics: DecisionMetrics, checks: GateChecks): CheckRowView[] {
  const views: Record<keyof GateChecks, CheckRowView> = {
    passed_min_obs: {
      key: 'passed_min_obs',
      label: CHECK_ROWS.passed_min_obs.label,
      value: fmtInt(metrics.n_obs),
      bar: `floor ${fmtInt(PRESCRIBED.min_obs)}`,
      met: checks.passed_min_obs,
    },
    passed_ic_floor: {
      key: 'passed_ic_floor',
      label: CHECK_ROWS.passed_ic_floor.label,
      value: fmtIc(metrics.ic),
      bar: `floor ${fmt(PRESCRIBED.min_ic, 2)}`,
      met: checks.passed_ic_floor,
    },
    passed_t_stat_floor: {
      key: 'passed_t_stat_floor',
      label: CHECK_ROWS.passed_t_stat_floor.label,
      value: fmtT(metrics.t_stat),
      bar: `floor ${fmt(PRESCRIBED.min_t_stat, 2)}`,
      met: checks.passed_t_stat_floor,
    },
    passed_baseline_beat: {
      key: 'passed_baseline_beat',
      label: CHECK_ROWS.passed_baseline_beat.label,
      value: fmtIc(metrics.baseline_ic),
      bar: 'must be beaten',
      met: checks.passed_baseline_beat,
    },
    passed_bh: {
      key: 'passed_bh',
      label: CHECK_ROWS.passed_bh.label,
      value: fmtP(metrics.raw_p_value),
      bar: `BH ${fmtThreshold(metrics.bh_adjusted_threshold)}`,
      met: checks.passed_bh,
    },
  };
  return CHECK_ORDER.map((key) => views[key]);
}

export function VerdictStamp({
  verdict,
  reason,
  metrics,
  checks,
  size,
  animate = false,
}: VerdictStampProps) {
  const tone = VERDICT_TONE[verdict];
  const geometry = SIZE[size];

  if (size === 'small') {
    return (
      <span className={`${geometry.box} ${geometry.label} ${tone.border} ${tone.text}`}>
        {verdict}
      </span>
    );
  }

  const rows = metrics && checks ? checkRows(metrics, checks) : null;
  const met = rows ? rows.filter((row) => row.met).length : 0;
  const secondLine = reason ?? VERDICT_MEANING[verdict];

  return (
    <div
      className={`${geometry.box} ${tone.border} ${tone.fill} ${tone.text} ${
        animate ? 'stamp-in' : ''
      }`}
    >
      <div className={geometry.label}>{verdict}</div>
      <p className={geometry.reason}>{secondLine}</p>

      {rows ? (
        <div className="mt-5 border-t border-current pt-3">
          {/*
            Four columns: what was measured, what it came out as, what it had to
            clear, and whether it cleared. Values are right-aligned and mono so
            they column-align; the numbers are the same size and tone on every
            row, met or not.
          */}
          <div className="grid grid-cols-[8.5rem_5rem_minmax(0,1fr)_4.5rem] items-baseline gap-x-3 gap-y-1.5 font-mono text-label">
            {rows.map((row) => (
              <div key={row.key} className="contents">
                <div>{row.label}</div>
                <div className="text-right">{row.value}</div>
                <div>{row.bar}</div>
                <div className="text-right">{row.met ? 'met' : 'not met'}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 font-mono text-caption">
            {met} of {rows.length} checks met
          </div>
        </div>
      ) : null}
    </div>
  );
}
