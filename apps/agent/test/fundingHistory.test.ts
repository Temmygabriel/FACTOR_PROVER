/**
 * Funding-history pagination.
 *
 * The endpoint takes no time range — only a page number — so "walk backward from
 * the newest settlement and stop once we have gone far enough" is the ONLY
 * termination condition available. That makes this loop's edges the interesting
 * part: getting the stop condition wrong either truncates the series silently or
 * pages forever.
 *
 * Every case stubs global `fetch`. Nothing here may reach Bitget.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FUNDING_PAGES,
  fetchFundingHistory,
} from '../src/data/fundingHistory.js';

const T = (n: number) => Date.parse('2026-06-15T00:00:00Z') + n * 8 * 3600_000;

interface WireRow {
  fundingRate: string;
  fundingTime: string;
}

function row(t: number, rate: number): WireRow {
  return { fundingTime: String(t), fundingRate: String(rate) };
}

/** A fetch that answers each page from a list, and records the URLs it saw. */
function stubPages(pages: WireRow[][]): { urls: string[] } {
  const urls: string[] = [];
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const data = pages[call] ?? [];
      call += 1;
      return { ok: true, status: 200, json: async () => ({ code: '00000', data }) };
    }),
  );
  return { urls };
}

function stubAlways(status: number): { calls: () => number } {
  const fn = vi.fn(async () => ({ ok: false, status, json: async () => ({}) }));
  vi.stubGlobal('fetch', fn);
  return { calls: () => fn.mock.calls.length };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pagination', () => {
  it('stops once a page’s OLDEST settlement is at or before earliestMs', async () => {
    // Two pages is the whole assertion: page 1's oldest (T3) is newer than
    // earliestMs (T2), so paging must continue; page 2 reaches T1 <= T2, so it
    // must stop. One extra page would mean the horizon is being ignored.
    const { urls } = stubPages([
      [row(T(4), 0.00004), row(T(3), 0.00003)],
      [row(T(2), 0.00002), row(T(1), 0.00001)],
    ]);

    const out = await fetchFundingHistory('BTCUSDT', T(2));
    expect(urls).toHaveLength(2);
    expect(out.map((r) => r.fundingTime)).toEqual([T(1), T(2), T(3), T(4)]);
  });

  it('stops on the FIRST page when that page already reaches the horizon', async () => {
    const { urls } = stubPages([[row(T(2), 0.00002), row(T(1), 0.00001)]]);
    await fetchFundingHistory('BTCUSDT', T(2));
    expect(urls).toHaveLength(1);
  });

  it('walks pages 1, 2, 3 … in order, with the measured query shape', async () => {
    // The endpoint is page-numbered; a client that resends page 1 forever would
    // loop on the same 100 rows and look like it was working.
    const { urls } = stubPages([[row(T(9), 0.1)], [row(T(8), 0.1)], [row(T(7), 0.1)], []]);
    await fetchFundingHistory('BTCUSDT', T(0));

    expect(urls[0]).toContain('pageNo=1');
    expect(urls[1]).toContain('pageNo=2');
    expect(urls[2]).toContain('pageNo=3');
    expect(urls[0]).toContain('symbol=BTCUSDT');
    expect(urls[0]).toContain('productType=usdt-futures');
    expect(urls[0]).toContain('pageSize=100');
  });

  it('stops on an empty page rather than paging on forever', async () => {
    // The end of history is signalled by an empty page, not by an error and not
    // by a row count. Without this break the loop would keep requesting pages
    // that will always be empty.
    const { urls } = stubPages([[row(T(5), 0.00005)], []]);
    const out = await fetchFundingHistory('BTCUSDT', T(0));
    expect(urls).toHaveLength(2);
    expect(out).toHaveLength(1);
  });

  it('stops at the page cap instead of paging without limit', async () => {
    // 30 pages x 100 rows = 3000 settlements = ~1000 days of 8-hourly funding,
    // far beyond any partition. The cap exists so a request that can never be
    // satisfied ends rather than looping; reaching it truncates rather than
    // throwing, and this test pins that trade-off.
    const PAGE_ROWS = 100;
    const pages: WireRow[][] = [];
    for (let p = 0; p < MAX_FUNDING_PAGES + 5; p++) {
      const page: WireRow[] = [];
      for (let k = 0; k < PAGE_ROWS; k++) {
        // Strictly older with every page, so no page ever reaches the horizon.
        page.push(row(2_000_000_000_000 - ((p * PAGE_ROWS + k) * 8 * 3600_000), 0.00001));
      }
      pages.push(page);
    }
    const { urls } = stubPages(pages);

    const out = await fetchFundingHistory('BTCUSDT', 1);
    expect(urls).toHaveLength(MAX_FUNDING_PAGES);
    expect(out).toHaveLength(MAX_FUNDING_PAGES * PAGE_ROWS);
  });
});

describe('the returned series', () => {
  it('dedupes by fundingTime', async () => {
    // Pages overlap at their boundary rows, so the same settlement arrives twice.
    // A duplicate would be counted as two observations and a settlement that
    // repeated would look twice as strong as it is.
    stubPages([
      [row(T(3), 0.00003), row(T(2), 0.00002)],
      [row(T(2), 0.00002), row(T(1), 0.00001)],
    ]);

    const out = await fetchFundingHistory('BTCUSDT', T(1));
    expect(out.map((r) => r.fundingTime)).toEqual([T(1), T(2), T(3)]);
    expect(new Set(out.map((r) => r.fundingTime)).size).toBe(out.length);
  });

  it('returns ASCENDING order even though the wire is newest-first', async () => {
    stubPages([[row(T(9), 0.9), row(T(8), 0.8)], [row(T(7), 0.7), row(T(6), 0.6)]]);
    const out = await fetchFundingHistory('BTCUSDT', T(6));
    expect(out.map((r) => r.fundingTime)).toEqual([T(6), T(7), T(8), T(9)]);
  });

  it('parses both fields to numbers, since the API sends strings', async () => {
    stubPages([[row(T(4), -0.000125)]]);
    const out = await fetchFundingHistory('BTCUSDT', T(4));
    expect(out).toEqual([{ fundingTime: T(4), fundingRate: -0.000125 }]);
    expect(typeof out[0]!.fundingTime).toBe('number');
    expect(typeof out[0]!.fundingRate).toBe('number');
    // The negative floor is real: BTC funding was measured at -0.000125.
    expect(out[0]!.fundingRate).toBeLessThan(0);
  });

  it('returns an empty array when the first page is empty', async () => {
    stubPages([[]]);
    await expect(fetchFundingHistory('BTCUSDT', T(0))).resolves.toEqual([]);
  });

  it('tolerates a response with no data field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: '00000' }) })));
    await expect(fetchFundingHistory('BTCUSDT', T(0))).resolves.toEqual([]);
  });
});

describe('failures', () => {
  it('throws after exhausting the retry attempts on a network error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    vi.stubGlobal('fetch', fn);

    await expect(fetchFundingHistory('BTCUSDT', T(0), 3)).rejects.toThrow('ECONNRESET');
    expect(fn.mock.calls.length).toBe(3);
  });

  it('does not retry when attempts is 1', async () => {
    const fn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    vi.stubGlobal('fetch', fn);
    await expect(fetchFundingHistory('BTCUSDT', T(0), 1)).rejects.toThrow('ECONNRESET');
    expect(fn.mock.calls.length).toBe(1);
  });

  it('rides out a 5xx and succeeds on the next attempt', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ code: '00000', data: [row(T(1), 0.00001)] }) };
      }),
    );

    const out = await fetchFundingHistory('BTCUSDT', T(1), 3);
    expect(call).toBe(2);
    expect(out).toHaveLength(1);
  });

  it('gives up on a 5xx once the attempts are spent', async () => {
    const { calls } = stubAlways(503);
    await expect(fetchFundingHistory('BTCUSDT', T(0), 3)).rejects.toThrow(
      /funding history HTTP 503 for BTCUSDT/,
    );
    expect(calls()).toBe(3);
  });

  it('also ends in a throw on a 4xx, after the same number of attempts', async () => {
    // NOTE ON BEHAVIOUR. The inline comment says "a 4xx will say the same thing
    // every time", and the `continue` that skips the backoff really is 5xx-only.
    // But the `throw` below it is inside the same try, so the catch block retries
    // a 4xx exactly like a 5xx — just with the 300ms/600ms backoff instead of
    // none. The outcome is correct (it ends in a throw either way); the cost is
    // three requests and ~900ms for a symbol that will never work. Asserted as
    // observed, so a future change to either behaviour is visible here.
    const { calls } = stubAlways(404);
    await expect(fetchFundingHistory('BTCUSDT', T(0), 3)).rejects.toThrow(
      /funding history HTTP 404 for BTCUSDT/,
    );
    expect(calls()).toBe(3);
  });
});
