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
 *
 *  6. The reason is a plain sentence, and the code behind it is one click away.
 *     `killSentences` in lib/copy.ts turns a reason code and the row's own
 *     numbers into English — "p 0.0312 did not survive the multiple-testing bar
 *     (0.001385)" — and `technical` carries the same row raw and signed, behind
 *     a disclosure offered on every verdict rather than on kills alone.
 */

import { CHECK_ROWS, VERDICT_MEANING } from '@/lib/copy';
import { fmt, fmtIc, fmtInt, fmtP, fmtT, fmtThreshold } from '@/lib/format';
import { CHECK_ORDER, PRESCRIBED } from '@/lib/policy';
import type { DecisionMetrics, GateChecks } from '@/lib/types';
import type { Verdict } from '@/lib/verdict';
import { VERDICT_TONE } from '@/lib/verdict';

export interface VerdictStampProps {
  verdict: Verdict;
  /**
   * Second line, plain language. Falls back to the verdict's definition.
   *
   * An array renders one paragraph per sentence, which is what `killSentences`
   * produces: a statement of what the gate measured and a statement of what that
   * means. Passed as an array rather than as one pre-joined string so the two
   * read as two thoughts instead of one long one.
   */
  reason?: string | string[] | null;
  /** The evidence the gate saw. Omitted only where the wire format has none. */
  metrics?: DecisionMetrics | null;
  /** Which of the five bars this hypothesis passed. */
  checks?: GateChecks | null;
  /**
   * Raw, signed figures for the "What does this mean?" disclosure. Supplied by
   * the caller from the row it already holds; empty or absent for a row whose
   * metrics are placeholders (`killReasonTechnical` returns `[]` there).
   */
  technical?: string[] | null;
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

/**
 * The "What does this mean?" disclosure.
 *
 * A native `<details>`, not a React state toggle, for three reasons that all
 * matter here: it works with keyboard and screen readers without a line of ARIA,
 * it survives the stamp being re-rendered by a poll, and it costs no client
 * state in a component that is rendered inside a table of hundreds of rows.
 *
 * It is exported because the log screen's full variant shows the same detail
 * outside a stamp. One component, so the two cannot drift into describing the
 * same row differently.
 *
 * The colour is inherited rather than set: inside a stamp it takes the verdict's
 * own tone, exactly like every other element in there, and outside one it takes
 * whatever the surrounding text is.
 */
export function TechnicalDisclosure({ lines }: { lines: string[] }) {
  // Self-guarding rather than trusting every caller to check: an empty
  // disclosure renders a "What does this mean?" heading over nothing, which
  // looks like a panel that failed to load. `killReasonTechnical` returns `[]`
  // for the rows this matters for, so the check belongs here where it cannot be
  // forgotten.
  if (lines.length === 0) return null;

  return (
    <details className="mt-3 border-t border-current pt-3">
      <summary className="cursor-pointer text-label">What does this mean?</summary>
      <div className="mt-2 flex flex-col gap-1 font-mono text-label">
        {lines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
    </details>
  );
}

export function VerdictStamp({
  verdict,
  reason,
  metrics,
  checks,
  technical,
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

  /*
   * Normalised to at least one line. An empty array from `killSentences` — a
   * CIRCUIT_BREAK row, or a kill with no reason recorded — falls back to the
   * verdict's own definition rather than leaving the slot empty, which is the
   * same rule as a null reason and keeps a halt from rendering thinner than a
   * kill.
   */
  const supplied = (Array.isArray(reason) ? reason : [reason]).filter(
    (line): line is string => typeof line === 'string' && line.trim().length > 0,
  );
  const secondLines = supplied.length > 0 ? supplied : [VERDICT_MEANING[verdict]];
  const detail = technical && technical.length > 0 ? technical : null;

  return (
    /*
     * The 2° tilt lives on a WRAPPER, not on the stamp itself, and that is not a
     * style preference. `.stamp-in` runs with `animation-fill-mode: both`, so its
     * final keyframe (`transform: scale(1)`) keeps applying after the 180ms are
     * over and outranks a `transform` set by a class. A `-rotate-2` on the same
     * element would therefore render as nothing on every animated verdict — a
     * detail that looks implemented and is not, which is the exact failure this
     * project spends its time hunting. Two elements, one transform each.
     *
     * The tilt is also why the stamp stays inside its parent's 32px padding: a
     * 2° rotation of a wide box adds roughly `height × sin(2°)` of horizontal
     * extent, a couple of pixels here, absorbed by the gutter rather than pushing
     * the page sideways.
     */
    <div className="-rotate-2">
      <div
        className={`${geometry.box} ${tone.border} ${tone.fill} ${tone.text} ${
          animate ? 'stamp-in' : ''
        }`}
      >
      <div className={geometry.label}>{verdict}</div>
      {secondLines.map((line, index) => (
        <p key={index} className={geometry.reason}>
          {line}
        </p>
      ))}

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

      {/*
        The disclosure, offered on a promote exactly as on a kill. The brief asks
        for it on the KILL stamp; gating it on the verdict would hand one outcome
        a depth the other does not have, which is the same bias the rest of this
        file exists to remove, just pointed the other way. It is also the honest
        placement: a reader who wants to check that a promotion's numbers are
        real needs this more than a reader looking at a kill does.
      */}
      {detail ? <TechnicalDisclosure lines={detail} /> : null}
      </div>
    </div>
  );
}
