'use client';

/**
 * The fixed top bar: wordmark, three nav items, and the loop-status chip.
 *
 * The chip reads `/api/status` on a 30s poll rather than receiving the phase
 * from a page, because it has to be present and correct on every screen —
 * including the leaderboard and the log, which read nothing else. On the run
 * view that means a second, slower poller of the same endpoint; the cost is one
 * request per 30s and the alternative is a chip that disagrees with the page
 * beneath it or is missing from two of three screens.
 *
 * The active nav item is marked with a 2px ink underline and nothing else — no
 * background, no pill, no colour (spec §7).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getStatus } from '@/lib/api';
import { sessionCounts, sessionScoreLine } from '@/lib/copy';
import { useResource } from '@/lib/useResource';
import { OrientationStrip } from './OrientationStrip';
import { StatusChip } from './StatusChip';

const NAV = [
  { href: '/', label: 'Loop' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/log', label: 'Log' },
] as const;

export function NavBar() {
  const pathname = usePathname();
  const status = useResource(getStatus, { intervalMs: 30_000 });

  // While a backtest is running the hypothesis panel is the only thing that
  // knows, so the chip pulses on the phase alone; the run view renders its own
  // chip with the finer signal.
  const phase = status.data?.phase ?? null;

  // Null until the first reading lands, and null again if the backend is asleep.
  // The span renders empty rather than with zeros: this bar is on three screens
  // and a fabricated "0 attempted" would be the most visible number in the
  // product.
  const counts = sessionCounts(status.data?.stats ?? null);
  const scoreLine = sessionScoreLine(counts);

  return (
    <>
      {/*
        The orientation strip, above the bar and on every route.

        Above rather than below, because it is the first thing a reader should
        meet and a navigation bar is not an answer to "what is this". On every
        route, because a judge who opens a shared link lands on the log or the
        leaderboard — a table of kills with no statement of how many hypotheses
        produced them — and the ratio has to arrive before the table.

        It scrolls away; only the 48px bar below it is sticky. A pinned band plus
        the bar would hold a sixth of a laptop viewport for the whole session.

        It shares this component's poll of /api/status rather than opening its
        own, so the strip and the score in the bar cannot disagree about the same
        instant.
      */}
      <OrientationStrip counts={counts} />

      <header className="sticky top-0 z-20 border-b border-rule bg-paper">
      <div className="mx-auto flex h-12 w-full max-w-[1280px] items-center justify-between gap-8 px-8">
        <div className="flex items-baseline gap-8">
          <Link
            href="/"
            className="text-label font-bold tracking-[0.08em] text-ink no-underline"
          >
            FACTOR PROVER
          </Link>
          <nav className="flex items-baseline gap-6">
            {NAV.map((item) => {
              const active =
                item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`text-label no-underline ${
                    active
                      ? 'border-b-2 border-ink pb-0.5 text-ink'
                      : 'text-ink-light hover:text-ink'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-6">
          {/*
            The session's score, carried onto every screen. A reader who lands on
            the log or the leaderboard directly — which is what a shared link
            does — otherwise meets a table of kills with no statement of how many
            hypotheses produced them, and "42 killed" on its own reads as a
            product that does not work.

            It shares the chip's poll rather than opening a second one: both read
            /api/status, and two intervals would let the ratio and the phase in
            the same bar disagree about the same instant. That makes it 30s here
            rather than the 10s the brief suggests; one request per 30s for two
            values that change once a backtest is the better trade, and on the
            loop view the panels below update from the stream regardless.

            Hidden below lg: at narrow widths the wordmark, three nav items, this
            and the chip do not fit, and a cramped bar is worse than an absent
            counter — the strip above carries the same numbers at full size, on
            every route, at every width.
          */}
          <span className="hidden font-mono text-label text-ink-light lg:inline">
            {scoreLine ?? ''}
          </span>

          {status.failure && !status.data ? (
            /*
             * The chip must not go blank when the backend is asleep, and it must
             * not claim a phase it does not know. Two honest states instead.
             */
            <span className="text-label text-ink-light">
              {status.waking ? 'Loop status: waking the backend' : 'Loop status unavailable'}
            </span>
          ) : (
            <StatusChip phase={phase} />
          )}
        </div>
      </div>
      </header>
    </>
  );
}
