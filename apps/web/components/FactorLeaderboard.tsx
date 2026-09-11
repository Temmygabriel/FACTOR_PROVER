'use client';

/**
 * The leaderboard: promoted factors AND killed hypotheses, as two tables built
 * from the same component with the same header treatment.
 *
 * This screen is where the product's framing is easiest to get wrong, so the
 * constraints are written down:
 *
 *  - BOTH SECTIONS RENDER ON LOAD. "Killed (42)" is not collapsed, not behind a
 *    tab, not below a fold and not greyed. The kills are the record; a
 *    leaderboard that only shows winners is not a research record.
 *
 *  - THE FIRST NINE COLUMNS ARE IDENTICAL — ID, signal, target, window, IC,
 *    t-statistic, p-value, BH threshold, observations. A kill carries every
 *    statistic a promote carries, because the gate evaluated it on the same
 *    five bars and the contract gives both rows the same shape. Only the last
 *    column differs, and it differs in kind rather than in status: a promoted
 *    factor has paper P&L and a decay fit because an order was placed, and a
 *    killed hypothesis has the reason the gate refused on because no order
 *    exists. A kill has no P&L to show; that is a fact about the world, not a
 *    decision about the layout.
 *
 *  - NO SECTION IS CHEAPER THAN THE OTHER. Same Panel, same 14px header, same
 *    row height, same mono figures, same stamp component.
 */

import type { ReactNode } from 'react';
import { COLUMN_TIPS, SIGNAL_PLAIN, VERDICT_MEANING, killReasonTag, killReasonTooltip, nullResultCopy } from '@/lib/copy';
import {
  fmtHalfLife,
  fmtIc,
  fmtInt,
  fmtP,
  fmtT,
  fmtThreshold,
  fmtUsdt,
  fmtWindow,
  signTone,
  targetLabel,
} from '@/lib/format';
import type { DecisionRow, PromotedFactor } from '@/lib/types';
import { hasGateEvidence, verdictForDecision, verdictForFactor } from '@/lib/verdict';
import { Panel } from './Panel';
import { Term } from './Term';
import { VerdictStamp } from './VerdictStamp';

export interface FactorLeaderboardProps {
  factors: PromotedFactor[];
  /** The API's own explanation for an empty promoted section. Used verbatim. */
  emptyReason: string | null;
  killRows: DecisionRow[];
  /** Count from session stats, so the header is right before every row is loaded. */
  killCount: number;
  attempted: number;
  fdrLevel: number;
  /** Every kill in the session is loaded; the toggle is no longer offered. */
  allKillsLoaded: boolean;
  loadingKills: boolean;
  onLoadAllKills: () => void;
  onCollapseKills: () => void;
  killPageSize: number;
}

/** A column header: technical label, plain sentence attached. */
function Th({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <th className="whitespace-nowrap px-3 py-2 text-caption font-normal text-ink-light">
      <Term tip={tip}>{children}</Term>
    </th>
  );
}

/** The nine shared columns, written once so the two tables cannot diverge. */
function SharedHead() {
  return (
    <>
      <Th tip="System-assigned identifier for the hypothesis this row is about.">ID</Th>
      <Th tip="The market signal the hypothesis was built on.">signal</Th>
      <Th tip="The tokenised equity whose forward return was predicted.">target</Th>
      <Th tip={COLUMN_TIPS.window}>window</Th>
      <Th tip={COLUMN_TIPS.ic}>IC</Th>
      <Th tip={COLUMN_TIPS.t}>t</Th>
      <Th tip={COLUMN_TIPS.p}>p</Th>
      <Th tip={COLUMN_TIPS.bh}>BH</Th>
      <Th tip={COLUMN_TIPS.obs}>obs</Th>
    </>
  );
}

const CELL = 'whitespace-nowrap px-3 py-2 font-mono text-label';
const ROW = 'border-b border-rule last:border-b-0';

export function FactorLeaderboard({
  factors,
  emptyReason,
  killRows,
  killCount,
  attempted,
  fdrLevel,
  allKillsLoaded,
  loadingKills,
  onLoadAllKills,
  onCollapseKills,
  killPageSize,
}: FactorLeaderboardProps) {
  return (
    <div className="flex flex-col gap-6">
      <Panel
        title={`Promoted factors (${factors.length})`}
        meta={<span>sorted by IC, descending</span>}
        flush
        footnote="A promoted factor is paper-tracked from the moment it clears the gate. No real funds are involved at any point, and the decay half-life is fitted from forward observations the factor could not have seen at promotion time."
      >
        {factors.length === 0 ? (
          <div className="px-4 py-3">
            {/*
              The API's `empty_reason` is used verbatim when present: the server
              knows why the section is empty (nothing run yet, everything killed,
              a schema wall) and the client does not. Only when the API offers no
              reason does the spec's null-result framing appear, filled with the
              session's real counts.
            */}
            {emptyReason ? (
              <p className="max-w-[80ch] text-label text-ink">{emptyReason}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {nullResultCopy(attempted, fdrLevel).map((line) => (
                  <p key={line} className="max-w-[80ch] text-label text-ink">
                    {line}
                  </p>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-rule">
                  <SharedHead />
                  <Th tip={COLUMN_TIPS.pnl}>paper P&amp;L</Th>
                  <Th tip={COLUMN_TIPS.decay}>half-life</Th>
                  <Th tip="Active while the factor is being paper-tracked; retired once its edge decays below the gate's bar.">
                    status
                  </Th>
                </tr>
              </thead>
              <tbody>
                {factors.map((factor) => (
                  <tr key={factor.factor_id} className={ROW}>
                    <td className={`${CELL} text-ink`}>{factor.hypothesis_id}</td>
                    <td className={CELL}>
                      <Term tip={SIGNAL_PLAIN[factor.signal] ?? factor.signal}>
                        {factor.signal}
                      </Term>
                    </td>
                    <td className={`${CELL} text-ink`}>{targetLabel(factor.target)}</td>
                    <td className={`${CELL} text-ink`}>{fmtWindow(factor.window_minutes)}</td>
                    <td className={`${CELL} ${signTone(factor.ic)}`}>{fmtIc(factor.ic)}</td>
                    <td className={`${CELL} text-ink`}>{fmtT(factor.t_stat)}</td>
                    <td className={`${CELL} text-ink`}>{fmtP(factor.raw_p_value)}</td>
                    <td className={`${CELL} text-ink`}>
                      {fmtThreshold(factor.bh_adjusted_threshold)}
                    </td>
                    <td className={`${CELL} text-ink`}>{fmtInt(factor.n_obs)}</td>
                    <td className={`${CELL} ${signTone(factor.paper_pnl_usdt)}`}>
                      {fmtUsdt(factor.paper_pnl_usdt)}
                    </td>
                    <td className={`${CELL} text-ink`}>
                      {fmtHalfLife(factor.decay_half_life_days)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {/*
                        Through lib/verdict rather than a local ternary: that
                        file is the single place a row's label is decided, and a
                        second decision site here is how this table and the log
                        start disagreeing about the same factor.
                      */}
                      <VerdictStamp verdict={verdictForFactor(factor)} size="small" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title={`Killed (${killCount})`}
        meta={
          <span>
            {killRows.length} of {killCount} shown
          </span>
        }
        actions={
          killCount > killPageSize ? (
            allKillsLoaded ? (
              <button
                type="button"
                onClick={onCollapseKills}
                className="text-label text-ink-light underline decoration-rule underline-offset-2 hover:text-ink"
              >
                Show {killPageSize}
              </button>
            ) : (
              <button
                type="button"
                onClick={onLoadAllKills}
                disabled={loadingKills}
                className="text-label text-ink-light underline decoration-rule underline-offset-2 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-light/60"
              >
                {loadingKills ? 'Loading…' : 'Show all'}
              </button>
            )
          ) : null
        }
        flush
        footnote="A killed hypothesis has no paper order, so the columns after obs hold what the gate refused on rather than a P&L. Everything else — the correlation, the t-statistic, the p-value, the threshold it had to clear and the observations it was measured on — is the same evidence the promoted table shows."
      >
        {killRows.length === 0 ? (
          <div className="px-4 py-3">
            <p className="max-w-[80ch] text-label text-ink">
              No kills recorded in this session yet. Every hypothesis the gate refuses
              appears here with the reason, at the same weight as the promoted table above.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-rule">
                  <SharedHead />
                  <Th tip="The check the gate refused on. The preregistered precedence decides which failing check is named when more than one failed.">
                    killed on
                  </Th>
                  <Th tip="Which generator tier produced the proposal. Recorded so the log stays honest about it.">
                    generator
                  </Th>
                </tr>
              </thead>
              <tbody>
                {killRows.map((row) => (
                  <tr key={row.entry_id} className={ROW}>
                    <td className={`${CELL} text-ink`}>{row.hypothesis_id}</td>
                    <td className={CELL}>
                      <Term
                        tip={
                          row.hypothesis
                            ? (SIGNAL_PLAIN[row.hypothesis.signal] ?? row.hypothesis.signal)
                            : 'No hypothesis was recorded for this entry.'
                        }
                      >
                        {row.hypothesis?.signal ?? '—'}
                      </Term>
                    </td>
                    <td className={`${CELL} text-ink`}>
                      {row.hypothesis ? targetLabel(row.hypothesis.target) : '—'}
                    </td>
                    <td className={`${CELL} text-ink`}>
                      {row.hypothesis ? fmtWindow(row.hypothesis.forward_return_minutes) : '—'}
                    </td>
                    <td className={`${CELL} ${signTone(row.metrics.ic)}`}>
                      {hasGateEvidence(row) ? fmtIc(row.metrics.ic) : '—'}
                    </td>
                    <td className={`${CELL} text-ink`}>
                      {hasGateEvidence(row) ? fmtT(row.metrics.t_stat) : '—'}
                    </td>
                    <td className={`${CELL} text-ink`}>
                      {hasGateEvidence(row) ? fmtP(row.metrics.raw_p_value) : '—'}
                    </td>
                    <td className={`${CELL} text-ink`}>
                      {hasGateEvidence(row) ? fmtThreshold(row.metrics.bh_adjusted_threshold) : '—'}
                    </td>
                    <td className={`${CELL} text-ink`}>
                      {hasGateEvidence(row) ? fmtInt(row.metrics.n_obs) : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span title={killReasonTooltip(row.reason) ?? undefined}>
                        <VerdictStamp verdict={verdictForDecision(row)} size="small" />
                      </span>
                      <span className="ml-2 text-caption text-ink-light">
                        {killReasonTag(row.reason) ?? VERDICT_MEANING[verdictForDecision(row)]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-caption text-ink-light">
                      {row.generator}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
