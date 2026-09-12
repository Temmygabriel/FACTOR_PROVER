/**
 * The hero panel: the hypothesis in flight, the numbers the backtest produced,
 * and the stamp.
 *
 * The layout is the spec's §6 Screen 1, read strictly top to bottom: what was
 * proposed, what the data said, then the verdict. The stamp is the largest
 * element on the screen in both outcomes — the panel has no branch that renders
 * a kill any smaller, and the evidence block above it is rendered from the same
 * fields whether the stamp that follows says PROMOTED or KILLED.
 *
 * Two honest empty states, kept apart because they mean different things:
 *
 *  - nothing in flight (the loop is idle or paused) — "no hypothesis in flight",
 *    with no numbers pretending otherwise;
 *  - a hypothesis in flight with no verdict yet — the metrics that exist so far
 *    ARE shown, with the fields the backtest has not filled in yet marked as
 *    absent rather than shown as zero.
 */

import {
  CHECK_ROWS,
  COLUMN_TIPS,
  OPERATOR_PLAIN,
  SIGNAL_PLAIN,
  barItMustClear,
  hypothesisQuestion,
  killReasonTechnical,
  killSentences,
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
import { Panel } from './Panel';
import { VerdictStamp } from './VerdictStamp';

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
   */
  const bar = barItMustClear({
    attempted: entry
      ? entry.total_hypotheses_attempted_this_session
      : (stats?.hypotheses_attempted ?? Number.NaN),
    rank1Threshold: stats?.current_bh_threshold_rank1 ?? null,
    ownThreshold:
      entry && hasGateEvidence(entry) ? entry.metrics.bh_adjusted_threshold : null,
  });

  return (
    <Panel
      title="Current hypothesis"
      meta={hypothesisId ? <span>{hypothesisId}</span> : null}
      actions={running ? <RunningLine /> : null}
      footnote={
        entry ? (
          <span>
            Every figure above is from log entry{' '}
            <span className="font-mono">{entry.entry_id}</span> on the{' '}
            <span className="font-mono">{entry.partition_used}</span> partition, hashed as{' '}
            <span className="font-mono">{entry.entry_hash}</span>.
          </span>
        ) : null
      }
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
          {question ? (
            <p className="max-w-[70ch] text-heading font-semibold text-ink">{question}</p>
          ) : null}

          {/*
            The fields the question was built from, kept directly beneath it and
            unlabelled, because that is what they are: the question's own
            breakdown. A reader who wants to check the sentence can read it here
            field by field — the sentence is a function of exactly these values
            and of nothing else.
          */}
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

          <div>
            <h3 className="mb-1 text-heading font-semibold text-ink">Running the test</h3>
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
            The bar, between the evidence and the verdict. Read in that order it
            explains the stamp before the stamp arrives: a reader who has just
            seen a threshold tighten as the family grew is not surprised when the
            next card is killed for failing to clear it.
          */}
          {bar ? (
            <div>
              <h3 className="mb-1 text-heading font-semibold text-ink">
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

          <div>
            <h3 className="mb-2 text-heading font-semibold text-ink">Gate</h3>
            {entry ? (
              <VerdictStamp
                key={entry.entry_id}
                verdict={verdictForDecision(entry)}
                // An empty array — a circuit break, or a kill with no reason — is
                // passed through as-is: the stamp falls back to the verdict's own
                // definition, and inventing a sentence about a halted loop here
                // would be inventing a measurement.
                reason={killSentences(entry)}
                metrics={hasGateEvidence(entry) ? entry.metrics : null}
                checks={hasGateEvidence(entry) ? entry.checks : null}
                technical={killReasonTechnical(entry)}
                size="large"
                animate
              />
            ) : (
              <p className="border border-rule bg-surface px-4 py-3 text-label text-ink-light">
                No verdict yet. The gate runs after the backtest and compares the result
                against five preregistered bars:{' '}
                {Object.values(CHECK_ROWS)
                  .map((row) => row.label)
                  .join(', ')}
                .
              </p>
            )}
          </div>
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
