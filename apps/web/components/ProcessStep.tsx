/**
 * One node of the pipeline diagram (brief §29).
 *
 * The stage name is uppercase and that is the only place in this product where a
 * non-wordmark label is: §29 grants the exception explicitly because the
 * pipeline behaves as a diagram rather than as ordinary interface chrome.
 *
 * Idle / current / completed is the whole of the state model, and it maps onto
 * §29's three colour rules without inventing a fourth:
 *
 *   idle       icon ink-light, no marker
 *   current    icon amber, with a short amber rule underneath (no glow — §29
 *              says so, and this palette has no glow anywhere)
 *   completed  icon ink, or the verdict's own tone on the last node
 *
 * The icon arrives as a ReactNode rather than as a component type. That is
 * deliberate: it keeps `lucide-react`'s own types out of this file's public
 * surface, so the caller decides the size and this component cannot silently
 * impose one.
 */

import type { ReactNode } from 'react';

export type StageState = 'idle' | 'current' | 'done';

export interface ProcessStepProps {
  /** Uppercase, per §29. */
  label: string;
  icon: ReactNode;
  explanation: string;
  state: StageState;
  /**
   * Set on the VERDICT node only. A completed stage is ink; the verdict node is
   * the one node allowed to carry a verdict colour, because it is the only node
   * that reports one.
   */
  tone?: 'promoted' | 'killed' | null;
}

export function ProcessStep({
  label,
  icon,
  explanation,
  state,
  tone = null,
}: ProcessStepProps) {
  const iconTone =
    state === 'current'
      ? 'text-amber'
      : state === 'idle'
        ? 'text-ink-light'
        : tone === 'promoted'
          ? 'text-promoted'
          : tone === 'killed'
            ? 'text-killed'
            : 'text-ink';

  const labelTone = state === 'idle' ? 'text-ink-light' : iconTone;

  return (
    <div className="flex flex-1 flex-col gap-2 px-1 py-2">
      <span className={iconTone}>{icon}</span>
      <span className={`text-caption font-semibold uppercase tracking-[0.12em] ${labelTone}`}>
        {label}
      </span>
      <span className="text-label text-ink-light">{explanation}</span>
      {/*
        The amber marker. Rendered only while the stage is current, so the five
        nodes never carry five markers and a reader can see at a glance which one
        step is happening. Height is a fixed 2px rule rather than a dot so the
        row of labels does not shift when the marker appears.
      */}
      {state === 'current' ? <span className="mt-1 h-0.5 w-8 bg-amber" /> : null}
    </div>
  );
}
