/**
 * The live test panel: the idea in flight, the verdict it reached, and the
 * evidence in layers beneath it.
 *
 * THE ORDER IS THE REDESIGN (brief §9). The panel used to make a reader pass
 * through hypothesis fields, then metadata, then running statistics, then a BH
 * explanation, then a gate heading, before reaching the verdict — so the one
 * thing the screen exists to say arrived last. §9's order inverts that:
 *
 *     CURRENT IDEA
 *     <the question, in English>
 *     [KILLED]
 *     <the bar it fell at>
 *     IC  p-value  BH bar  observations
 *     Why was it killed?
 *     ▼ Technical evidence
 *     ▼ Idea specification
 *     ▼ Execution / research record
 *
 * The plain question and the verdict are the hero; the structured fields the
 * question was generated from are supporting material, and they sit at the
 * bottom where a reader who wants to check the sentence can find them.
 *
 * WHAT DID NOT CHANGE, AND MUST NOT. Every honesty rule this panel carried is
 * still carried:
 *
 *  - `hasGateEvidence` still gates the evidence. An AUTO-KILLED row never
 *    reached the backtest and a CIRCUIT_BREAK row's metrics are literal
 *    placeholders written by `log/decisions.ts`; both would render as a factor
 *    that was tested and scored zero. So the strip, the check table and the
 *    "why" are all withheld from those rows, and only the stamp and the fields
 *    they do have are shown.
 *  - The bar still reports the row's OWN threshold when a verdict exists and the
 *    session's rank-1 reading when it does not. One bar, from one place, so the
 *    number under "BH bar" and the number in the sentence beneath it cannot be
 *    two different thresholds under one label.
 *  - Null is still never rendered as zero. During a run the metrics are partial,
 *    and every absent field renders as the house em-dash through the formatters
 *    in lib/format.ts.
 *  - A verdict with no gate evidence still gets a second line on its stamp. The
 *    stamp falls back to `VERDICT_MEANING`, so no verdict renders thinner than
 *    another.
 *
 * WHY THE VERDICT GETS NO `reason` PROP. The stamp's second line is the verdict's
 * own definition from `VERDICT_MEANING`, and the row's specific reason with its
 * numbers is the "Why was it killed?" block immediately below. Handing the stamp
 * `killSentences` as well would print the same two sentences twice, twenty pixels
 * apart — §10 splits exactly this content across those two slots, and the split
 * is the point: a reader meets the outcome, then asks why, then gets the numbers.
 */

import {
  CHECK_ROWS,
  COLUMN_TIPS,
  OPERATOR_PLAIN,
  SIGNAL_PLAIN,
  barItMustClear,
  hypothesisQuestion,
  killReasonTechnical,
} from '@/lib/copy';
import { fmtIc, fmtInt, fmtP, fmtT, fmtWindow, targetLabel } from '@/lib/format';
import type {
  DecisionMetrics,
  DecisionRow,
  HypothesisShape,
  SessionPhase,
  SessionStats,
} from '@/lib/types';
import { verdictForDecision, hasGateEvidence } from '@/lib/verdict';
import { FieldList, FieldRow } from './Field';
import { KeyMetrics } from './KeyMetrics';
import { Panel } from './Panel';
import { TechnicalDisclosure, VerdictStamp } from './VerdictStamp';
import { WhyResult } from './WhyResult';

export interface HypothesisPanelProps {
  hypothesis: HypothesisShape | null;
  hypothesisId: string | null;
  /** Which generator tier produced this proposal, when the log reports it. */
  generator: string | null;
  /** Metrics as they exist so far. Partial during a run; never invented. */
  metrics: Partial<DecisionMetrics> | null;
  /** The decided row, when a verdict has been reached. */
  entry: DecisionRow | null;
  phase: SessionPhase | null;
  /**
   * The session's counters, for the "bar it must clear" section. Null while
   * /api/status has not answered — the section then quotes the row's own bar, or
   * does not render.
   */
  stats?: SessionStats | null;
}

/** The amber marker that says a backtest is running. Stops when it ends. */
function RunningLine() {
  return (
    <p className="flex items-center gap-2 text-label text-amber">
      <span aria-hidden="true" className="loop-pulse h-2 w-2 rounded-full bg-amber" />
      Backtest running on the discovery partition
    </p>
  );
}

function conditionText(hypothesis: HypothesisShape): string {
  const operator = OPERATOR_PLAIN[hypothesis.condition.operator] ?? hypothesis.condition.operator;
  const threshold = hypothesis.condition.threshold;
  const lookback = fmtWindow(hypothesis.condition.lookback_minutes);
  if (hypothesis.condition.operator.startsWith('pct_change')) {
    return `${operator} ${(threshold * 100).toFixed(3)}% over ${lookback}`;
  }
  return `${operator} ${threshold} over ${lookback}`;
}

export function HypothesisPanel({
  hypothesis,
  hypothesisId,
  generator,
  metrics,
  entry,
  phase,
  stats = null,
}: HypothesisPanelProps) {
  const decided = entry !== null;
  const running = phase === 'running' && hypothesis !== null && !decided;

  /*
   * The hypothesis, said in English, above the fields it was built from.
   *
   * This is a rendering of the structured fields and nothing else — see
   * `hypothesisQuestion` in lib/copy.ts. Null when there is no readable
   * hypothesis, in which case the fields below stand on their own and no
   * question is shown, because an empty question mark over a card is worse than
   * a card with no question.
   */
  const question = hypothesisQuestion(hypothesis);

  const verdict = entry ? verdictForDecision(entry) : null;
  /*
   * Whether this row has a backtest behind it. Drives the strip, the "why" and
   * the bar together, from one call, so the three cannot disagree about whether
   * this row was measured.
   */
  const evidence = entry !== null && hasGateEvidence(entry);

  /*
   * The bar, from the row's own numbers when a verdict exists and from the
   * session's when it does not.
   *
   * The two are read from different places on purpose. `bh_adjusted_threshold` is
   * this row's own bar and is what the stamp's `passed_bh` line prints, so
   * quoting anything else here would put two different thresholds under one label
   * on one screen. `current_bh_threshold_rank1` is the session's strictest bar,
   * which is the only absolute bar that can be quoted for a hypothesis whose rank
   * is not yet known.
   *
   * `ownThreshold` is withheld from a row with no gate evidence, so the bar falls
   * back to the session reading rather than to a placeholder zero — a BH bar of
   * "0.000000" under an AUTO-KILLED row would read as an impossibly strict bar
   * that the hypothesis failed, when in fact no bar was ever applied to it.
   */
  const bar = barItMustClear({
    attempted: entry
      ? entry.total_hypotheses_attempted_this_session
      : (stats?.hypotheses_attempted ?? Number.NaN),
    rank1Threshold: stats?.current_bh_threshold_rank1 ?? null,
    ownThreshold: evidence ? entry.metrics.bh_adjusted_threshold : null,
  });

  /*
   * Layer 3 (brief §11): the identity of the record this verdict was written to.
   * Strings rather than a field list, because `TechnicalDisclosure` renders them
   * as machine-readable lines and that is what they are.
   *
   * The policy version, policy hash and dataset hash are deliberately NOT
   * repeated here. They are printed on the provenance panel, which the trust
   * section links to for exactly that reason, and a second copy on this screen
   * would be a second place for them to go stale.
   */
  const identity = entry
    ? [
        `entry ${entry.entry_id}  ·  partition ${entry.partition_used}`,
        `hash ${entry.entry_hash}`,
        `prev ${entry.prev_hash}`,
        `generator ${entry.generator}  ·  recorded ${entry.timestamp_utc}`,
      ]
    : [];

  return (
    <Panel
      title="Current hypothesis"
      meta={hypothesisId ? <span>{hypothesisId}</span> : null}
      actions={running ? <RunningLine /> : null}
    >
      {!hypothesis ? (
        <div className="py-2">
          <p className="text-label text-ink">No hypothesis in flight.</p>
          <p className="mt-1 max-w-[70ch] text-caption text-ink-light">
            The loop is {phase ?? 'not reporting a phase'}. Nothing is being tested right
            now, so there is no backtest to show and no verdict owed. This panel fills in
            the moment the agent proposes the next hypothesis.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div>
            <p className="text-caption uppercase tracking-[0.08em] text-ink-light">
              Current idea
            </p>
            {question ? (
              /*
               * `text-h2` rather than the `text-heading` this sentence used to
               * be. §9 makes the plain question the hero of the screen, and it
               * was previously the same size as the field labels beneath it —
               * the hierarchy said the structured fields were the content and
               * the sentence was a caption.
               */
              <p className="mt-1 max-w-[60ch] text-h2 font-semibold text-ink">{question}</p>
            ) : null}
          </div>

          {entry && verdict ? (
            /*
             * The verdict-first branch (brief §9/§10). Everything here is
             * withheld from a row with no gate evidence, in one place, so the
             * rule is visible rather than scattered across three conditionals.
             */
            <>
              <VerdictStamp
                key={entry.entry_id}
                verdict={verdict}
                /*
                 * No `reason`, deliberately: the stamp falls back to
                 * `VERDICT_MEANING[verdict]` and the row's specific reason is the
                 * "Why?" block below. Passing `killSentences` here too would print
                 * the same sentences twice on one screen — see the header note.
                 */
                reason={null}
                metrics={evidence ? entry.metrics : null}
                checks={evidence ? entry.checks : null}
                technical={killReasonTechnical(entry)}
                size="large"
                // The five-row comparison table moves one rung down, per §9.
                checksDetail="collapsed"
                animate
              />

              {evidence ? <KeyMetrics metrics={entry.metrics} /> : null}

              {/*
                `bar={null}` for a row with no gate evidence: a schema kill is
                explained by the schema, and appending a multiple-testing
                explanation to it would explain the wrong thing.
              */}
              <WhyResult verdict={verdict} entry={entry} bar={evidence ? bar : null} />
            </>
          ) : (
            /*
             * In flight. There is no verdict yet, so there is nothing to put
             * first — the honest order is what is being tested, then the numbers
             * as they arrive, then the bar it will be judged against.
             */
            <>
              <div>
                <h3 className="mb-1 text-h3 font-semibold text-ink">
                  {decided ? 'The test that ran' : 'Running the test'}
                </h3>
                <FieldList>
                  <FieldRow
                    label="IC"
                    value={fmtIc(metrics?.ic)}
                    tip={COLUMN_TIPS.ic}
                    tone={toneFor(metrics?.ic)}
                  />
                  <FieldRow label="t-statistic" value={fmtT(metrics?.t_stat)} tip={COLUMN_TIPS.t} />
                  <FieldRow
                    label="p-value (raw)"
                    value={fmtP(metrics?.raw_p_value)}
                    tip={COLUMN_TIPS.p}
                  />
                  <FieldRow
                    label="observations"
                    value={fmtInt(metrics?.n_obs)}
                    tip={COLUMN_TIPS.obs}
                  />
                  <FieldRow
                    label="baseline IC"
                    value={fmtIc(metrics?.baseline_ic)}
                    tip={COLUMN_TIPS.baseline}
                  />
                </FieldList>
              </div>

              {/*
                The bar, between the evidence and the verdict. Read in that
                order it explains the stamp before the stamp arrives: a reader
                who has just seen a threshold tighten as the family grew is not
                surprised when the next card is killed for failing to clear it.
                Only reached while no verdict exists, so it never competes with
                the strip.
              */}
              {bar ? (
                <div>
                  <h3 className="mb-1 text-h3 font-semibold text-ink">
                    The bar it must clear
                  </h3>
                  <FieldList>
                    <FieldRow label="BH bar" value={bar.value} tip={COLUMN_TIPS.bh} />
                  </FieldList>
                  <p className="mt-2 text-caption text-ink-light">({bar.caption})</p>
                  {bar.lines.map((line, index) => (
                    <p key={index} className="mt-1 max-w-[70ch] text-label text-ink">
                      {line}
                    </p>
                  ))}
                </div>
              ) : null}

              <p className="border border-rule bg-surface px-4 py-3 text-label text-ink-light">
                No verdict yet. The gate runs after the backtest and compares the result
                against five preregistered bars:{' '}
                {Object.values(CHECK_ROWS)
                  .map((row) => row.label)
                  .join(', ')}
                .
              </p>
            </>
          )}

          {/*
            Layer 3, always — with or without a verdict, because these are the
            fields the question in the header was generated FROM. A reader who
            doubts the sentence can check it here field by field: the sentence is
            a function of exactly these values and of nothing else.
          */}
          <details className="border-t border-rule pt-3">
            <summary className="cursor-pointer text-label text-ink">
              Idea specification
            </summary>
            <div className="mt-2">
              <FieldList>
                <FieldRow
                  label="signal"
                  value={hypothesis.signal}
                  tip={SIGNAL_PLAIN[hypothesis.signal] ?? hypothesis.signal}
                />
                <FieldRow
                  label="target"
                  value={`${hypothesis.target} (${targetLabel(hypothesis.target)})`}
                  tip="A tokenised equity listed on Bitget spot. The forward return is measured on this symbol."
                />
                <FieldRow label="condition" value={conditionText(hypothesis)} />
                <FieldRow
                  label="direction"
                  value={hypothesis.direction}
                  tip="The sign of the relationship the hypothesis claims."
                />
                <FieldRow
                  label="forward window"
                  value={fmtWindow(hypothesis.forward_return_minutes)}
                  tip={COLUMN_TIPS.window}
                />
                <FieldRow
                  label="family"
                  value={hypothesis.experiment_family}
                  tip="The bounded search family this proposal belongs to. The schema wall rejects anything outside the enabled families."
                />
                {generator ? (
                  <FieldRow
                    label="generator"
                    value={generator}
                    tip="Which tier produced the proposal. Recorded so the log stays honest about it."
                  />
                ) : null}
              </FieldList>
            </div>
          </details>

          <TechnicalDisclosure summary="Execution / research record" lines={identity} />
        </div>
      )}
    </Panel>
  );
}

/** Sign colour for a single metric, from spec §3. Never the verdict's colour. */
function toneFor(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return 'text-ink';
  }
  return value > 0 ? 'text-promoted' : 'text-killed';
}
