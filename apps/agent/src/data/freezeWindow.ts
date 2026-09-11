/**
 * The freeze window: how much data each frozen file carries, and the rule that
 * decides whether a read may reach outside its own partition.
 *
 * TWO CONSTRAINTS PULL IN OPPOSITE DIRECTIONS
 * -------------------------------------------
 * A frozen file must contain ONLY its own partition, because that is what makes
 * reading it structurally incapable of reaching held-out data.
 *
 * But a signal evaluated at the first grid minute needs prices from BEFORE that
 * minute. A 240-minute spot return looks back 241 minutes; a funding step
 * function needs the most recent settlement at or before the first minute. If a
 * file began exactly at the partition boundary, those warm-up reads would have
 * to come from somewhere else — a live network call — and the committed dataset
 * would attest to numbers it did not produce. That is not a hypothetical: it is
 * exactly the hole this module was written to close.
 *
 * So each file carries a LEAD-IN of older data, and the read rule becomes
 * ASYMMETRIC:
 *
 *   the partition END is absolute — nothing after it may ever be read
 *   the partition START may be preceded by at most `leadInMs` of warm-up
 *
 * The asymmetry is the point, and it is safe in the one direction it relaxes:
 * data OLDER than a partition has never been held out. DISCOVERY is the
 * earliest window there is; VALIDATION's lead-in reaches only into DISCOVERY,
 * which has already been seen; LOCKED_TEST has its own separate gate. Relaxing
 * the END is the thing that would break the protocol, so the end is never
 * relaxed, and `assertWithinPartition` implements exactly this asymmetry.
 *
 * WHY THIS MODULE HAS NO RELATIVE IMPORTS
 * ---------------------------------------
 * scripts/prefetch.ts and scripts/rebuild-manifest.ts run under Node's
 * strip-only type stripping, which does NOT rewrite `./x.js` specifiers to
 * `./x.ts`. A module with relative imports therefore cannot be imported from
 * scripts/ at all. Keeping this file dependency-free is what lets the FREEZE
 * step and the READ step share one definition of the window instead of two
 * copies that drift — and if they drift, files get frozen that the reader
 * rejects, or worse, the reader accepts a window the freezer never wrote.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/**
 * The coins signals are read FROM, as opposed to the rTokens they predict.
 *
 * They live here because they are exactly the symbols that need a warm-up
 * lead-in: every signal leg in the search space is a BTC or ETH series, while
 * the forward return is always an rToken's. So the reference coins are the ones
 * whose frozen files must reach back before their partition, and the targets are
 * the ones that must not.
 *
 * One definition rather than a literal in each of the freezer, the manifest
 * rebuilder and the loop — those three disagreeing is how a file gets frozen
 * without a lead-in that a reader then needs.
 */
export const REFERENCE_COINS = ['BTCUSDT', 'ETHUSDT'] as const;

/**
 * Funding settles every 8 hours. Used both as the pagination horizon and as the
 * funding lead-in, because one settlement interval is exactly what the step
 * function needs to have a rate in force at its first grid minute.
 */
export const FUNDING_INTERVAL_MS = 8 * HOUR_MS;

/**
 * The schema's cap on `condition.lookback_minutes`.
 *
 * It lives HERE, in a data-layout module, rather than beside the rest of the
 * schema, because it is half of a two-sided constraint: the schema refuses a
 * lookback the frozen data cannot warm up. `CANDLE_LEAD_IN_MS` is derived from
 * it below, so raising the cap automatically widens the lead-in and freezes
 * enough history to satisfy it. Keeping the two numbers in separate files is
 * how you end up with a schema that permits a lookback the dataset cannot
 * serve, and a warm-up read that silently goes to the network.
 *
 * src/types.ts re-exports this, so existing importers are unaffected.
 */
export const MAX_LOOKBACK_MINUTES = 240;

/**
 * Extra minutes of lead-in beyond the longest lookback.
 *
 * Covers the request's own `- MINUTE_MS` fudge and the fact that the first grid
 * minute is not the partition's first minute — the grid is built on the
 * target's timeline and starts at the first minute whose forward window is
 * valid, which can be a whole stride (up to 90 minutes) into the partition.
 */
export const LOOKBACK_HEADROOM_MINUTES = 60;

/** Candle lead-in: the longest lookback, plus headroom. 300 minutes. */
export const CANDLE_LEAD_IN_MS = (MAX_LOOKBACK_MINUTES + LOOKBACK_HEADROOM_MINUTES) * MINUTE_MS;

/** Funding lead-in: one settlement interval. */
export const FUNDING_LEAD_IN_MS = FUNDING_INTERVAL_MS;

/**
 * Ceiling on any lead-in a caller may request.
 *
 * Without this, `leadInMs` would be a general-purpose escape hatch from the
 * partition rule — pass a large enough number and the start bound stops
 * meaning anything. Seven days is far beyond the 5-hour candle lead-in and the
 * 8-hour funding lead-in, so it never binds in practice; its job is to keep the
 * parameter from becoming unbounded.
 */
export const MAX_LEAD_IN_MS = 7 * 24 * HOUR_MS;

/** Which kind of series a frozen file holds. */
export type FrozenKind = 'candles' | 'funding';

/** The lead-in a given kind of file requires. */
export function leadInForKind(kind: FrozenKind): number {
  return kind === 'funding' ? FUNDING_LEAD_IN_MS : CANDLE_LEAD_IN_MS;
}

export class LeadInTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeadInTooLarge';
  }
}

/** Refuse an unbounded lead-in. Called on every path that accepts one. */
export function assertLeadInBounded(leadInMs: number, context: string): void {
  if (!Number.isFinite(leadInMs) || leadInMs < 0) {
    throw new LeadInTooLarge(
      `${context}: lead-in must be a non-negative finite number, got ${JSON.stringify(leadInMs)}`,
    );
  }
  if (leadInMs > MAX_LEAD_IN_MS) {
    throw new LeadInTooLarge(
      `${context}: lead-in of ${leadInMs}ms exceeds the ceiling of ${MAX_LEAD_IN_MS}ms ` +
        `(${MAX_LEAD_IN_MS / HOUR_MS}h). The lead-in exists to let a signal warm up on ` +
        `slightly older data, not to exempt a read from the partition rule.`,
    );
  }
}

/**
 * Keep only the rows a file for `[startMs, endMs]` is allowed to contain.
 *
 * Used by the freezer, not the reader: the reader verifies (and throws) instead
 * of quietly trimming, because a frozen file that needs trimming is a file that
 * was written wrong.
 */
export function clampRowsToFreezeWindow(
  rows: ReadonlyArray<readonly [number, number]>,
  startMs: number,
  endMs: number,
): Array<[number, number]> {
  return rows
    .filter((r) => r[0] >= startMs && r[0] <= endMs)
    .map((r) => [r[0], r[1]] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

/**
 * The window a frozen file of `kind` should cover for a partition.
 *
 * `startMs` is pulled back by the kind's lead-in; `endMs` is untouched, because
 * the end is the bound that must never move.
 */
export function freezeWindowFor(
  kind: FrozenKind,
  partition: { startMs: number; endMs: number },
): { startMs: number; endMs: number } {
  return {
    startMs: partition.startMs - leadInForKind(kind),
    endMs: partition.endMs,
  };
}
