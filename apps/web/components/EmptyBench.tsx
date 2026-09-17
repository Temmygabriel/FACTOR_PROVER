/**
 * The empty bench — what the loop view shows before the first hypothesis exists.
 *
 * This screen did not exist. The brief describes adding a line above an existing
 * pre-flight checklist; there is no checklist and no empty state anywhere in the
 * app — before this file, a fresh session rendered the hypothesis panel's own
 * "no hypothesis in flight" line above a statistics panel of zeros, which is a
 * page that looks broken rather than a page that has not started.
 *
 * That matters more here than it would in most products, because the deployed
 * agent runs on a free tier with no persistent disk: the service sleeps when
 * idle and loses its in-memory session when it wakes, so a reader arriving at a
 * cold URL meets THIS screen far more often than they meet a live one. The first
 * impression is usually this one. So it has to state the thesis ("Most will
 * fail. One might not.") and offer the one action that changes the screen, rather
 * than reporting an absence.
 *
 * AN EMPTY SESSION IS NOT AN EMPTY PROJECT, and this screen is where those two
 * got confused. Its heading used to read "No hypothesis has been tested yet."
 * over a session counter of zero — while the decision table on the same page
 * listed twelve real verdicts and "201 total", and the log screen showed a
 * chain-intact badge over 201 entries. Both readings were true of different
 * things: `stats.hypotheses_attempted` counts what THIS PROCESS has attempted
 * and resets on every boot, whereas the log is read from the committed file and
 * survives the restart. On 2026-09-13 the deployed service held 201 committed
 * entries and a zero counter simultaneously. See PROGRESS.md finding 35.
 *
 * So the heading is scoped to the session, and when a committed record exists
 * the screen says how large it is and where to read it. `committedEntries` is
 * null until the log poll answers, and null is NOT rendered as zero — "not read
 * yet" and "nothing there" are different statements and this component does not
 * get to collapse them.
 *
 * THE CHECKLIST REPORTS ONLY WHAT THE SERVER SENDS. The brief's mock lists four
 * checks, one of which — "Bitget API connected" — no endpoint reports. A row with
 * a tick beside it that nothing computed is the one thing this product cannot
 * print, so that row is not here; the generator row replaces it, and it is real.
 * Each remaining row renders the field it came from, so a reader who doubts a
 * tick can go and read the same value on the provenance panel below.
 *
 * A FAILED CHECK DOES NOT DISABLE THE BUTTON. Whether an unfrozen dataset or an
 * unavailable execution path should block a session is a research decision, not
 * a rendering one, and the server accepts /api/start either way. A UI that
 * refused would be inventing a policy the gate does not have. So the failure is
 * shown, its consequence is stated, and the reader decides.
 */

import { ABSENT, fmtInt, truncHash } from '@/lib/format';
import { canStartSession } from '@/lib/phase';
import type { StatusResponse } from '@/lib/types';

interface Props {
  status: StatusResponse;
  /**
   * Entries in the committed decision log, from the same `/api/log` poll that
   * renders the table below this panel. Null means that read has not answered.
   */
  committedEntries: number | null;
  /** The control route's own answer, or its failure. Never invented here. */
  message: string | null;
}

/**
 * One pre-flight row. `ok` is null when the server reported nothing to judge —
 * which renders as an em-dash and not as a tick.
 */
interface Check {
  label: string;
  value: string;
  ok: boolean | null;
  /** Why a failure matters, shown only when the check failed. */
  consequence?: string;
}

function checks(status: StatusResponse): Check[] {
  const { provenance, execution, generator } = status;

  const partitions: Check = provenance.dataset_frozen
    ? {
        label: 'Data partitions',
        value: `frozen · ${fmtInt(provenance.frozen_files)} files · ${truncHash(
          provenance.dataset_sha256,
        )}`,
        ok: true,
      }
    : {
        label: 'Data partitions',
        value: 'not frozen — no pinned dataset hash',
        ok: false,
        consequence:
          'Hypotheses would be tested against data that is not pinned, so a result could not be reproduced from the repo afterwards.',
      };

  const policy: Check = {
    label: 'Gate policy',
    value: `${provenance.policy_version} · ${truncHash(provenance.policy_sha256)}`,
    ok: provenance.policy_version.length > 0 && provenance.policy_sha256.length > 0,
    consequence:
      'Without a policy version and hash there is no record of which thresholds a verdict was judged against.',
  };

  /*
   * `available` and `unverified` are read together. The server reports
   * `unverified` when it could not confirm the paper-trading configuration —
   * which is not the same as confirmed-absent, and collapsing the two would tell
   * a reader either that orders will execute or that they will not, when what is
   * true is that the server does not know.
   */
  const paper: Check = execution.available && !execution.unverified
    ? { label: 'Paper trading', value: execution.detail, ok: true }
    : {
        label: 'Paper trading',
        value: execution.unverified ? `unverified — ${execution.detail}` : execution.detail,
        ok: false,
        consequence: execution.unverified
          ? 'Unverified is not the same as unavailable: orders may still be refused at the execution guard. A promotion would still be recorded.'
          : 'No factor can be paper-tracked until the execution path reports available. The gate still runs, and kills and promotions are still recorded.',
      };

  const tiers = generator.tiers_live.length > 0 ? generator.tiers_live.join(', ') : ABSENT;
  const gen: Check = {
    label: 'Hypothesis generator',
    value: generator.deterministic_fallback
      ? `${tiers} · deterministic fallback`
      : tiers,
    /*
     * Always ticked when a tier is named, because the field reports which tiers
     * are LIVE rather than which were configured. An absent tier is a deployment
     * choice and the server says so itself; there is nothing here for a reader to
     * act on, and a red cross beside a working configuration would be noise.
     */
    ok: generator.tiers_live.length > 0 ? true : null,
  };

  return [partitions, policy, paper, gen];
}

function CheckRow({ check }: { check: Check }) {
  // Ink for a met check, killed red only for one that failed. The green is not
  // used: `promoted` means "this factor cleared the gate" everywhere else in the
  // product, and it is not a colour for "this setting looks fine".
  const glyph = check.ok === true ? '✓' : check.ok === false ? '✗' : ABSENT;
  const tone =
    check.ok === false ? 'text-killed' : check.ok === true ? 'text-ink' : 'text-ink-light';

  return (
    <li className="border-t border-rule py-2 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-6">
        <span className="text-label text-ink">{check.label}</span>
        <span className={`font-mono text-label ${tone}`}>
          {check.value} {glyph}
        </span>
      </div>
      {check.ok === false && check.consequence ? (
        <p className="mt-1 max-w-[80ch] text-caption text-ink-light">{check.consequence}</p>
      ) : null}
    </li>
  );
}

export function EmptyBench({ status, committedEntries, message }: Props) {
  const rows = checks(status);
  /*
   * Still needed for the copy below, which addresses the reader differently
   * depending on whether a start is possible — but it no longer gates a control.
   * Shared with the session header through `lib/phase.ts` so the two cannot
   * disagree about which phases accept a start.
   */
  const canStart = canStartSession(status.phase);
  /*
   * Zero and null are different: null is "this read has not answered", and only a
   * confirmed zero means the record is empty.
   *
   * `committed` is a plain number rather than `committedEntries` narrowed by the
   * flag, because the flag is used inside JSX and this file cannot be
   * type-checked locally — there is no `npm install` on this machine, so a
   * narrowing that TypeScript declined to carry into the branch would be a build
   * error CI catches and I could not have. `?? 0` makes `fmtInt` total.
   */
  const committed = committedEntries ?? 0;
  const hasCommitted = committed > 0;

  return (
    <section
      id="empty-bench"
      className="border border-rule bg-surface px-4 py-4"
      aria-labelledby="empty-bench-heading"
    >
      {/*
        Scoped to the session, deliberately, and unconditionally — not swapped out
        when a committed log exists. The unscoped version ("No hypothesis has been
        tested yet.") was false whenever a committed log existed, which on the
        deployed free tier is every moment after a cold start. A heading that is
        switched off a second, not-yet-arrived read would be a different version of
        the same mistake: for as long as that read is in flight, the heading would
        assert something this panel cannot know.
      */}
      <h2 id="empty-bench-heading" className="text-heading font-semibold text-ink">
        No hypothesis has been tested in this session yet.
      </h2>
      <p className="mt-1 max-w-[80ch] text-label text-ink-light">
        {canStart
          ? 'In a moment, the bench will start running them.'
          : 'The loop is running; the first hypothesis is on its way.'}
      </p>
      <p className="mt-3 text-heading text-ink">Most will fail. One might not.</p>

      {/*
        The committed record, stated rather than left implied. Without this, the
        zero in the header above reads as a claim about the project; with it, the
        reader is told there are two counts on this page and which is which.
        `committedEntries` is a required prop rather than an optional one, so a
        caller cannot quietly reintroduce the omission.
      */}
      {hasCommitted ? (
        <p className="mt-4 max-w-[80ch] border-l-2 border-rule pl-3 text-label text-ink-light">
          A previous run’s log is committed to the repository and holds{' '}
          <span className="font-mono text-ink">{fmtInt(committed)}</span> entries — the verdicts
          listed at the foot of this page, and the full record on the log screen. The counters
          above are this session’s only, and a free-tier restart is why they read zero.
        </p>
      ) : null}
      {committedEntries === null ? (
        <p className="mt-4 max-w-[80ch] border-l-2 border-rule pl-3 text-label text-ink-light">
          The committed decision log has not been read yet, so this page cannot say how large it
          is. That is not the same as its being empty.
        </p>
      ) : null}

      <div className="mt-5">
        <h3 className="text-label font-semibold text-ink">Pre-flight</h3>
        <ul className="mt-2">
          {rows.map((check) => (
            <CheckRow key={check.label} check={check} />
          ))}
        </ul>
      </div>

      {/*
        The start control used to live here, and that placement was the bug: this
        panel renders only while `hypotheses_attempted === 0`, so once the loop had
        run once and stopped there was no start control anywhere on the page. It
        now lives in the session header, which owns the loop control for every
        phase, so this panel is purely explanatory. `message` stays — the control
        route's own answer is reported next to where the control is, but a result
        that arrived while this panel was on screen still belongs on it.
      */}
      {message ? (
        <div className="mt-5">
          <p className="text-label text-ink">{message}</p>
        </div>
      ) : null}

      {canStart ? (
        <p className="mt-3 max-w-[80ch] text-caption text-ink-light">
          The loop proposes hypotheses, backtests each one on the frozen DISCOVERY partition, and
          passes it to the gate. Nothing is promoted on a hunch — a hypothesis clears the gate or
          it is killed, and both outcomes are written to the decision log.
        </p>
      ) : null}
    </section>
  );
}
