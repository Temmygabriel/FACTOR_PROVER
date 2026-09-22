/**
 * The first thing a visitor reads.
 *
 * WHY IT REPLACES A DASHBOARD HEADER. The page used to open on the session id —
 * `Session <uuid>` as the `<h1>` — followed by a provenance hash panel and a
 * hypothesis JSON. Every one of those is a real thing this product shows, and
 * all of them are answers to questions a first-time reader has not asked yet.
 * The order is now: what this is, how it works, a real result, why to trust it,
 * and only then the live instrument. Nothing was removed; the machinery moved
 * down and the product moved up.
 *
 * The copy is the brief's §5 positioning, which is deliberately plain. The
 * project's own README calls this an autonomous factor-mining agent, and that
 * phrase is accurate and useless as a first sentence — it names the
 * implementation. "AI that tests trading ideas before they reach the market"
 * names what a reader gets.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

/**
 * §43's primary CTA, and the only place the 4px radius is used for its stated
 * purpose: a control a person presses. Ink fill, paper text, 44px tall, 20px of
 * side padding, 1px ink border, and no colour on hover beyond a darker ink —
 * §43 forbids introducing an accent, and this palette spends colour on verdicts.
 */
const PRIMARY =
  'inline-flex h-11 items-center gap-2 rounded-sm border border-ink bg-ink px-5 text-body font-medium text-paper no-underline hover:bg-[#000000] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

/** §43's secondary: transparent paper, ink border, no ghost-button blue. */
const SECONDARY =
  'inline-flex h-11 items-center gap-2 rounded-sm border border-ink bg-paper px-5 text-body font-medium text-ink no-underline hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

export function ProductHero() {
  return (
    <section className="pb-12 pt-6">
      {/*
        §38's "eyebrow / small trust line". It states the two expectations a
        reader should hold before reading anything else: this spends no real
        money, and it will show you the failures. Both are true of the deployed
        instance (paper trading throughout) and both are things a visitor to a
        trading product is right to assume the opposite of.
      */}
      <p className="text-caption uppercase tracking-[0.14em] text-ink-light">
        Paper trading only · every test recorded, including the ones that fail
      </p>

      <h1 className="mt-5 max-w-[20ch] text-hero font-semibold text-ink lg:text-hero-lg">
        AI that tests trading ideas before they reach the market.
      </h1>

      <p className="mt-6 max-w-[62ch] text-body-lg text-ink-light">
        Factor Prover generates structured trading ideas, tests them against Bitget market
        data, and applies fixed statistical rules before an idea can move forward.
      </p>

      {/*
        Both anchors are in-page and both are safe here for one specific reason:
        this component renders on `/` and nowhere else. The orientation strip
        carries a standing comment about a CTA that pointed at `#empty-bench`
        from every route and was a link to nowhere on two of them — same class of
        bug, avoided by construction rather than by discipline. If this hero is
        ever reused on another route, these targets have to move with it.
      */}
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <Link href="#live-test" className={PRIMARY}>
          Run a test
          <ArrowRight size={16} aria-hidden />
        </Link>
        <Link href="#real-result" className={SECONDARY}>
          See a real result
        </Link>
      </div>
    </section>
  );
}
