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
  killReasonPlain,
} from '@/lib/copy';
import { fmtIc, fmtInt, fmtP, fmtT, fmtThreshold, fmtWindow, targetLabel } from '@/lib/format';
import type { DecisionMetrics, DecisionRow, HypothesisShape, SessionPhase } from '@/lib/types';
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
}: HypothesisPanelProps) {
  const decided = entry !== null;
  const running = phase === 'running' && hypothesis !== null && !decided;

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
            <h3 className="mb-1 text-heading font-semibold text-ink">Backtest</h3>
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
              <FieldRow
                label="BH threshold"
                value={fmtThreshold(metrics?.bh_adjusted_threshold)}
                tip={COLUMN_TIPS.bh}
              />
            </FieldList>
          </div>

          <div>
            <h3 className="mb-2 text-heading font-semibold text-ink">Gate</h3>
            {entry ? (
              <VerdictStamp
                key={entry.entry_id}
                verdict={verdictForDecision(entry)}
                reason={killReasonPlain(entry.reason) ?? entry.detail}
                metrics={hasGateEvidence(entry) ? entry.metrics : null}
                checks={hasGateEvidence(entry) ? entry.checks : null}
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
