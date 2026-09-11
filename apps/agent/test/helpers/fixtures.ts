/**
 * Shared test fixtures.
 *
 * Nothing in here touches the network or the committed dataset. Where a suite
 * needs a frozen store it installs one of its own, because the real store is
 * 3.5 MB of committed data whose contents are not this suite's business — and
 * because a test that reads the real dataset cannot state what it is asserting
 * about.
 */

export { installFrozenFixtures, installNoFrozenStore } from './frozenStore.js';
export type { FixtureSpec } from './frozenStore.js';

/** A Candle with every field filled, so a test only names the ones it cares about. */
export interface CandleLike {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  quoteVolume: number;
}

export function candle(ts: number, close: number): CandleLike {
  return { ts, open: close, high: close, low: close, close, baseVolume: 0, quoteVolume: 0 };
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
