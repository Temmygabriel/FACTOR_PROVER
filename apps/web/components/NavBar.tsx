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
import { useResource } from '@/lib/useResource';
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

  return (
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
  );
}
