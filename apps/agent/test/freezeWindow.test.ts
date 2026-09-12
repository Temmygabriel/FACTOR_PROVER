/**
 * The freeze-window rules.
 *
 * These are the numbers that decide how much older data each committed file
 * carries, and the guard that stops the warm-up allowance becoming a general
 * exemption from the partition rule. Both halves are load-bearing: too small a
 * lead-in sends a warm-up read to the network, and an unbounded `leadInMs` makes
 * the partition start meaningless.
 */

import { describe, expect, it } from 'vitest';
import {
  CANDLE_LEAD_IN_MS,
  FUNDING_INTERVAL_MS,
  FUNDING_LEAD_IN_MS,
  HOUR_MS,
  LeadInTooLarge,
  LOOKBACK_HEADROOM_MINUTES,
  MAX_LEAD_IN_MS,
  MAX_LOOKBACK_MINUTES,
  MINUTE_MS,
  assertLeadInBounded,
  clampRowsToFreezeWindow,
  freezeWindowFor,
  leadInForKind,
} from '../src/data/freezeWindow.js';

describe('the constants are mutually consistent', () => {
  it('derives the candle lead-in from the lookback cap, so the two cannot drift', () => {
    // The whole reason MAX_LOOKBACK_MINUTES lives in this file rather than beside
    // the schema: raising the cap must widen the lead-in automatically, or the
    // validator starts permitting a lookback the frozen data cannot warm up.
    expect(MAX_LOOKBACK_MINUTES).toBe(240);
    expect(LOOKBACK_HEADROOM_MINUTES).toBe(60);
    expect(CANDLE_LEAD_IN_MS).toBe((MAX_LOOKBACK_MINUTES + LOOKBACK_HEADROOM_MINUTES) * MINUTE_MS);
    expect(CANDLE_LEAD_IN_MS).toBe(300 * MINUTE_MS);
  });

  it('gives funding exactly one settlement interval of lead-in', () => {
    expect(FUNDING_INTERVAL_MS).toBe(8 * HOUR_MS);
    expect(FUNDING_LEAD_IN_MS).toBe(FUNDING_INTERVAL_MS);
  });

  it('sets the ceiling far above both real lead-ins, so it never binds in practice', () => {
    expect(MAX_LEAD_IN_MS).toBe(7 * 24 * HOUR_MS);
    expect(MAX_LEAD_IN_MS).toBeGreaterThan(CANDLE_LEAD_IN_MS);
    expect(MAX_LEAD_IN_MS).toBeGreaterThan(FUNDING_LEAD_IN_MS);
    // 7 days vs 5 hours — three orders of magnitude of headroom.
    expect(MAX_LEAD_IN_MS / CANDLE_LEAD_IN_MS).toBeGreaterThan(30);
  });

  it('gives funding a LONGER lead-in than candles', () => {
    // Funding is the longer of the two, and the two absolute values are pinned
    // just above — those are the assertions that actually protect the readers,
    // because each lead-in is sized for its own consumer rather than against the
    // other. Funding needs one full settlement interval (8h) so a rate is in
    // force at the first grid minute of the step function; candles need the
    // longest permitted lookback plus headroom (240 + 60 = 300 min = 5h). This
    // ordering is a consequence of those two independent requirements, not a
    // rule, so it is asserted to catch a reflexive edit to either constant — not
    // because inverting it would itself break a read.
    expect(leadInForKind('candles')).toBe(CANDLE_LEAD_IN_MS);
    expect(leadInForKind('funding')).toBe(FUNDING_LEAD_IN_MS);
    expect(leadInForKind('funding')).toBeGreaterThan(leadInForKind('candles'));
    expect(FUNDING_LEAD_IN_MS).toBeGreaterThan(CANDLE_LEAD_IN_MS);
  });
});

describe('assertLeadInBounded', () => {
  it('accepts the real lead-ins and both ends of the legal range', () => {
    expect(() => assertLeadInBounded(0, 'test')).not.toThrow();
    expect(() => assertLeadInBounded(CANDLE_LEAD_IN_MS, 'test')).not.toThrow();
    expect(() => assertLeadInBounded(FUNDING_LEAD_IN_MS, 'test')).not.toThrow();
    // Exactly at the ceiling is legal; only exceeding it is not.
    expect(() => assertLeadInBounded(MAX_LEAD_IN_MS, 'test')).not.toThrow();
  });

  it('refuses a negative lead-in', () => {
    // A negative lead-in would move the start bound FORWARD, refusing reads that
    // are plainly inside the partition.
    expect(() => assertLeadInBounded(-1, 'test')).toThrow(LeadInTooLarge);
    expect(() => assertLeadInBounded(-CANDLE_LEAD_IN_MS, 'test')).toThrow(/non-negative finite/);
  });

  it('refuses NaN, Infinity and -Infinity', () => {
    // NaN is the dangerous one: every comparison against it is false, so a NaN
    // lead-in would silently disable the start bound entirely.
    expect(() => assertLeadInBounded(NaN, 'test')).toThrow(LeadInTooLarge);
    expect(() => assertLeadInBounded(Number.POSITIVE_INFINITY, 'test')).toThrow(LeadInTooLarge);
    expect(() => assertLeadInBounded(Number.NEGATIVE_INFINITY, 'test')).toThrow(LeadInTooLarge);
  });

  it('refuses anything over the ceiling, and says why', () => {
    expect(() => assertLeadInBounded(MAX_LEAD_IN_MS + 1, 'test')).toThrow(LeadInTooLarge);
    expect(() => assertLeadInBounded(365 * 24 * HOUR_MS, 'test')).toThrow(
      /exceeds the ceiling of 604800000ms \(168h\)/,
    );
    // The message must name the caller's context: several call sites pass a
    // lead-in, and a bare "lead-in too large" does not localise the bug.
    expect(() => assertLeadInBounded(MAX_LEAD_IN_MS + 1, 'assertWithinPartition(VALIDATION)')).toThrow(
      /assertWithinPartition\(VALIDATION\)/,
    );
  });
});

describe('clampRowsToFreezeWindow', () => {
  it('keeps rows on the bounds, because the bounds are inclusive', () => {
    const rows: Array<[number, number]> = [
      [100, 1],
      [200, 2],
      [300, 3],
    ];
    expect(clampRowsToFreezeWindow(rows, 100, 300)).toEqual(rows);
  });

  it('drops rows strictly outside, on both sides', () => {
    const rows: Array<[number, number]> = [
      [99, 0],
      [100, 1],
      [300, 3],
      [301, 4],
    ];
    expect(clampRowsToFreezeWindow(rows, 100, 300)).toEqual([
      [100, 1],
      [300, 3],
    ]);
  });

  it('sorts ascending, because the input order is the wire order', () => {
    // The funding endpoint pages newest-first, so the freezer always hands this
    // function a descending list. Returning it unsorted would write a file the
    // load-time window check accepts but every reader then mis-indexes.
    const rows: Array<[number, number]> = [
      [300, 3],
      [100, 1],
      [200, 2],
    ];
    expect(clampRowsToFreezeWindow(rows, 0, 1000)).toEqual([
      [100, 1],
      [200, 2],
      [300, 3],
    ]);
  });

  it('returns a copy rather than the caller’s tuples', () => {
    const rows: Array<[number, number]> = [[100, 1]];
    const out = clampRowsToFreezeWindow(rows, 0, 1000);
    out[0]![1] = 99;
    expect(rows[0]![1]).toBe(1);
  });

  it('returns empty for an empty or fully-excluded input', () => {
    expect(clampRowsToFreezeWindow([], 0, 1000)).toEqual([]);
    expect(clampRowsToFreezeWindow([[5, 1]], 100, 200)).toEqual([]);
  });
});

describe('freezeWindowFor', () => {
  const partition = { startMs: Date.parse('2026-08-06T00:00:00Z'), endMs: Date.parse('2026-08-21T23:59:59Z') };

  it('NEVER moves the end', () => {
    // The end is the bound that carries the protocol: relaxing it is what would
    // put held-out data inside a DISCOVERY-era file. No lead-in may touch it.
    for (const kind of ['candles', 'funding'] as const) {
      expect(freezeWindowFor(kind, partition).endMs).toBe(partition.endMs);
    }
  });

  it('moves the start back by EXACTLY the kind’s lead-in, no more and no less', () => {
    // More lead-in and the file covers data the reader will not accept; less and
    // a warm-up read falls through to the live network.
    expect(freezeWindowFor('candles', partition).startMs).toBe(
      partition.startMs - CANDLE_LEAD_IN_MS,
    );
    expect(freezeWindowFor('funding', partition).startMs).toBe(
      partition.startMs - FUNDING_LEAD_IN_MS,
    );
    expect(partition.startMs - freezeWindowFor('candles', partition).startMs).toBe(
      leadInForKind('candles'),
    );
  });

  it('produces a window the reader will accept unchanged', () => {
    // The freezer writes [freezeWindowFor.startMs, freezeWindowFor.endMs]; the
    // reader refuses a row above endMs or below startMs - leadInForKind. Composing
    // the two must be a no-op, or every file the freezer writes is rejected.
    for (const kind of ['candles', 'funding'] as const) {
      const w = freezeWindowFor(kind, partition);
      const leadIn = leadInForKind(kind);
      expect(w.endMs).toBeLessThanOrEqual(partition.endMs);
      expect(w.startMs).toBeGreaterThanOrEqual(partition.startMs - leadIn);
    }
  });
});
