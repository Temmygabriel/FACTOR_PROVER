/**
 * `assertWithinPartition` — the rule that keeps held-out data out of the backtest.
 *
 * THE ASYMMETRY IS THE WHOLE POINT, so it is tested from both sides:
 *
 *   the END is absolute        — no lead-in, however large, relaxes it
 *   the START is relaxable     — but only by a bounded warm-up lead-in
 *
 * A rule this asymmetric is easy to "simplify" into a symmetric one later, and a
 * symmetric rule that relaxes the end is exactly the leak the protocol exists to
 * prevent. So the end tests below are the ones that must never be relaxed.
 */

import { describe, expect, it } from 'vitest';
import {
  LeadInTooLarge,
  CANDLE_LEAD_IN_MS,
  MAX_LEAD_IN_MS,
  MINUTE_MS,
} from '../src/data/freezeWindow.js';
import {
  PartitionViolation,
  assertWithinPartition,
  loadPartitions,
  partitionWindow,
} from '../src/config.js';

const DISCOVERY = partitionWindow('DISCOVERY');
const VALIDATION = partitionWindow('VALIDATION');
const LOCKED_TEST = partitionWindow('LOCKED_TEST');

describe('the committed partitions', () => {
  // The rule tests below are written against these numbers, so they are asserted
  // once here rather than repeated in every case. If a partition is ever re-cut,
  // this is the single test that names the change.
  it('are the preregistered windows', () => {
    expect(DISCOVERY).toEqual({
      startMs: Date.parse('2026-06-15T00:00:00Z'),
      endMs: Date.parse('2026-08-05T23:59:59Z'),
    });
    expect(VALIDATION.startMs).toBe(Date.parse('2026-08-06T00:00:00Z'));
    expect(VALIDATION.endMs).toBe(Date.parse('2026-08-21T23:59:59Z'));
    expect(LOCKED_TEST.startMs).toBe(Date.parse('2026-08-24T00:00:00Z'));
    expect(LOCKED_TEST.endMs).toBe(Date.parse('2026-09-10T23:59:59Z'));
  });

  it('are contiguous and non-overlapping, so no minute belongs to two partitions', () => {
    expect(VALIDATION.startMs).toBeGreaterThan(DISCOVERY.endMs);
    expect(LOCKED_TEST.startMs).toBeGreaterThan(VALIDATION.endMs);
  });

  it('carry the version and hash that every log entry records', () => {
    const loaded = loadPartitions();
    expect(loaded.data.partitions_version).toBe('v1.0');
    expect(loaded.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('assertWithinPartition — the END is absolute', () => {
  it('accepts a window that ends exactly on the partition end', () => {
    expect(() =>
      assertWithinPartition('DISCOVERY', { startMs: DISCOVERY.startMs, endMs: DISCOVERY.endMs }),
    ).not.toThrow();
  });

  it('refuses a window that overruns the end by a single millisecond', () => {
    expect(() =>
      assertWithinPartition('DISCOVERY', {
        startMs: DISCOVERY.startMs,
        endMs: DISCOVERY.endMs + 1,
      }),
    ).toThrow(PartitionViolation);
  });

  it('refuses an end overrun EVEN WITH a maximal lead-in', () => {
    // The lead-in is granted against the START only. A seven-day warm-up must
    // not buy one millimetre of the end, or the entire held-out split collapses.
    expect(() =>
      assertWithinPartition(
        'DISCOVERY',
        { startMs: DISCOVERY.startMs - MAX_LEAD_IN_MS, endMs: DISCOVERY.endMs + 1 },
        MAX_LEAD_IN_MS,
      ),
    ).toThrow(/The partition END is absolute and is never relaxed/);
  });

  it('says which bound was breached, so a reader is not left guessing', () => {
    // An overrun on BOTH bounds must be reported as the end failure. Reporting
    // the start instead would tell a reader the warm-up was too generous, which
    // is the wrong fix to apply.
    try {
      assertWithinPartition(
        'DISCOVERY',
        { startMs: DISCOVERY.startMs - MAX_LEAD_IN_MS - 1, endMs: DISCOVERY.endMs + 1 },
        MAX_LEAD_IN_MS,
      );
      throw new Error('expected a PartitionViolation');
    } catch (err) {
      expect(err).toBeInstanceOf(PartitionViolation);
      const message = (err as Error).message;
      expect(message).toMatch(/The partition END is absolute/);
      expect(message).not.toMatch(/does not extend this far back/);
    }
  });

  it('refuses a window reading into the NEXT partition', () => {
    // The realistic version of the leak: VALIDATION's first day requested while
    // running DISCOVERY hypotheses.
    expect(() =>
      assertWithinPartition('DISCOVERY', {
        startMs: DISCOVERY.endMs - 60 * MINUTE_MS,
        endMs: DISCOVERY.endMs + 24 * 60 * MINUTE_MS,
      }),
    ).toThrow(PartitionViolation);
  });

  it('refuses LOCKED_TEST data during an ordinary DISCOVERY read', () => {
    expect(() =>
      assertWithinPartition('DISCOVERY', {
        startMs: LOCKED_TEST.startMs,
        endMs: LOCKED_TEST.endMs,
      }),
    ).toThrow(PartitionViolation);
  });
});

describe('assertWithinPartition — the START is relaxable, within the lead-in', () => {
  it('accepts a window flush against the partition start with no lead-in', () => {
    expect(() =>
      assertWithinPartition('DISCOVERY', { startMs: DISCOVERY.startMs, endMs: DISCOVERY.startMs + MINUTE_MS }),
    ).not.toThrow();
  });

  it('refuses even one millisecond before the start when no lead-in was granted', () => {
    expect(() =>
      assertWithinPartition('DISCOVERY', {
        startMs: DISCOVERY.startMs - 1,
        endMs: DISCOVERY.endMs,
      }),
    ).toThrow(PartitionViolation);
  });

  it('accepts a warm-up read exactly at the granted lead-in', () => {
    // A 240-minute spot return evaluated at the partition's first minute looks
    // back 241 minutes. That read has to be permitted or it goes to the network.
    expect(() =>
      assertWithinPartition(
        'DISCOVERY',
        { startMs: DISCOVERY.startMs - CANDLE_LEAD_IN_MS, endMs: DISCOVERY.startMs + MINUTE_MS },
        CANDLE_LEAD_IN_MS,
      ),
    ).not.toThrow();
  });

  it('refuses a warm-up read one millisecond beyond the granted lead-in', () => {
    expect(() =>
      assertWithinPartition(
        'DISCOVERY',
        { startMs: DISCOVERY.startMs - CANDLE_LEAD_IN_MS - 1, endMs: DISCOVERY.startMs + MINUTE_MS },
        CANDLE_LEAD_IN_MS,
      ),
    ).toThrow(PartitionViolation);
  });

  it('scales with the lead-in it is handed, not with a fixed constant', () => {
    // The caller passes the lead-in its frozen file actually carries
    // (`leadInForKind`), so the same window must be refused when the caller
    // declares a smaller lead-in than it needs.
    const window = {
      startMs: DISCOVERY.startMs - CANDLE_LEAD_IN_MS,
      endMs: DISCOVERY.startMs + MINUTE_MS,
    };
    expect(() => assertWithinPartition('DISCOVERY', window, CANDLE_LEAD_IN_MS)).not.toThrow();
    expect(() =>
      assertWithinPartition('DISCOVERY', window, CANDLE_LEAD_IN_MS - 1),
    ).toThrow(/does not extend this far back/);
  });

  it('allows VALIDATION to warm up into DISCOVERY, which has already been seen', () => {
    // Relaxing the start is safe precisely because data older than a partition
    // has never been held out. This is the case that makes the asymmetry sound.
    expect(() =>
      assertWithinPartition(
        'VALIDATION',
        { startMs: VALIDATION.startMs - CANDLE_LEAD_IN_MS, endMs: VALIDATION.endMs },
        CANDLE_LEAD_IN_MS,
      ),
    ).not.toThrow();
  });
});

describe('assertWithinPartition — the lead-in itself is bounded', () => {
  it('refuses a lead-in above the ceiling before it looks at the window', () => {
    // Without the ceiling, leadInMs is a general-purpose escape hatch: pass a
    // big enough number and the start bound stops meaning anything.
    expect(() =>
      assertWithinPartition(
        'DISCOVERY',
        { startMs: DISCOVERY.startMs, endMs: DISCOVERY.endMs },
        MAX_LEAD_IN_MS + 1,
      ),
    ).toThrow(LeadInTooLarge);
  });

  it('refuses a negative or NaN lead-in', () => {
    const window = { startMs: DISCOVERY.startMs, endMs: DISCOVERY.endMs };
    expect(() => assertWithinPartition('DISCOVERY', window, -1)).toThrow(LeadInTooLarge);
    expect(() => assertWithinPartition('DISCOVERY', window, NaN)).toThrow(LeadInTooLarge);
  });

  it('names the partition in the message, so the call site is identifiable', () => {
    expect(() =>
      assertWithinPartition('VALIDATION', { startMs: DISCOVERY.startMs, endMs: DISCOVERY.endMs }, MAX_LEAD_IN_MS + 1),
    ).toThrow(/assertWithinPartition\(VALIDATION\)/);
  });

  it('defaults to no lead-in when none is supplied', () => {
    // The default matters: a call site that forgets the argument gets the strict
    // rule, not a permissive one.
    expect(() =>
      assertWithinPartition('DISCOVERY', { startMs: DISCOVERY.startMs - 1, endMs: DISCOVERY.endMs }),
    ).toThrow(PartitionViolation);
  });
});

describe('assertWithinPartition — the refusal is informative', () => {
  it('prints both windows and the granted lead-in', () => {
    try {
      assertWithinPartition(
        'DISCOVERY',
        { startMs: DISCOVERY.startMs - MAX_LEAD_IN_MS, endMs: DISCOVERY.endMs + 1 },
        MAX_LEAD_IN_MS,
      );
      throw new Error('expected a PartitionViolation');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('DISCOVERY');
      expect(message).toContain(new Date(DISCOVERY.startMs).toISOString());
      expect(message).toContain(new Date(DISCOVERY.endMs).toISOString());
      expect(message).toContain('10080-minute warm-up lead-in');
      expect(message).toMatch(/Partitions are frozen; this request is refused\./);
    }
  });

  it('does not mention a lead-in when none was granted', () => {
    try {
      assertWithinPartition('DISCOVERY', { startMs: DISCOVERY.startMs - 1, endMs: DISCOVERY.endMs });
      throw new Error('expected a PartitionViolation');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/warm-up lead-in/);
    }
  });
});
