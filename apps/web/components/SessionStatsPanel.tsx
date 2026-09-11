/**
 * Session statistics: what the loop has done, and what bar it is holding itself
 * to.
 *
 * Two deliberate departures from the spec's sketch of this panel:
 *
 *  - The sketch's "Est. false disc. 4.3" line is not reproduced. That number
 *    (hypotheses x FDR level) is not an estimate of anything; the FDR level is a
 *    ceiling on the PROPORTION of promoted factors that may be false, and with
 *    one promotion the arithmetic in the sketch would print a fraction of a
 *    factor. The panel states the ceiling instead. A plausible-looking statistic
 *    is worse than no statistic in a product whose claim is statistical honesty.
 *
 *  - The generator and execution blocks are printed even when they say something
 *    unflattering: which tiers are live, and whether the execution path is
 *    verified. `execution.unverified` in particular is reported as the API
 *    reports it, because claiming a verified path that is not verified is the
 *    one lie that would sink the submission.
 */

import { COLUMN_TIPS } from '@/lib/copy';
import { fmtDateUtc, fmtInt, fmtThreshold } from '@/lib/format';
import { PRESCRIBED, PARTITIONS } from '@/lib/policy';
import type { StatusResponse } from '@/lib/types';
import { FieldList, FieldRow } from './Field';
import { Panel } from './Panel';

export function SessionStatsPanel({ status }: { status: StatusResponse }) {
  const { stats, provenance, generator, execution, last_error: lastError } = status;

  return (
    <Panel
      title="Session stats"
      meta={<span>{stats.loop_iterations} iterations</span>}
      fill="surface"
      footnote={
        <span>
          Discovery window {fmtDateUtc(PARTITIONS.discovery.start)} –{' '}
          {fmtDateUtc(PARTITIONS.discovery.end)}, read from the committed
          partitions.json ({PARTITIONS.version}); policy {provenance.policy_version}, locked{' '}
          {fmtDateUtc(PRESCRIBED.locked_at)}. The digest for both is in the provenance panel.
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldList>
          <FieldRow label="hypotheses run" value={fmtInt(stats.hypotheses_attempted)} />
          <FieldRow
            label="promoted"
            value={fmtInt(stats.hypotheses_promoted)}
            tip="Factors that cleared all five checks. A session that promotes most of its hypotheses is a session whose gate is not doing anything."
          />
          <FieldRow label="killed" value={fmtInt(stats.hypotheses_killed)} />
          <FieldRow
            label="killed by the schema wall"
            value={fmtInt(stats.hypotheses_schema_rejected)}
            tip="A SUBSET of the killed count above, not a fourth category — the API computes killed as every attempt minus the promotions, so a proposal the schema wall stopped is already inside it. They never reached a backtest, so no compute was spent on them, but they still count toward the multiple-testing correction."
          />
          <FieldRow label="active factors" value={fmtInt(stats.active_factors)} />
          <FieldRow label="retired factors" value={fmtInt(stats.retired_factors)} />
        </FieldList>

        <div>
          <h3 className="mb-1 text-heading font-semibold text-ink">Gate</h3>
          <FieldList>
            <FieldRow
              label="FDR level"
              value={provenance.fdr_level.toFixed(2)}
              tip="Preregistered. Every BH threshold is derived from it and it cannot be changed mid-session."
            />
            <FieldRow
              label="BH threshold at rank 1"
              value={fmtThreshold(stats.current_bh_threshold_rank1)}
              tip={COLUMN_TIPS.bh}
            />
            <FieldRow
              label="IC floor"
              value={PRESCRIBED.min_ic.toFixed(2)}
              tip={COLUMN_TIPS.ic}
            />
            <FieldRow
              label="t-statistic floor"
              value={PRESCRIBED.min_t_stat.toFixed(2)}
              tip={COLUMN_TIPS.t}
            />
            <FieldRow
              label="observation floor"
              value={fmtInt(PRESCRIBED.min_obs)}
              tip={COLUMN_TIPS.obs}
            />
          </FieldList>
          <p className="mt-2 max-w-[70ch] text-caption text-ink-light">
            The false-discovery ceiling is {provenance.fdr_level.toFixed(2)}: at most that
            proportion of promoted factors may be false discoveries, given every hypothesis
            attempted this session is counted in the correction. That is a guarantee, not an
            estimate.
          </p>
        </div>

        <div>
          <h3 className="mb-1 text-heading font-semibold text-ink">Generator</h3>
          <FieldList>
            <FieldRow label="chain" value={generator.chain} />
            <FieldRow
              label="tiers live"
              value={generator.tiers_live.length > 0 ? generator.tiers_live.join(', ') : 'none'}
              tip="Which providers answered. The loop falls through the chain as tiers fail."
            />
            <FieldRow
              label="deterministic fallback"
              value={generator.deterministic_fallback ? 'in use' : 'not in use'}
              tip="A deterministic enumerator keeps the loop alive when every model provider is down. Hypotheses it produces are marked as such in the log."
            />
            {Object.entries(stats.generator_tiers).map(([tier, count]) => (
              <FieldRow key={tier} label={`from ${tier}`} value={fmtInt(count)} />
            ))}
          </FieldList>
        </div>

        <div>
          <h3 className="mb-1 text-heading font-semibold text-ink">Execution</h3>
          <FieldList>
            <FieldRow
              label="available"
              value={execution.available ? 'yes' : 'no'}
              tip="Whether the execution path can place a paper order at all."
            />
            <FieldRow
              label="unverified"
              value={execution.unverified ? 'yes' : 'no'}
              tip="Set when the path exists but has not been verified end to end. Reported rather than hidden."
            />
          </FieldList>
          <p className="mt-2 max-w-[70ch] text-caption text-ink-light">{execution.detail}</p>
        </div>

        {lastError ? (
          <div className="border-t border-rule pt-3">
            <h3 className="mb-1 text-heading font-semibold text-ink">Last error</h3>
            <p className="max-w-[70ch] text-caption text-ink">{lastError}</p>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
