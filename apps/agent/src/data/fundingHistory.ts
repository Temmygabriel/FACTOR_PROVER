/**
 * Funding-rate history: the fetch itself.
 *
 * WHY THIS IS ITS OWN MODULE, WITH NO RELATIVE IMPORTS
 * ---------------------------------------------------
 * Two very different callers need the same pagination:
 *
 *   - src/backtest/signals.ts, at runtime, for any coin that was not frozen
 *   - scripts/prefetch.ts, once, to freeze the series into the committed dataset
 *
 * The prefetch caller is what makes this module's placement load-bearing. That
 * script runs under Node's strip-only type stripping, which does NOT rewrite
 * `./x.js` specifiers to `./x.ts`, so a module with relative imports cannot be
 * imported from scripts/ at all. Keeping this file dependency-free — it uses
 * nothing but global `fetch` and a timer — is what lets the freeze step and the
 * read step share ONE implementation.
 *
 * That matters more than it sounds. If prefetch paged funding differently from
 * the runtime path, the frozen file would be a different dataset from the one
 * the numbers were originally measured on, and every recorded `dataset_sha256`
 * would attest to data that never produced the verdict. Two copies of this
 * function is the exact failure mode; one copy is the fix.
 *
 * The pagination walks BACKWARD from the newest settlement and stops once it
 * has seen a settlement at or before `earliestMs`. The endpoint takes no time
 * range — only a page number — so "stop when we have gone far enough" is the
 * only termination condition available.
 */

/** One settlement: when it happened, and the rate that took effect. */
export interface FundingRecord {
  /** Unix ms of the settlement. */
  fundingTime: number;
  /** The rate applied from this settlement until the next one. */
  fundingRate: number;
}

/** Where frozen funding files came from. Recorded in the manifest per file. */
export const FUNDING_SOURCE = 'bitget:/api/v2/mix/market/history-fund-rate';

/**
 * Hard stop on pagination depth.
 *
 * 30 pages x 100 rows = 3000 settlements = ~1000 days of 8-hourly funding. Any
 * request reaching this is not going to be satisfied by paging further, so it
 * stops rather than looping.
 */
export const MAX_FUNDING_PAGES = 30;

const PAGE_SIZE = 100;
const BASE = 'https://api.bitget.com';

/**
 * Fetch funding settlements, newest-first on the wire, oldest-first on return.
 *
 * Returns every settlement it saw while paging back past `earliestMs`. It does
 * NOT filter the upper end: the endpoint has no way to ask for a range, so the
 * newest settlement is always whatever the exchange last published. Callers
 * that need a bounded window must clamp — `clampRowsToFreezeWindow` does that
 * for the freezer, and `fundingStepFunction` makes future settlements harmless
 * for the reader by only ever applying rates at or before the minute it is
 * evaluating.
 */
/**
 * One page of the funding-history response.
 *
 * Named rather than written inline because the assignment below used to cast
 * with `as typeof body`, which does NOT mean "the declared type of body" — at
 * that point `body` is still narrowed to the `null` it was initialised with, so
 * the cast resolved to `null` and the following `body?.data` had no property to
 * read. `tsc` rejected it; a named type is both correct and self-documenting.
 */
interface FundingPage {
  code?: string;
  data?: Array<{ fundingRate: string; fundingTime: string }>;
}

export async function fetchFundingHistory(
  symbol: string,
  earliestMs: number,
  attempts = 3,
): Promise<FundingRecord[]> {
  const out: FundingRecord[] = [];
  const seen = new Set<number>();

  for (let page = 1; page <= MAX_FUNDING_PAGES; page++) {
    const url =
      `${BASE}/api/v2/mix/market/history-fund-rate?symbol=${encodeURIComponent(symbol)}` +
      `&productType=usdt-futures&pageSize=${PAGE_SIZE}&pageNo=${page}`;

    let body: FundingPage | null = null;
    for (let a = 1; a <= attempts; a++) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) {
          // 5xx is worth retrying; a 4xx will say the same thing every time.
          if (res.status >= 500 && a < attempts) continue;
          throw new Error(`funding history HTTP ${res.status} for ${symbol}`);
        }
        body = (await res.json()) as FundingPage;
        break;
      } catch (err) {
        if (a === attempts) throw err;
        await new Promise((r) => setTimeout(r, 300 * a));
      }
    }

    const rows = body?.data ?? [];
    if (rows.length === 0) break;

    let oldest = Number.POSITIVE_INFINITY;
    for (const r of rows) {
      const t = Number(r.fundingTime);
      oldest = Math.min(oldest, t);
      if (!seen.has(t)) {
        seen.add(t);
        out.push({ fundingTime: t, fundingRate: Number(r.fundingRate) });
      }
    }
    if (oldest <= earliestMs) break;
  }

  return out.sort((a, b) => a.fundingTime - b.fundingTime);
}
