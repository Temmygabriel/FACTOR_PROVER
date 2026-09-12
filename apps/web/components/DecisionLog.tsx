'use client';

/**
 * The decision log — every hypothesis, every gate decision, every hash.
 *
 * ONE component with two layouts, because the two screens need the same facts at
 * different densities and a second component would be where the presentation
 * drifts:
 *
 *   compact (run view) — one table row per decision.
 *   full    (log view) — the stacked entry the spec draws, with both hashes.
 *
 * The equal-weight rule applies in both: a PROMOTE row and a KILL row are the
 * same height with the same stamp, the same mono metrics and the same reason
 * column. There is no ordering that pushes kills down and no filter that hides
 * them — the log is the research record, and a record with the failures removed
 * is a different document.
 *
 * Rows are deliberately NOT clickable: the factor detail view (spec §6 Screen 4)
 * needs GET /api/factors/:id, which is listed in build spec §11 but is absent
 * from the wire contract, so a link would be a dead end dressed as navigation.
 */

import type { ReactNode } from 'react';
import {
  COLUMN_TIPS,
  VERDICT_MEANING,
  killReasonTag,
  killReasonTechnical,
  killReasonTooltip,
  killSentences,
} from '@/lib/copy';
import {
  fmtAgo,
  fmtClockUtc,
  fmtIc,
  fmtInt,
  fmtP,
  fmtT,
  fmtThreshold,
  fmtWindow,
  targetLabel,
  truncHash,
} from '@/lib/format';
import type { DecisionRow } from '@/lib/types';
import { hasGateEvidence, verdictForDecision } from '@/lib/verdict';
import { Button } from './Button';
import { Panel } from './Panel';
import { Term } from './Term';
import { TechnicalDisclosure, VerdictStamp } from './VerdictStamp';

export interface DecisionLogProps {
  entries: DecisionRow[];
  /** Passed in so every relative time on a screen is dated against one instant. */
  now: number;
  variant: 'compact' | 'full';
  /** `next_cursor` was not null — there are older entries to fetch. */
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  actions?: ReactNode;
  footnote?: ReactNode;
  meta?: ReactNode;
}

/** "btc_funding_rate → RCOIN · 4h" — the hypothesis in one line. */
function hypothesisLine(row: DecisionRow): string {
  if (!row.hypothesis) return row.detail || 'no hypothesis recorded';
  const { signal, target, forward_return_minutes } = row.hypothesis;
  return `${signal} → ${targetLabel(target)} · ${fmtWindow(forward_return_minutes)}`;
}

/**
 * The short tag for the reason column, with a fallback that is TRUE OF THE ROW
 * rather than merely convenient.
 *
 * The fallback used to be a single "cleared all five checks" for every row that
 * had gate evidence and no reason — which is exactly right for a promote and
 * flatly false for a CIRCUIT_BREAK entry, whose reason is null by construction
 * (`log/decisions.ts` writes `gate_reason: null`). A halted loop would have
 * been labelled as a factor that passed every bar, which is the one kind of
 * sentence this product cannot print.
 */
function reasonTag(row: DecisionRow): string {
  const tag = killReasonTag(row.reason);
  if (tag) return tag;
  switch (verdictForDecision(row)) {
    case 'PROMOTED':
      return 'cleared all five checks';
    case 'AUTO-KILLED':
      return 'schema';
    case 'CIRCUIT BREAK':
      return 'loop halted';
    default:
      // A gate kill always records the check it refused on, so reaching here
      // means the entry carries no reason. The cell says that rather than
      // naming a bar the row does not demonstrably clear.
      return 'no reason recorded';
  }
}

/**
 * The entry's reason as prose, with a fallback that is true of the row.
 *
 * `killSentences` states what the gate measured and what that means, in the
 * row's own numbers. It returns `[]` for the rows where there is nothing
 * truthful to say — a circuit break, whose metrics are placeholders, or a kill
 * that recorded no reason — and those fall back to the verdict's own definition
 * rather than to a sentence about a measurement that never happened.
 */
function reasonLines(row: DecisionRow): string[] {
  const sentences = killSentences(row);
  if (sentences.length > 0) return sentences;
  return [VERDICT_MEANING[verdictForDecision(row)]];
}

/**
 * The metric strip. Auto-kills have no backtest behind them and say so, and a
 * circuit-break entry is in the same position: the log writes it with zeros and
 * a placeholder `raw_p_value` of 1, so rendering its metrics would state a
 * p-value no test produced.
 */
function MetricsLine({ row }: { row: DecisionRow }) {
  if (!hasGateEvidence(row)) {
    return (
      <p className="font-mono text-caption text-ink-light">
        no backtest run · no gate evaluation · log entry written
      </p>
    );
  }
  return (
    <p className="font-mono text-caption text-ink-light">
      IC {fmtIc(row.metrics.ic)} · t {fmtT(row.metrics.t_stat)} · p{' '}
      {fmtP(row.metrics.raw_p_value)} · BH threshold{' '}
      {fmtThreshold(row.metrics.bh_adjusted_threshold)} · obs {fmtInt(row.metrics.n_obs)} ·
      baseline {fmtIc(row.metrics.baseline_ic)}
    </p>
  );
}

export function DecisionLog({
  entries,
  now,
  variant,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  actions,
  footnote,
  meta,
}: DecisionLogProps) {
  return (
    <Panel
      title="Decision log"
      meta={meta ?? <span>{entries.length} shown</span>}
      actions={actions}
      flush={variant === 'compact'}
      footnote={footnote}
    >
      {entries.length === 0 ? (
        <div className={variant === 'compact' ? 'px-4 py-3' : ''}>
          <p className="text-label text-ink">No entries yet.</p>
          <p className="mt-1 max-w-[80ch] text-caption text-ink-light">
            Every gate decision writes exactly one entry here, and the entry is hashed into
            the chain. Nothing has been decided in this session so far.
          </p>
        </div>
      ) : variant === 'compact' ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-rule">
                <th className="px-4 py-2 text-caption font-normal text-ink-light">entry</th>
                <th className="px-4 py-2 text-caption font-normal text-ink-light">
                  hypothesis
                </th>
                <th className="px-4 py-2 text-caption font-normal text-ink-light">
                  <Term tip={COLUMN_TIPS.ic}>IC</Term>
                </th>
                <th className="px-4 py-2 text-caption font-normal text-ink-light">verdict</th>
                <th className="px-4 py-2 text-caption font-normal text-ink-light">
                  <Term tip={killReasonTooltip('p_value_exceeds_bh_threshold') ?? ''}>
                    reason
                  </Term>
                </th>
                <th className="px-4 py-2 text-caption font-normal text-ink-light">when</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((row) => (
                <tr key={row.entry_id} className="border-b border-rule last:border-b-0">
                  <td className="px-4 py-2 font-mono text-label text-ink">{row.entry_id}</td>
                  <td className="px-4 py-2 font-mono text-label text-ink">
                    {hypothesisLine(row)}
                  </td>
                  <td className="px-4 py-2 font-mono text-label text-ink">
                    {hasGateEvidence(row) ? fmtIc(row.metrics.ic) : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <VerdictStamp verdict={verdictForDecision(row)} size="small" />
                  </td>
                  <td className="px-4 py-2 text-label text-ink-light">
                    <span title={killReasonTooltip(row.reason) ?? undefined}>
                      {reasonTag(row)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-caption text-ink-light">
                    {fmtAgo(row.timestamp_utc, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ol className="flex flex-col">
          {entries.map((row) => (
            <li key={row.entry_id} className="border-b border-rule px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <span className="font-mono text-label text-ink">
                  {row.entry_id} · {fmtClockUtc(row.timestamp_utc)}
                </span>
                <VerdictStamp verdict={verdictForDecision(row)} size="small" />
              </div>

              <p className="mt-1 text-label text-ink">
                {row.hypothesis_id} · {hypothesisLine(row)}
              </p>

              <div className="mt-1">
                <MetricsLine row={row} />
              </div>

              {/*
                Every entry gets a reason, including a promote, which falls back
                to the definition of its verdict. Giving only kills an
                explanatory sentence would make the promote rows the terse ones —
                a subtler version of the same bias, in the other direction.

                The sentences come from the row's own numbers, so a reader can
                check them against the metrics line directly above. A row with
                nothing truthful to say about its numbers — a circuit break, a
                kill with no reason recorded — falls back to the verdict's own
                definition rather than being handed a sentence about a
                measurement that was never taken.
              */}
              {row.schema_error ? (
                <p className="mt-1 max-w-[90ch] text-caption text-ink">
                  reason: <span className="font-mono">{row.schema_error}</span>
                </p>
              ) : (
                <>
                  {reasonLines(row).map((line, index) => (
                    <p key={index} className="mt-1 max-w-[90ch] text-label text-ink">
                      {line}
                    </p>
                  ))}
                  <TechnicalDisclosure lines={killReasonTechnical(row)} />
                </>
              )}

              <p className="mt-1 font-mono text-caption text-ink-light">
                prev:{' '}
                <span title={row.prev_hash}>{truncHash(row.prev_hash)}</span> · this:{' '}
                <span title={row.entry_hash}>{truncHash(row.entry_hash)}</span> ·{' '}
                {row.partition_used} partition · generator {row.generator}
              </p>
            </li>
          ))}
        </ol>
      )}

      {variant === 'full' && hasMore && onLoadOlder ? (
        <div className="px-4 pt-3">
          <Button onClick={onLoadOlder} disabled={loadingOlder}>
            {loadingOlder ? 'Loading…' : 'Load older'}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
