'use client';

/**
 * The circuit breaker: its state, the counters behind it, and the manual reset.
 *
 * A breaker is only informative if a reader can see how close it is to tripping,
 * so the counters are shown against their preregistered limits rather than as
 * bare numbers — "43 of 200" is a position, "43" is trivia. The limits come from
 * gate_policy.json's `circuit_breaker` block (mirrored in lib/policy.ts) and the
 * counters from GET /api/status; neither is computed here.
 *
 * The reset is the only write this dashboard performs. The contract requires
 * `requested_by` because resuming after a trip is a deliberate human act and the
 * log has to name the human, so the button is unusable until a name is typed and
 * the response is shown verbatim underneath rather than being summarised — if the
 * reset was refused, the refusal is the interesting part.
 *
 * Bar colours are deliberately NOT the verdict palette's meaning: ink for normal,
 * amber approaching a limit, killed red at the limit. Spec §7 gives the
 * circuit-break state the killed red, and this is that state approaching.
 */

import { useState } from 'react';
import { fmtInt, fmtIsoExact } from '@/lib/format';
import { BREAKER_LIMITS } from '@/lib/policy';
import type { BreakerState, StatusResponse } from '@/lib/types';
import { Button, TextInput } from './Button';
import { FieldList, FieldRow } from './Field';
import { Panel } from './Panel';

export interface ResetOutcome {
  ok: boolean;
  detail: string;
}

export interface CircuitBreakerPanelProps {
  breaker: BreakerState | null;
  counters: StatusResponse['circuit_counters'] | null;
  /** Fire the reset. The panel owns the name field; the page owns the call. */
  onReset: (requestedBy: string) => void;
  pending: boolean;
  outcome: ResetOutcome | null;
}

function Meter({
  label,
  value,
  limit,
  tip,
}: {
  label: string;
  value: number;
  limit: number;
  tip: string;
}) {
  const ratio = limit > 0 ? Math.min(1, value / limit) : 0;
  const fill = ratio >= 1 ? 'bg-killed' : ratio >= 0.66 ? 'bg-amber' : 'bg-ink';
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-6">
        <dt className="text-label text-ink-light" title={tip}>
          {label}
        </dt>
        <dd className="font-mono text-label text-ink">
          {fmtInt(value)} of {fmtInt(limit)}
        </dd>
      </div>
      <div className="mt-1 h-1 w-full border border-rule">
        <div className={`h-full ${fill}`} style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
}

export function CircuitBreakerPanel({
  breaker,
  counters,
  onReset,
  pending,
  outcome,
}: CircuitBreakerPanelProps) {
  const [requestedBy, setRequestedBy] = useState('');
  const tripped = breaker?.tripped ?? false;

  return (
    <Panel
      title="Circuit breaker"
      meta={<span>{counters ? `counters for ${counters.day} (UTC)` : 'no counter reading'}</span>}
      footnote="The breaker halts the loop cleanly rather than letting it grind: a runaway session looks like normal operation from the inside. Daily counters reset at the UTC day boundary; a trip does not, because resuming is a decision a person has to make."
    >
      <div className="grid grid-cols-1 gap-x-12 lg:grid-cols-2">
        <div>
          {breaker ? (
            <>
              <p className="mb-2 text-label text-ink">
                {tripped ? (
                  <span className="text-killed">Tripped — the loop is halted.</span>
                ) : (
                  'Not tripped. The loop may run.'
                )}
              </p>
              <FieldList>
                <FieldRow
                  label="state"
                  value={tripped ? 'tripped' : 'closed'}
                  tip="A tripped breaker requires a manual reset. It will not clear itself overnight."
                  tone={tripped ? 'text-killed' : 'text-ink'}
                />
                <FieldRow label="reason" value={breaker.reason ?? '—'} />
                <FieldRow
                  label="tripped at"
                  value={breaker.tripped_at ? fmtIsoExact(breaker.tripped_at) : '—'}
                />
              </FieldList>
              {breaker.detail ? (
                <p className="mt-2 max-w-[70ch] text-caption text-ink-light">{breaker.detail}</p>
              ) : null}
            </>
          ) : (
            <p className="text-label text-ink-light">
              The breaker state is unavailable, because GET /api/status has not answered.
            </p>
          )}

          <div className="mt-4 border-t border-rule pt-3">
            <h3 className="text-heading font-semibold text-ink">Manual reset</h3>
            <p className="mt-1 max-w-[70ch] text-caption text-ink-light">
              Sends POST /api/reset with a name, which is recorded in the log. Whatever the
              service answers is shown here unchanged.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="text-label text-ink-light" htmlFor="requested-by">
                requested by
              </label>
              <TextInput
                id="requested-by"
                value={requestedBy}
                onChange={(event) => setRequestedBy(event.target.value)}
                placeholder="your name"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                variant="destructive"
                disabled={pending || requestedBy.trim().length === 0}
                onClick={() => onReset(requestedBy.trim())}
              >
                {pending ? 'Resetting…' : 'Reset circuit breaker'}
              </Button>
            </div>
            {outcome ? (
              <p className="mt-2 max-w-[70ch] text-label text-ink">
                {outcome.ok ? 'Reset accepted. ' : 'Reset refused. '}
                {outcome.detail}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-4 lg:mt-0">
          <h3 className="mb-1 text-heading font-semibold text-ink">Counters</h3>
          {counters ? (
            <dl className="flex flex-col">
              <Meter
                label="hypotheses today"
                value={counters.hypotheses_today}
                limit={BREAKER_LIMITS.max_hypotheses_per_day}
                tip="Every generated hypothesis counts, including kills and schema rejections. The multiple-testing correction counts them too."
              />
              <Meter
                label="promotes today"
                value={counters.promotes_today}
                limit={BREAKER_LIMITS.max_promotes_per_day}
                tip="A day that promotes ten factors is a day the gate has stopped discriminating."
              />
              <Meter
                label="paper orders today"
                value={counters.paper_orders_today}
                limit={BREAKER_LIMITS.max_paper_orders_per_day}
                tip="Orders sent to Bitget Agent Hub under --paper-trading. No real funds, but the budget is real."
              />
              <Meter
                label="consecutive LLM failures"
                value={counters.consecutive_llm_failures}
                limit={BREAKER_LIMITS.max_consecutive_llm_failures}
                tip="Resets on a success, not on a clock. Three in a row means the provider is down and the loop is generating hypotheses it cannot attribute to a model."
              />
            </dl>
          ) : (
            <p className="text-label text-ink-light">No counter reading available.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}
