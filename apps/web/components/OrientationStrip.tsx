/**
 * The orientation strip — the first thing on every screen, and the only dark
 * element in the product.
 *
 * WHY THIS EXISTS. The product's thesis is that a kill is a result. Every other
 * screen is built to make that legible to someone already reading; this strip has
 * to make it legible to someone who has just arrived and is deciding in seconds
 * whether to keep reading. So it states the ratio before anything else, in the
 * session's own counts, and it says why the ratio is lopsided in the same breath:
 * "Most fail. That's the point." Without that second line a reader's first guess
 * at a page of kills is that something is broken.
 *
 * WHY IT SITS ABOVE THE NAV AND ON EVERY ROUTE. A judge who opens a shared link
 * lands on the log or the leaderboard, not the loop view — and those screens are
 * a table of kills with no statement of how many hypotheses produced them. The
 * ratio has to arrive before the table, on whatever screen the link pointed at.
 *
 * WHY THERE IS NO CTA. The earlier brief put a "Watch it happen live" anchor here.
 * It pointed at `#empty-bench` or `#live-hypothesis`, which exist only on the loop
 * view, so on the two other routes it was a link to nowhere — and the strip is now
 * on all three. Removed rather than made conditional: a control that silently
 * disappears depending on the route is worse than no control.
 *
 * WHY IT TAKES COUNTS AS A PROP. `NavBar` already polls `/api/status` for the
 * status chip and the nav score, and it is the component that renders this strip.
 * A second fetch here would be a second source for one number, and the two would
 * drift the moment one poll landed a beat ahead of the other — which is exactly
 * how a header ends up disagreeing with the panel beneath it.
 *
 * WHY THE COUNTERS ARE NOT ANIMATED. The redesign brief asks for a pulsing
 * arrow. The design spec reserves `animate-pulse` for the amber loop dot and says
 * so in §11, and a reserved signal stops meaning anything the moment a second
 * thing uses it — the dot's pulse is how a reader knows the loop is alive from
 * across the room. So the strip is a still surface and lets its numbers move.
 */

import { ABSENT, fmtInt } from '@/lib/format';
import type { SessionCounts } from '@/lib/copy';

interface Props {
  counts: SessionCounts | null;
}

/** "43 attempted", with the number doing the work and the word staying quiet. */
function Counter({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="font-mono text-stamp leading-none text-amber">{fmtInt(value)}</span>
      <span className="text-label text-paper/70">{label}</span>
    </span>
  );
}

export function OrientationStrip({ counts }: Props) {
  return (
    <section
      aria-label="What this product does"
      className="border-b-2 border-amber bg-ink px-8 py-5"
    >
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
        <div className="max-w-[62ch]">
          <p className="text-heading text-paper">
            Factor Prover runs trading hypotheses through a strict scientific test.
          </p>
          <p className="mt-1 text-heading font-semibold text-paper">Most fail. That’s the point.</p>
        </div>

        <div className="flex flex-col gap-3 lg:items-end">
          {counts ? (
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
              <Counter value={counts.attempted} label="attempted" />
              <Counter value={counts.passed} label="passed" />
              <Counter value={counts.killed} label="killed" />
            </div>
          ) : (
            /*
             * The house em-dash rather than zeros while the counters are in
             * flight. A zero is a number and would be read as one; the session
             * may have attempted hundreds.
             */
            <p className="font-mono text-label text-paper/70">
              {ABSENT} attempted · {ABSENT} passed · {ABSENT} killed
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
