/**
 * Number and timestamp formatting.
 *
 * Everything here is deterministic and locale-independent, deliberately: these
 * values render on the server for the page shell and again on the client once
 * data arrives, and `toLocaleString` picks its format from the runtime's locale.
 * A mismatch between the two renders is a hydration error, which would show up
 * as a broken page rather than as a wrong number — a confusing failure for a
 * bug this small.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function valid(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validIso(iso: string | null | undefined): iso is string {
  if (!iso) return false;
  return !Number.isNaN(new Date(iso).getTime());
}

/** The em-dash is the house mark for "not reported". Never a zero. */
export const ABSENT = '—';

export function fmt(value: number | null | undefined, decimals: number): string {
  return valid(value) ? value.toFixed(decimals) : ABSENT;
}

/** IC and correlations: three decimals, sign preserved. */
export const fmtIc = (value: number | null | undefined): string => fmt(value, 3);

/** t-statistics: two decimals. */
export const fmtT = (value: number | null | undefined): string => fmt(value, 2);

/**
 * p-values: three decimals, but a p below 0.001 is reported as "< 0.001" rather
 * than rounded to 0.000. Showing 0.000 would claim the probability IS zero,
 * which no finite sample can support, and the BH comparison depends on the
 * difference between 0.0004 and 0.0001.
 */
export function fmtP(value: number | null | undefined): string {
  if (!valid(value)) return ABSENT;
  if (value < 0.001) return '< 0.001';
  return value.toFixed(3);
}

/**
 * Thresholds: the BH threshold shrinks as the family grows — it is 0.02 at rank
 * 1 of 5 tests and 0.0005 at rank 1 of 200 — so a fixed three decimals would
 * print "0.001" for both 0.0005 and 0.0015.
 *
 * SIX decimals below 0.01, and the reason is a collision the four-decimals
 * version actually had. At the family sizes this loop reaches, adjacent ranks
 * are ~0.0005 apart, so a raw p-value of 0.000510 and a bar of 0.000498 both
 * rounded to "0.0005" — which renders a kill as "p 0.0005 did not survive the
 * bar (0.0005)", a sentence that contradicts itself. Six decimals separates
 * them (0.000510 against 0.000498) and is still short enough to read.
 *
 * This is also the formatter for a p-value wherever the p-value is being
 * COMPARED to the bar rather than listed in a column. `fmtP` above answers a
 * different question — "roughly how small is this?" — and answers it with
 * "< 0.001", which is right in the metrics table and useless in a comparison.
 * Using one function for both sides of a comparison is what keeps the two
 * numbers in a kill sentence on the same scale.
 */
export function fmtThreshold(value: number | null | undefined): string {
  if (!valid(value)) return ABSENT;
  return value >= 0.01 ? value.toFixed(3) : value.toFixed(6);
}

export function fmtInt(value: number | null | undefined): string {
  if (!valid(value)) return ABSENT;
  return Math.round(value).toString();
}

/** Paper P&L, in USDT, with the sign always shown. */
export function fmtUsdt(value: number | null | undefined): string {
  if (!valid(value)) return ABSENT;
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)} USDT`;
}

/** Decay half-life: null means not enough forward data to fit one yet. */
export function fmtHalfLife(days: number | null | undefined): string {
  if (!valid(days)) return 'not yet fitted';
  if (days < 1) return `${(days * 24).toFixed(1)} h`;
  return `${days.toFixed(1)} d`;
}

/**
 * Hash strings are shown truncated to 8 characters in lists, per spec §4. The
 * `sha256:` prefix is stripped first so all 8 are entropy rather than 7.
 */
export function truncHash(hash: string | null | undefined, length = 8): string {
  if (!hash) return ABSENT;
  const bare = hash.replace(/^sha256:/, '');
  return bare.length <= length ? bare : `${bare.slice(0, length)}…`;
}

/** "14:32:07 UTC" — the log's primary timestamp, per spec §6 Screen 3. */
export function fmtClockUtc(iso: string | null | undefined): string {
  if (!validIso(iso)) return ABSENT;
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** "Sep 10, 2026" */
export function fmtDateUtc(iso: string | null | undefined): string {
  if (!validIso(iso)) return ABSENT;
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "2026-09-10T14:09:21Z" — the exact stamp, for provenance and hash blocks. */
export function fmtIsoExact(iso: string | null | undefined): string {
  if (!validIso(iso)) return ABSENT;
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * "2 min ago" for the recent-decisions table. A clock is passed in rather than
 * read here so every row on a screen is dated against the same instant; rows
 * read against `Date.now()` can disagree about "now" by a render pass.
 */
export function fmtAgo(iso: string | null | undefined, now: number): string {
  if (!validIso(iso)) return ABSENT;
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "4h", "30m" — window lengths are written in the unit the family uses. */
export function fmtWindow(minutes: number | null | undefined): string {
  if (!valid(minutes)) return ABSENT;
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** "RCOINUSDT" -> "RCOIN". The chart label, not the trading symbol. */
export function targetLabel(symbol: string | null | undefined): string {
  if (!symbol) return ABSENT;
  return symbol.replace(/USDT$/, '');
}

/**
 * Directional colour for a signed number, per spec §3: data-positive and
 * data-negative reuse the promoted and killed tones intentionally. Applied
 * identically to promote rows and kill rows — the colour reports the sign of
 * the number, never the verdict.
 */
export function signTone(value: number | null | undefined): string {
  if (!valid(value) || value === 0) return 'text-ink';
  return value > 0 ? 'text-promoted' : 'text-killed';
}
