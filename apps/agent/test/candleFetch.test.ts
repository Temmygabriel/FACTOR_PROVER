/**
 * Candle fetching: backward pagination, the partition gate, and the frozen
 * short-circuit.
 *
 * The three behaviours here are the ones the data findings forced, and each is
 * easy to "simplify" back into a bug:
 *
 *   - the endpoint paginates BACKWARD and ignores startTime, so a forward walk
 *     silently returns the most recent 1000 minutes every time
 *   - the partition gate refuses a window past the END unconditionally, and
 *     admits a bounded warm-up before the START
 *   - the frozen store answers first, and reports through `frozenCandlesFor`
 *     when it cannot — never a clipped array
 *
 * All network access is stubbed. Nothing here reaches Bitget.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANDLE_LEAD_IN_MS, MINUTE_MS } from '../src/data/freezeWindow.js';
import { partitionWindow, PartitionViolation } from '../src/config.js';
import { BitgetError, __clearCandleCache, fetchCandles, frozenCandlesFor } from '../src/backtest/data.js';
import { installFrozenFixtures, type InstalledFixtures } from './helpers/frozenStore.js';

const DISCOVERY = partitionWindow('DISCOVERY');
const LOCKED_TEST = partitionWindow('LOCKED_TEST');

let installed: InstalledFixtures | null = null;

beforeEach(() => {
  __clearCandleCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __clearCandleCache();
  installed?.dispose();
  installed = null;
});

/** One candle row in the wire format: every field a string. */
function wire(ts: number, close: number): string[] {
  return [String(ts), String(close), String(close), String(close), String(close), '1', '1'];
}

interface StubResult {
  urls: string[];
  calls: () => number;
}

/** Serve each successive chunk from `chunks`, recording every URL requested. */
function stubChunks(chunks: string[][][]): StubResult {
  const urls: string[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string) => {
    urls.push(url);
    const data = chunks[i] ?? [];
    i += 1;
    return { ok: true, status: 200, json: async () => ({ code: '00000', data }) };
  });
  vi.stubGlobal('fetch', fn);
  return { urls, calls: () => fn.mock.calls.length };
}

/** A fetch that fails the test if it is ever called. */
function stubForbiddenNetwork(): { calls: () => number } {
  const fn = vi.fn(async (url: string) => {
    throw new Error(`unexpected network call: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return { calls: () => fn.mock.calls.length };
}

describe('argument checks that must run before anything else', () => {
  it('refuses an inverted or empty window', async () => {
    const net = stubForbiddenNetwork();
    await expect(fetchCandles('BTCUSDT', 1000, 1000)).rejects.toThrow(
      /endMs must be greater than startMs/,
    );
    await expect(fetchCandles('BTCUSDT', 2000, 1000)).rejects.toThrow(BitgetError);
    expect(net.calls()).toBe(0);
  });

  it('refuses a LOCKED_TEST read without the explicit flag', async () => {
    // Held-out data is inaccessible to the loop by construction; the ONLY way in
    // is a deliberate, named flag at the one manual call site.
    const net = stubForbiddenNetwork();
    await expect(
      fetchCandles('RCOINUSDT', LOCKED_TEST.startMs, LOCKED_TEST.endMs, { partition: 'LOCKED_TEST' }),
    ).rejects.toThrow(/LOCKED_TEST read requires explicit allowLockedTest/);
    expect(net.calls()).toBe(0);
  });
});

describe('the partition gate', () => {
  it('refuses a window that overruns the partition end, whatever warm-up is declared', async () => {
    const net = stubForbiddenNetwork();
    await expect(
      fetchCandles('BTCUSDT', DISCOVERY.startMs, DISCOVERY.endMs + 1, {
        partition: 'DISCOVERY',
        warmupMs: CANDLE_LEAD_IN_MS,
      }),
    ).rejects.toThrow(PartitionViolation);
    expect(net.calls()).toBe(0);
  });

  it('admits a warm-up read exactly at the declared lead-in', async () => {
    // The request is allowed through the gate, so the failure is now a network
    // failure — which is what proves the gate let it past.
    stubChunks([[]]);
    await expect(
      fetchCandles('BTCUSDT', DISCOVERY.startMs - CANDLE_LEAD_IN_MS, DISCOVERY.startMs + MINUTE_MS, {
        partition: 'DISCOVERY',
        warmupMs: CANDLE_LEAD_IN_MS,
      }),
    ).resolves.toEqual([]);
  });

  it('refuses a warm-up read beyond the declared lead-in', async () => {
    const net = stubForbiddenNetwork();
    await expect(
      fetchCandles('BTCUSDT', DISCOVERY.startMs - CANDLE_LEAD_IN_MS - 1, DISCOVERY.startMs + MINUTE_MS, {
        partition: 'DISCOVERY',
        warmupMs: CANDLE_LEAD_IN_MS,
      }),
    ).rejects.toThrow(PartitionViolation);
    expect(net.calls()).toBe(0);
  });

  it('refuses a warm-up read when no lead-in was declared at all', async () => {
    // The default is strict. A caller that forgets warmupMs gets the hard rule,
    // not a permissive one.
    const net = stubForbiddenNetwork();
    await expect(
      fetchCandles('BTCUSDT', DISCOVERY.startMs - MINUTE_MS, DISCOVERY.startMs + MINUTE_MS, {
        partition: 'DISCOVERY',
      }),
    ).rejects.toThrow(PartitionViolation);
    expect(net.calls()).toBe(0);
  });
});

describe('backward pagination', () => {
  it('walks BACKWARD from endTime, in <=1000-minute chunks', async () => {
    // The measured behaviour: the endpoint ignores startTime and returns the
    // last `limit` minutes ending at endTime. A forward walk returns the most
    // recent 1000 minutes every time, so a 52-day request yields 16 hours with
    // no error. This test pins the backward cursor.
    const endMs = DISCOVERY.startMs + 1100 * MINUTE_MS;
    const startMs = endMs - 1100 * MINUTE_MS;

    const first: string[][] = [];
    for (let k = 999; k >= 0; k--) first.push(wire(endMs - k * MINUTE_MS, 100 + k));
    const second: string[][] = [];
    for (let k = 0; k < 10; k++) second.push(wire(endMs - (1000 + k) * MINUTE_MS, 50 + k));

    // The window has to stay inside DISCOVERY for the gate to admit it, so this
    // request is made without a partition — the pagination logic is what is
    // under test here, and the gate has its own cases above.
    const { urls, calls } = stubChunks([first, second]);
    const out = await fetchCandles('BTCUSDT', startMs, endMs);

    expect(calls()).toBe(2);
    expect(urls[0]).toContain(`endTime=${endMs}`);
    // Cursor = oldest row of chunk 1, minus one minute.
    expect(urls[1]).toContain(`endTime=${endMs - 1000 * MINUTE_MS}`);
    // startTime is deliberately NOT sent: the endpoint ignores it, and sending
    // it would misrepresent what the request does.
    expect(urls[0]).not.toContain('startTime=');

    expect(out).toHaveLength(1010);
    expect(out[0]!.ts).toBe(endMs - 1009 * MINUTE_MS);
    expect(out[out.length - 1]!.ts).toBe(endMs);
  });

  it('stops after one chunk when the chunk is short', async () => {
    // A short chunk is the end of history; paging past it would request minutes
    // that do not exist.
    const endMs = DISCOVERY.startMs + 500 * MINUTE_MS;
    const { calls } = stubChunks([
      [wire(endMs, 100), wire(endMs - MINUTE_MS, 99), wire(endMs - 2 * MINUTE_MS, 98)],
      [wire(endMs - 3 * MINUTE_MS, 97)],
    ]);
    const out = await fetchCandles('BTCUSDT', endMs - 10 * MINUTE_MS, endMs);
    expect(calls()).toBe(1);
    expect(out.map((c) => c.ts)).toEqual([endMs - 2 * MINUTE_MS, endMs - MINUTE_MS, endMs]);
  });

  it('returns ascending, deduplicated candles clamped to the requested window', async () => {
    // The clamp is the guard that matters: whatever the API returns, a caller
    // must never receive a print from outside the window it asked for.
    const endMs = DISCOVERY.startMs + 500 * MINUTE_MS;
    const startMs = endMs - 3 * MINUTE_MS;
    stubChunks([
      [
        wire(endMs - 2 * MINUTE_MS, 98),
        wire(endMs + 10 * MINUTE_MS, 999), // beyond endMs — must be dropped
        wire(endMs, 100),
        wire(startMs - 10 * MINUTE_MS, 1), // before startMs — must be dropped
        wire(endMs - MINUTE_MS, 99),
        wire(endMs - 2 * MINUTE_MS, 98), // duplicate timestamp
      ],
    ]);

    const out = await fetchCandles('BTCUSDT', startMs, endMs);
    expect(out.map((c) => c.ts)).toEqual([endMs - 2 * MINUTE_MS, endMs - MINUTE_MS, endMs]);
    expect(out.map((c) => c.close)).toEqual([98, 99, 100]);
    expect(out.every((c) => c.ts >= startMs && c.ts <= endMs)).toBe(true);
  });

  it('parses the wire format into numbers', async () => {
    const endMs = DISCOVERY.startMs + 500 * MINUTE_MS;
    stubChunks([[['1751500800000', '1.5', '2.5', '0.5', '2.0', '10', '20']]]);
    const out = await fetchCandles('BTCUSDT', 1751500800000, 1751500800000 + MINUTE_MS);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      ts: 1751500800000,
      open: 1.5,
      high: 2.5,
      low: 0.5,
      close: 2,
      baseVolume: 10,
      quoteVolume: 20,
    });
    // Every field is a string on the wire; a missed Number() would leave ts as
    // a string and sort lexically, silently reordering the series.
    expect(typeof out[0]!.ts).toBe('number');
    expect(out[0]!.close).toBe(2);
  });

  it('caches by the exact window, so a second identical call does not refetch', async () => {
    const endMs = DISCOVERY.startMs + 500 * MINUTE_MS;
    const { calls } = stubChunks([[wire(endMs, 100)]]);
    await fetchCandles('BTCUSDT', endMs - MINUTE_MS, endMs);
    await fetchCandles('BTCUSDT', endMs - MINUTE_MS, endMs);
    expect(calls()).toBe(1);
  });

  it('does not serve a cached window to a different window', async () => {
    const endMs = DISCOVERY.startMs + 500 * MINUTE_MS;
    const { calls } = stubChunks([[wire(endMs, 100)], [wire(endMs - MINUTE_MS, 99)]]);
    await fetchCandles('BTCUSDT', endMs - MINUTE_MS, endMs);
    await fetchCandles('BTCUSDT', endMs - 2 * MINUTE_MS, endMs - MINUTE_MS);
    expect(calls()).toBe(2);
  });

  it('surfaces a Bitget error code rather than returning an empty series', async () => {
    // An empty array and "the exchange refused" must not look the same to the
    // caller: the first is a fact about the market, the second is a fact about
    // the request.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: '40404', msg: 'Request URL NOT FOUND' }),
      })),
    );
    await expect(fetchCandles('BTCUSDT', DISCOVERY.startMs, DISCOVERY.startMs + MINUTE_MS)).rejects.toThrow(
      /Bitget error 40404/,
    );
  });

  it('surfaces a 4xx immediately rather than burning the retries on it', async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }));
    vi.stubGlobal('fetch', fn);
    await expect(
      fetchCandles('BTCUSDT', DISCOVERY.startMs, DISCOVERY.startMs + MINUTE_MS),
    ).rejects.toThrow(/HTTP 400/);
    // Unlike the funding pager, this one rethrows a 4xx straight out of the
    // catch rather than retrying it — a client error will say the same thing
    // every time, and a schema error is not worth three requests.
    expect(fn.mock.calls.length).toBe(1);
  });
});

describe('the frozen short-circuit', () => {
  const base = DISCOVERY.startMs + 100 * MINUTE_MS;

  it('serves a DISCOVERY window from the store without touching the network', async () => {
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: [
          [base, 10],
          [base + MINUTE_MS, 11],
          [base + 2 * MINUTE_MS, 12],
        ],
      },
    ]);
    const net = stubForbiddenNetwork();

    const out = await fetchCandles('BTCUSDT', base, base + 2 * MINUTE_MS, { partition: 'DISCOVERY' });
    expect(out.map((c) => c.close)).toEqual([10, 11, 12]);
    expect(net.calls()).toBe(0);
  });

  it('clips a frozen series to the requested window', async () => {
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: [
          [base, 10],
          [base + MINUTE_MS, 11],
          [base + 2 * MINUTE_MS, 12],
        ],
      },
    ]);
    stubForbiddenNetwork();

    const out = await fetchCandles('BTCUSDT', base + MINUTE_MS, base + 2 * MINUTE_MS, {
      partition: 'DISCOVERY',
    });
    expect(out.map((c) => c.close)).toEqual([11, 12]);
  });

  it('falls through to the network when the pair was never frozen', async () => {
    // The degraded path is real and is what makes a session's provenance
    // partial. It has to keep working, and it has to be visible.
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: [[base, 10]] },
    ]);
    const { calls } = stubChunks([[wire(base + 5 * MINUTE_MS, 20)]]);

    const out = await fetchCandles('ETHUSDT', base + 5 * MINUTE_MS, base + 6 * MINUTE_MS, {
      partition: 'DISCOVERY',
    });
    expect(calls()).toBe(1);
    expect(out.map((c) => c.close)).toEqual([20]);
  });
});

describe('frozenCandlesFor', () => {
  const base = DISCOVERY.startMs + 100 * MINUTE_MS;

  it('returns null when the pair is not frozen', () => {
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: [[base, 10]] },
    ]);
    expect(frozenCandlesFor('ETHUSDT', 'DISCOVERY', base - MINUTE_MS, base)).toBeNull();
  });

  it('returns null for a WARM-UP read the file cannot serve — never a short array', () => {
    // THE DANGEROUS OUTCOME. A clipped array is a valid-looking candle list
    // missing its first minutes: `spotReturnSeries` then silently drops the
    // observations that needed them and n_obs differs from the same hypothesis
    // measured against live data. Nothing errors. So the answer is null, and the
    // caller is told the source is 'live'.
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: [[base, 10], [base + MINUTE_MS, 11]],
      },
    ]);
    const warmupStart = DISCOVERY.startMs - 100 * MINUTE_MS;
    expect(frozenCandlesFor('BTCUSDT', 'DISCOVERY', warmupStart, base + MINUTE_MS)).toBeNull();
  });

  it('serves a warm-up read when the file DOES carry the lead-in', () => {
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: [
          [DISCOVERY.startMs - CANDLE_LEAD_IN_MS, 5],
          [DISCOVERY.startMs, 6],
          [DISCOVERY.startMs + MINUTE_MS, 7],
        ],
      },
    ]);
    const out = frozenCandlesFor(
      'BTCUSDT',
      'DISCOVERY',
      DISCOVERY.startMs - CANDLE_LEAD_IN_MS,
      DISCOVERY.startMs + MINUTE_MS,
    );
    expect(out).not.toBeNull();
    expect(out!.map((c) => c.close)).toEqual([5, 6, 7]);
  });

  it('returns a short array when the shortfall is NOT a warm-up read', () => {
    // A gap at the partition boundary is an ordinary data gap: the file is the
    // best available answer and is returned as-is. Only a WARM-UP shortfall is
    // the silent-partial-read case.
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: [[base, 10]] },
    ]);
    const out = frozenCandlesFor('BTCUSDT', 'DISCOVERY', DISCOVERY.startMs, base);
    expect(out).not.toBeNull();
    expect(out!.map((c) => c.close)).toEqual([10]);
  });
});
