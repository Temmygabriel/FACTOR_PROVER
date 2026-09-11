/**
 * Spec §10: mobile is not optimised, it is declined, with a reason.
 *
 * The alternative — a stacked layout that shows three columns' worth of numbers
 * in one — would present the evidence less clearly than the product requires,
 * and the record is not something to show badly. The hackathon demo is recorded
 * on a desktop, and saying so plainly is more honest than a degraded imitation.
 */

export function MobileNotice() {
  return (
    <div className="flex min-h-screen flex-col justify-center px-6">
      <p className="text-heading font-semibold text-ink">Factor Prover is built for desktop.</p>
      <p className="mt-2 max-w-[46ch] text-label text-ink-light">
        The research record is dense: verdict stamps, gate checks, hash chains and tables
        that have to column-align. Open this on a laptop or desktop browser for the full
        experience.
      </p>
    </div>
  );
}
