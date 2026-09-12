/**
 * Statistical core: IC, t-statistic, p-value, and the Benjamini-Hochberg
 * false-discovery-rate correction.
 *
 * Everything the gate decides rests on this file. Two implementation notes
 * matter and are called out because getting them wrong would silently turn the
 * submission's central claim into a lie:
 *
 *  A. The p-value uses a real Student-t distribution (via the regularized
 *     incomplete beta function), not a normal approximation. With 100-300
 *     observations the difference is not cosmetic.
 *
 *  B. The BH correction is the standard step-up procedure, which differs from
 *     the pseudocode in the build spec. See `benjaminiHochberg` below.
 */

// ---------------------------------------------------------------------------
// Pearson correlation
// ---------------------------------------------------------------------------

export interface Correlation {
  r: number;
  n: number;
}

/**
 * Pearson correlation. Returns r = 0 when either input has zero variance
 * (a constant signal cannot correlate with anything).
 */
export function pearson(xs: readonly number[], ys: readonly number[]): Correlation {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { r: 0, n };

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;

  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }

  const den = Math.sqrt(dx2 * dy2);
  if (den === 0) return { r: 0, n };
  return { r: num / den, n };
}

/** Lag-1 autocorrelation. Disclosed alongside results, not used as a gate. */
export function autocorrLag1(xs: readonly number[]): number {
  if (xs.length < 3) return 0;
  const a = xs.slice(0, -1);
  const b = xs.slice(1);
  return pearson(a, b).r;
}

// ---------------------------------------------------------------------------
// Student-t distribution
// ---------------------------------------------------------------------------

/** Continued fraction for the incomplete beta function (Lentz's method). */
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;

    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const lnBeta =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnBeta);

  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Lanczos approximation of ln(Gamma(x)). */
export function logGamma(x: number): number {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp0 = x + 5.5;
  const tmp = tmp0 - (x + 0.5) * Math.log(tmp0);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j]! / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/**
 * Two-tailed p-value for a t-statistic with `df` degrees of freedom.
 *
 * p = I_{df/(df+t^2)}(df/2, 1/2)
 *
 * NaN is handled BEFORE the finite check, and returns 1 rather than 0.
 * `Number.isFinite` is false for NaN and for ±Infinity, and the one-line version
 * of this function lumped them together — but they mean opposite things.
 * Infinity is a saturated magnitude: a correlation so extreme it overflowed,
 * which is real evidence and belongs at p = 0. NaN is the ABSENCE of a result,
 * and it is the reachable case here: `tStatFromR` caps |r| at a finite 1e6, so
 * it never returns an infinite t, but it does return NaN for a degenerate input
 * such as a zero-variance series. Scoring that as p = 0 made a statistic that was
 * never computed the EASIEST kind to promote, because p = 0 clears every
 * Benjamini-Hochberg threshold there is. So NaN takes the same "no evidence"
 * value as `df <= 0` above.
 */
export function studentTTwoTailedP(t: number, df: number): number {
  if (df <= 0) return 1;
  if (Number.isNaN(t)) return 1;
  if (!Number.isFinite(t)) return 0;
  const x = df / (df + t * t);
  return incompleteBeta(df / 2, 0.5, x);
}

/**
 * t-statistic on a correlation: t = r * sqrt((n - 2) / (1 - r^2)).
 * Returns 0 when r is 0, and a large finite value when |r| approaches 1.
 */
export function tStatFromR(r: number, n: number): number {
  if (n <= 2) return 0;
  const r2 = r * r;
  if (r2 >= 1) return Math.sign(r) * 1e6;
  return r * Math.sqrt((n - 2) / (1 - r2));
}

// ---------------------------------------------------------------------------
// Benjamini-Hochberg FDR
// ---------------------------------------------------------------------------

export interface BHResult {
  /** Rejection decision, indexed the same way as the input p-values. */
  reject: boolean[];
  /**
   * The BH threshold that applies at each hypothesis's own rank:
   * (rank / m) * q. Reported so the UI can show the bar a factor faced.
   */
  thresholdAtRank: number[];
  /** Number of hypotheses in the family (every one attempted, not just passers). */
  m: number;
  /** Largest rank k with p_(k) <= (k/m)*q, or 0 if none. */
  kStar: number;
  /** The p-value cutoff actually applied: (kStar/m)*q, or 0. */
  cutoff: number;
}

/**
 * Benjamini-Hochberg step-up FDR control.
 *
 * NOTE ON A DEVIATION FROM THE BUILD SPEC
 * ---------------------------------------
 * The spec's pseudocode decides each hypothesis independently:
 *
 *     bh_threshold = (rank / m) * q
 *     adjusted[idx] = (p <= bh_threshold)
 *
 * That is not the BH procedure. The real one is a step-up: find the LARGEST
 * rank k such that p_(k) <= (k/m)*q, then reject every hypothesis at rank <= k.
 *
 * The two differ whenever a p-value fails at its own rank but a later, larger
 * p-value passes at a larger rank — which happens routinely with clustered
 * p-values. The spec's version can reject a hypothesis while accepting a worse
 * one at a better rank, which is incoherent, and it is strictly more
 * conservative than BH in the cases that matter.
 *
 * Since the whole submission rests on this correction being correct and
 * disclosed, the standard step-up procedure is implemented here. It is more
 * permissive than the spec's version, so the honest direction to err.
 *
 * `pValues` MUST include every hypothesis attempted this session — all kills,
 * retries, schema rejections and near-duplicates. Limiting it to hypotheses
 * that passed would defeat the correction entirely.
 */
export function benjaminiHochberg(pValues: readonly number[], q: number): BHResult {
  const m = pValues.length;
  if (m === 0) {
    return { reject: [], thresholdAtRank: [], m: 0, kStar: 0, cutoff: 0 };
  }

  const order = pValues
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p);

  let kStar = 0;
  for (let rank = 1; rank <= m; rank++) {
    if (order[rank - 1]!.p <= (rank / m) * q) kStar = rank;
  }

  const cutoff = kStar > 0 ? (kStar / m) * q : 0;

  const reject = new Array<boolean>(m).fill(false);
  const thresholdAtRank = new Array<number>(m).fill(0);

  for (let rank = 1; rank <= m; rank++) {
    const idx = order[rank - 1]!.i;
    thresholdAtRank[idx] = (rank / m) * q;
    reject[idx] = rank <= kStar;
  }

  return { reject, thresholdAtRank, m, kStar, cutoff };
}
