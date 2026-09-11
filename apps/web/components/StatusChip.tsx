/**
 * The loop-status chip and the phase word.
 *
 * Copy is fixed by spec §9: "Loop active" (not "Running" — the loop is active,
 * not the UI), "Loop paused" (not "Stopped" — it can resume without a reset),
 * "Circuit break" (not "Error" — a circuit break is a designed state).
 *
 * Colour mapping is spec §7: amber for active, rule grey for paused, killed red
 * for a circuit break. The circuit-break chip is the one place red is used for
 * something that is not a verdict, and it is used because a halted loop is the
 * single most important thing a reader can be told.
 */

import type { SessionPhase } from '@/lib/types';

export interface StatusChipProps {
  phase: SessionPhase | null;
  /**
   * True while a backtest is in flight. The amber dot pulses then and only then
   * — a pulse that kept going after a verdict would claim work that is not
   * happening. Stops the moment the stamp appears.
   */
  pulse?: boolean;
}

const COPY: Record<SessionPhase, string> = {
  idle: 'Loop idle',
  running: 'Loop active',
  paused: 'Loop paused',
  halted_by_circuit_breaker: 'Circuit break',
  stopped: 'Loop stopped',
  error: 'Loop error',
};

function tone(phase: SessionPhase | null): { dot: string; text: string } {
  switch (phase) {
    case 'running':
      return { dot: 'bg-amber', text: 'text-ink' };
    case 'halted_by_circuit_breaker':
    case 'error':
      return { dot: 'bg-killed', text: 'text-killed' };
    default:
      return { dot: 'bg-rule', text: 'text-ink-light' };
  }
}

export function StatusChip({ phase, pulse = false }: StatusChipProps) {
  const { dot, text } = tone(phase);
  const label = phase ? COPY[phase] : 'Loop status unknown';

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${dot} ${pulse && phase === 'running' ? 'loop-pulse' : ''}`}
      />
      <span className={`text-label ${text}`}>{label}</span>
    </span>
  );
}
