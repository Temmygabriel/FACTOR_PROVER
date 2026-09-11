/**
 * Provenance: which exact policy and which exact dataset every number on every
 * screen came from.
 *
 * This is a credibility feature, not a footer (the spec puts it in the detail
 * views; the brief puts it above the fold). The whole claim of the product is
 * that a verdict is reproducible, and a verdict is only reproducible if a reader
 * can name the bytes it was reached on. So the hashes are shown IN FULL here
 * rather than truncated the way log and leaderboard rows truncate them: a
 * truncated hash is a reference, and this panel is the thing being referenced.
 *
 * Every line states what its hash attests to, because a hash with no stated
 * meaning is a decoration that looks like evidence.
 */

import { fmtDateUtc, fmtIsoExact } from '@/lib/format';
import { PARTITIONS, PRESCRIBED } from '@/lib/policy';
import type { Provenance } from '@/lib/types';
import { FieldList, FieldRow } from './Field';
import { Panel } from './Panel';

/** A full hash, wrapped so a long digest cannot widen the page. */
function Hash({ value }: { value: string }) {
  return <span className="break-all font-mono text-caption text-ink">{value}</span>;
}

export function ProvenancePanel({ provenance }: { provenance: Provenance }) {
  return (
    <Panel
      title="Provenance"
      meta={
        <span>
          session {provenance.session_id} · policy {provenance.policy_version}
        </span>
      }
      fill="surface"
      footnote="Recompute any digest above from the committed files: gate_policy.json, partitions.json, and the frozen partition datasets. If a digest does not match, the numbers on this page were not produced by the configuration shown."
    >
      <div className="grid grid-cols-1 gap-x-12 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <FieldList>
            <FieldRow
              label="gate policy"
              value={`${provenance.policy_version} · locked ${fmtDateUtc(PRESCRIBED.locked_at)}`}
            />
            <FieldRow
              label="policy_sha256"
              value={<Hash value={provenance.policy_sha256} />}
              tip="Attests that the preregistered thresholds did not move. One byte changed would change this digest."
            />
            <FieldRow
              label="partitions_sha256"
              value={<Hash value={provenance.partitions_sha256} />}
              tip="Attests the discovery / validation / locked-test boundaries were the ones locked before the session began."
            />
            <FieldRow
              label="dataset_sha256"
              value={
                provenance.dataset_sha256 ? (
                  <Hash value={provenance.dataset_sha256} />
                ) : (
                  'not backed by a frozen dataset'
                )
              }
              tip="One digest over every frozen partition file the session read. Attests that the market data behind every verdict did not move either — a fixed policy over shifting data still proves nothing."
            />
          </FieldList>
          <FieldList>
            <FieldRow
              label="frozen files"
              value={
                provenance.dataset_frozen
                  ? `${provenance.frozen_files} files, frozen and hashed`
                  : `${provenance.frozen_files} files`
              }
              tip="The partition files committed to the repository. Runtime is a file read, so a session cannot reach held-out data by accident."
            />
            <FieldRow
              label="FDR level"
              value={provenance.fdr_level.toFixed(2)}
              tip="The preregistered false-discovery rate. Every threshold in the BH correction is derived from this number."
            />
            <FieldRow
              label="session started"
              value={fmtIsoExact(provenance.started_at)}
            />
          </FieldList>
        </div>

        <div className="mt-4 flex flex-col gap-4 lg:mt-0">
          <div>
            <h3 className="mb-1 text-heading font-semibold text-ink">
              Preregistered partitions
            </h3>
            <p className="mb-2 max-w-[70ch] text-caption text-ink-light">
              Read from the committed config/partitions.json ({PARTITIONS.version}); the
              digest above is what vouches for these dates. The backtest engine runs on
              discovery only, the gate evaluates on validation, and locked test is
              unreachable to the loop.
            </p>
            <FieldList>
              <FieldRow
                label="discovery"
                value={`${fmtDateUtc(PARTITIONS.discovery.start)} – ${fmtDateUtc(
                  PARTITIONS.discovery.end,
                )}`}
              />
              <FieldRow
                label="validation"
                value={`${fmtDateUtc(PARTITIONS.validation.start)} – ${fmtDateUtc(
                  PARTITIONS.validation.end,
                )}`}
              />
              <FieldRow
                label="locked test"
                value={`${fmtDateUtc(PARTITIONS.locked_test.start)} – ${fmtDateUtc(
                  PARTITIONS.locked_test.end,
                )}`}
              />
            </FieldList>
          </div>
          <p className="max-w-[70ch] text-caption text-ink-light">
            Preregistration is the point: the thresholds and the boundaries were written
            once, hashed, and are read-only for the life of the session. The generator is
            shown them so it knows what bar it proposes against, and it cannot change
            either.
          </p>
        </div>
      </div>
    </Panel>
  );
}
