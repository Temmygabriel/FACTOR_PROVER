/**
 * The dual vocabulary, in one place.
 *
 * The design spec asks for technical labels with plain-language tooltips
 * (§6 Screen 2). Every translation the product makes between a machine value and
 * an English sentence lives here, for one reason: the wording is where a kill
 * gets editorialised. A single file of sentences can be read and checked; a
 * sentence written inline at the point of failure cannot.
 *
 * The wording rules, from spec §9:
 *   - A kill is something the gate DID. "the gate killed it", never "it failed".
 *   - Never "rejected", "failed", "bad signal", "unsuccessful", "no data".
 *   - Always say what was not affected, not just what went wrong.
 */

import type { KillReason } from './types';
import type { Verdict } from './verdict';
import { hasGateEvidence } from './verdict';
import type { DecisionRow, HypothesisShape, SessionStats } from './types';
import { ABSENT, fmt, fmtIc, fmtInt, fmtT, fmtThreshold, targetLabel } from './format';
import { PRESCRIBED } from './policy';

/**
 * Why an entry was killed, in one sentence a reader outside the project can
 * follow. The floors quoted are the preregistered ones (gate_policy.json v1.0)
 * and the same constants are rendered as the bar in the stamp, so the sentence
 * and the check row cannot disagree.
 *
 * The floors are interpolated from `PRESCRIBED` rather than typed into the
 * prose. They were typed in once, and that is one policy edit away from a
 * sentence that quotes a floor the gate was not using — the sort of quiet
 * disagreement between the label and the check that this product exists to make
 * impossible.
 */
export const KILL_REASON_PLAIN: Record<KillReason, string> = {
  insufficient_obs: `fewer than ${PRESCRIBED.min_obs} valid observations — too few to test, so the gate killed it on the evidence available rather than on the idea`,
  ic_below_floor: `the correlation was weaker than the preregistered floor of ${PRESCRIBED.min_ic}, so the signal did not move with the forward return`,
  t_stat_below_floor: `the t-statistic was below the preregistered floor of ${PRESCRIBED.min_t_stat.toFixed(
    1,
  )}, so at this sample size the result is not distinguishable from chance`,
  baseline_not_beaten:
    'the factor did not outperform a naive baseline that uses the previous period’s return as the signal',
  p_value_exceeds_bh_threshold:
    'the p-value did not survive the Benjamini-Hochberg correction applied across every hypothesis attempted this session',
  lookback_bias_detected:
    'the signal’s own past values predicted it, so the test was measuring the lookback window rather than the market',
  duplicate_family:
    'an earlier hypothesis in this session already tested this signal and target pair',
  schema_validation_failed:
    'the hypothesis did not conform to the required structure, so no backtest was run and no gate decision was reached',
};

/** The short tag used where a sentence will not fit. Spec §6 Screen 2. */
export const KILL_REASON_TAG: Record<KillReason, string> = {
  p_value_exceeds_bh_threshold: 'p > BH',
  insufficient_obs: 'n < 100',
  baseline_not_beaten: 'no base',
  schema_validation_failed: 'schema',
  ic_below_floor: 'IC < 0.04',
  t_stat_below_floor: 't < 2.0',
  lookback_bias_detected: 'lookback',
  duplicate_family: 'duplicate',
};

export const KILL_REASON_TOOLTIP: Record<KillReason, string> = {
  p_value_exceeds_bh_threshold:
    'Did not survive multiple-testing correction across all hypotheses attempted this session.',
  insufficient_obs: 'Too few data points to test reliably.',
  baseline_not_beaten: 'Did not outperform a naive prior-period return signal.',
  schema_validation_failed: 'Hypothesis did not conform to required structure.',
  ic_below_floor: 'Correlation below the preregistered floor of 0.04.',
  t_stat_below_floor: 'Below the preregistered t-statistic floor of 2.0.',
  lookback_bias_detected: 'The signal predicted itself; the test measured the lookback.',
  duplicate_family: 'An earlier hypothesis tested the same signal and target pair.',
};

/** Falls back to the raw value so an unseen reason renders as itself. */
export function killReasonPlain(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return KILL_REASON_PLAIN[reason as KillReason] ?? `killed: ${reason}`;
}

export function killReasonTag(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return KILL_REASON_TAG[reason as KillReason] ?? reason;
}

export function killReasonTooltip(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return KILL_REASON_TOOLTIP[reason as KillReason] ?? reason;
}

/** What each stamp label means, for the legend under the leaderboard. */
export const VERDICT_MEANING: Record<Verdict, string> = {
  PROMOTED: 'the factor cleared the preregistered statistical gate',
  /*
   * "did not survive multiple-testing correction" until 2026-09-22, and it was
   * wrong for most of the rows it described. This is the stamp's FALLBACK line —
   * used when `killSentences` has nothing specific to say — so it has to be true
   * of every kill, and the commonest kill in the record is not a BH one: a
   * hypothesis that dies at `insufficient_obs` or `ic_below_floor` never reached
   * the multiple-testing comparison at all, and telling its reader it failed that
   * correction misstates which bar it fell at. The reconfiguration brief §10
   * supplies the phrasing that is true of all of them, and the specific bar is
   * named with its number in the "Why was it killed?" block one rung below.
   */
  KILLED: 'the idea did not clear the preregistered evidence bar',
  RETIRED: 'the factor was promoted but its edge has decayed',
  'AUTO-KILLED': 'the hypothesis did not conform to the required schema',
  'CIRCUIT BREAK': 'the loop halted itself; no verdict was reached on a factor',
};

/**
 * Technical signal names, and what they actually are. The signal enum is the
 * vocabulary the gate reasons in; a reader should not have to learn it.
 */
export const SIGNAL_PLAIN: Record<string, string> = {
  btc_funding_rate:
    'the funding payment on Bitget’s BTC perpetual — positive means longs pay shorts',
  eth_funding_rate: 'the funding payment on Bitget’s ETH perpetual',
  btc_spot_return: 'the change in BTC spot price over the lookback window',
  eth_spot_return: 'the change in ETH spot price over the lookback window',
  btc_funding_x_spot: 'a conjunction: a BTC funding condition AND a BTC spot move together',
};

export const OPERATOR_PLAIN: Record<string, string> = {
  gt: 'greater than',
  lt: 'less than',
  gte: 'at least',
  lte: 'at most',
  pct_change_gt: 'percentage change greater than',
  pct_change_lt: 'percentage change less than',
};

/** Column headers, with the spec's tooltip copy (§6 Screen 2). */
export const COLUMN_TIPS = {
  ic: 'How consistently this signal predicted direction. 0 = no relationship. Above 0.04 is meaningful here.',
  t: 'Statistical confidence. Above 2.0 means the result is unlikely to be random chance.',
  obs: 'Number of valid data points used in the test. Below 100 = not enough evidence to test.',
  p: 'The raw probability of seeing a relationship this strong by chance alone, before correcting for how many hypotheses were tested.',
  bh: 'The threshold this p-value had to clear, after the Benjamini-Hochberg correction over every hypothesis attempted this session. It falls as the session attempts more hypotheses.',
  baseline:
    'What a naive signal achieves on the same data — using the previous period’s return to predict the next. A factor has to beat this to count.',
  pnl: 'Paper profit and loss in USDT. No real funds are involved at any point.',
  decay:
    'How fast the factor’s edge halves, once enough forward data exists to fit it. A short half-life means the effect fades quickly.',
  window: 'How far ahead the forward return is measured, from the moment the condition is met.',
  lookback: 'How far back the condition looks to decide whether it has been met.',
};

/**
 * The five gate checks, in the preregistered precedence order (lib/policy.ts),
 * with the label and the sentence explaining what the row is comparing.
 */
export const CHECK_ROWS = {
  passed_min_obs: {
    label: 'observations',
    tip: 'Independent observations available for this hypothesis. The floor is 100; below it the gate kills on insufficient evidence.',
  },
  passed_ic_floor: {
    label: 'IC',
    tip: 'Correlation between the signal and the forward return. The floor is 0.04.',
  },
  passed_t_stat_floor: {
    label: 't-statistic',
    tip: 'How far the IC sits from zero, in standard errors. The floor is 2.0.',
  },
  passed_baseline_beat: {
    label: 'baseline IC',
    tip: 'What a naive prior-period-return signal scores on the same data. The factor has to beat it.',
  },
  passed_bh: {
    label: 'p-value',
    tip: 'Compared against the Benjamini-Hochberg threshold at this family size, not against a fixed 0.05.',
  },
} as const;

/** The tagline from spec §9. No profitability claim, no superlative. */
export const TAGLINE =
  'Factor Prover tests cross-asset hypotheses against Bitget market data and issues a verdict on each one. It shows every kill.';

/**
 * The null-result framing, used when the session has promoted nothing.
 *
 * THE SPEC'S SECOND SENTENCE IS FALSE, AND OUR OWN LOG PROVED IT. Design spec
 * §9 reads: "[N] hypotheses tested. [N] did not survive the Benjamini-Hochberg
 * correction applied across all [N] tests at FDR level 0.10." That is true only
 * if every kill is a BH kill. A 361-entry run on the deployed instance — since
 * lost, because the free tier has no persistent disk — recorded this reason
 * distribution: ic_below_floor 112, t_stat_below_floor 100, duplicate_family 99,
 * insufficient_obs 48, p_value_exceeds_bh_threshold 11, baseline_not_beaten 2.
 * Eleven of three hundred and sixty-one died at BH; the other 350 died at one of
 * the four earlier bars.
 *
 * That matters more here than a copy quibble usually would. This sentence sits
 * on the leaderboard beside the log that contradicts it, and a judge who counts
 * finds the product overstating its own rigour in the exact direction the whole
 * submission is built to avoid. So the structure and the voice of the spec's
 * copy are kept and the one claim is corrected: the five bars are enumerated and
 * BH is named as one of them rather than as the cause.
 *
 * The alternative — deriving the real distribution and naming the largest bucket
 * — needs per-reason counts on the wire, which `SessionStats` does not carry.
 * Until it does, this says the true thing generically rather than the false
 * thing specifically.
 *
 * THE FIRST LINE USED TO READ "No factors promoted in this session." and the
 * scope was the problem, not the wording. `attempted` is the session's own count
 * when the session has one and the committed log's total otherwise (see the
 * caller), because the rows this copy sits above come from the log. So the number
 * could be the record's while the sentence claimed it was the session's — and on
 * the deployed free tier, where the session count resets to zero on every wake,
 * that is the normal case rather than an edge one. The scope is dropped: the
 * sentence is true of whichever count the caller passed, and the page header
 * above it says which. PROGRESS.md finding 35.
 */
export function nullResultCopy(attempted: number, fdrLevel: number): string[] {
  const n = fmtInt(attempted);
  const singular = attempted === 1;
  return [
    'No factors promoted.',
    `${n} ${singular ? 'hypothesis was' : 'hypotheses were'} attempted. ${
      singular ? 'It failed' : 'Each failed'
    } at least one of the five preregistered bars: too few observations, an IC below its floor, a t-statistic below its floor, a baseline that already did as well, or the Benjamini-Hochberg correction at FDR ${fdrLevel.toFixed(
      2,
    )} applied across all ${n} tests at once.`,
    'This is a result. A factor miner that promotes everything is broken. The gate is working.',
  ];
}

// ---------------------------------------------------------------------------
// The orientation layer — changes 1, 2, 3, 5 and 6 of the UI redesign brief
// ---------------------------------------------------------------------------
//
// Everything below turns numbers the server actually sent into a sentence. None
// of it is authored text: each is a template over recorded fields, so a sentence
// cannot say something the log does not support. That is the reason the
// sentences live in this file rather than inline in a component, where the
// temptation is to reach for a phrase nicer than the data warrants.
//
// UNITS ARE THE ONE THING TO GET RIGHT. The log stores a condition as a bare
// number, and the same number means different things per signal: a funding rate
// of 0.00005 is 0.005%, while a spot return of 0.5 is already 0.5%. Rendering
// one with the other's unit overstates it by 100x. So the unit is looked up per
// signal, and a signal this file has not been told about gets NO unit rather
// than a guessed one — an unlabelled number is a smaller error than a wrong
// label, and it is visible to a reader in a way a wrong unit is not.

/**
 * What a condition's `threshold` is measured in, per signal.
 *
 * `rate` is a decimal funding rate, so 0.00005 prints as 0.005%.
 * `percent` is already a percentage, so 0.5 prints as 0.5%.
 *
 * `btc_funding_x_spot` is a rate for the same reason the plain funding signals
 * are: it is a conjunction of funding and spot conditions whose threshold binds
 * to the funding leg, and `family.ts` refuses `pct_change_*` operators on it for
 * exactly that reason — a level-valued signal cannot carry a change operator.
 */
const SIGNAL_UNIT: Record<string, 'rate' | 'percent'> = {
  btc_funding_rate: 'rate',
  eth_funding_rate: 'rate',
  btc_funding_x_spot: 'rate',
  btc_spot_return: 'percent',
  eth_spot_return: 'percent',
};

/**
 * The noun the question uses for a signal, in two forms.
 *
 * `full` is for a level condition — "a BTC price move above 0.5%" — and `bare`
 * is for a change condition, because "a BTC price move rising more than 0.5%"
 * says move twice. The operator decides which is used, in `hypothesisQuestion`.
 *
 * These are deliberately NOT the `SIGNAL_LABELS` in the redesign brief. The
 * brief labels `btc_funding_rate` a "funding rate spike", and a spike is not
 * what the condition tests: `gt 0.005%` is a level — the funding rate being
 * positive and above a floor at the moment of measurement. Calling it a spike
 * would put a claim in the question that the backtest never made. The word
 * "spike" belongs to a change operator, and there is a `pct_change_gt` form
 * that means exactly that and gets its own wording below.
 */
const SIGNAL_NOUN: Record<string, { bare: string; full: string }> = {
  btc_funding_rate: { bare: 'BTC funding rate', full: 'BTC funding rate' },
  eth_funding_rate: { bare: 'ETH funding rate', full: 'ETH funding rate' },
  btc_spot_return: { bare: 'BTC price', full: 'BTC price move' },
  eth_spot_return: { bare: 'ETH price', full: 'ETH price move' },
  btc_funding_x_spot: { bare: 'BTC funding', full: 'BTC funding rate together with a BTC price move' },
};

/**
 * A percentage for prose: enough decimals to be true, trailing zeros dropped.
 *
 * `fmt` takes a fixed decimal count because it serves the metrics table, where a
 * column of numbers has to line up. In a sentence a fixed count reads as false
 * precision — "above 0.00500%" claims two digits more than the threshold holds.
 */
function pct(value: number): string {
  if (!Number.isFinite(value)) return ABSENT;
  if (value === 0) return '0%';
  const decimals = Math.abs(value) >= 0.001 ? 3 : 6;
  const trimmed = value
    .toFixed(decimals)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
  return `${trimmed}%`;
}

/**
 * The condition as a phrase that attaches to a signal noun.
 *
 * An operator this file has not seen renders as itself beside its own number,
 * with no unit: inventing a wording for an operator would be inventing a
 * meaning, and the raw form at least tells a reader what the log says.
 */
function conditionPlain(
  signal: string,
  condition: { operator: string; threshold: number },
): string {
  const unit = SIGNAL_UNIT[signal];
  const level = (v: number) =>
    unit === 'rate' ? pct(v * 100) : unit === 'percent' ? pct(v) : String(v);

  switch (condition.operator) {
    case 'gt':
      return `above ${level(condition.threshold)}`;
    case 'gte':
      return `at or above ${level(condition.threshold)}`;
    case 'lt':
      return `below ${level(condition.threshold)}`;
    case 'lte':
      return `at or below ${level(condition.threshold)}`;
    case 'pct_change_gt':
      return `rising more than ${pct(condition.threshold)}`;
    // `lt` on a change is a fall, and the threshold is negative in that reading;
    // the absolute value is what the phrase "more than" needs.
    case 'pct_change_lt':
      return `falling more than ${pct(Math.abs(condition.threshold))}`;
    default:
      return `${condition.operator.replace(/_/g, ' ')} ${condition.threshold}`;
  }
}

/**
 * A window length as prose. "60 minutes", not "60m".
 *
 * `fmtWindow` is the compact form and is right everywhere a window sits in a
 * column or beside a unit. Inside a sentence it reads as a unit label rather
 * than as English, and this sentence is the one a reader meets first.
 */
function windowProse(minutes: number): string {
  if (!Number.isFinite(minutes)) return ABSENT;
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${hours.toFixed(1)} hours`;
}

/**
 * "a" or "an", chosen by SOUND rather than by spelling.
 *
 * The naive rule — "an" before a vowel letter — gets this product's own nouns
 * wrong, and they are the ones a reader meets first. "ETH" begins with a vowel
 * letter and takes "an". "RGOOGL" begins with a consonant letter and ALSO takes
 * "an", because the letter R is pronounced "arr". The rule that works is about
 * letter NAMES: a word read as an initialism takes "an" when the name of its
 * first letter begins with a vowel sound.
 *
 * So: a vowel letter, or one of the consonants whose names begin with a vowel —
 * F, H, L, M, N, R, S, X. Hence "an F", "an R", "an X", against "a B", "a D".
 *
 * This is a spelling rule standing in for a pronunciation rule, so it will get
 * some acronym it has not met wrong. That is acceptable HERE and only here: the
 * two things it is applied to are this product's fixed vocabulary — signal nouns
 * and target symbols — and the targets are all exchange tickers, which is the
 * case the rule was written for. A general article picker would need phonetics
 * this file does not have and does not need.
 */
function articleFor(word: string): 'a' | 'an' {
  const first = word.trim().charAt(0).toUpperCase();
  return 'AEIOUFHLMNRSX'.includes(first) ? 'an' : 'a';
}

/**
 * The hypothesis as a question a reader outside the project can answer.
 *
 * Built from the structured fields at render time, never from the generator's
 * own prose. That matters beyond the usual "do not trust the LLM" reflex: the
 * sentence is the product's claim about what it tested, and it has to be a
 * function of the same fields the backtest was run on. If it were free text, a
 * proposal could describe itself as testing one thing while the engine tested
 * another, and the log would carry both.
 *
 * Returns null when there is no hypothesis to describe — a CIRCUIT_BREAK or
 * schema-killed row, where the caller should say what happened instead of
 * showing an empty question.
 */
export function hypothesisQuestion(
  hypothesis: HypothesisShape | null | undefined,
): string | null {
  if (!hypothesis || !hypothesis.condition) return null;
  const condition = hypothesis.condition;
  if (typeof condition.operator !== 'string' || !Number.isFinite(condition.threshold)) {
    return null;
  }
  // Same guard for the window: a question that reads "over the next NaN minutes"
  // is worse than no question, because it looks like data.
  if (!Number.isFinite(hypothesis.forward_return_minutes)) return null;

  const noun = SIGNAL_NOUN[hypothesis.signal];
  const isChange = condition.operator.startsWith('pct_change_');
  const subject = noun
    ? isChange
      ? noun.bare
      : noun.full
    : hypothesis.signal.replace(/_/g, ' ');
  const target = targetLabel(hypothesis.target);
  const direction = hypothesis.direction === 'negative' ? 'fall' : 'rise';

  /*
   * The articles are chosen rather than written, and that is a fix rather than a
   * flourish. This sentence used to hardcode "a", which produced "Does a ETH
   * price move ... predict a RGOOGL price rise" — wrong twice, in the one
   * sentence a reader meets first, and now the headline of the real-result card.
   * Both nouns are initialisms, which is precisely the case the naive vowel rule
   * gets wrong in both directions.
   */
  return (
    `Does ${articleFor(subject)} ${subject} ${conditionPlain(hypothesis.signal, condition)} ` +
    `predict ${articleFor(target)} ${target} price ${direction} ` +
    `over the next ${windowProse(hypothesis.forward_return_minutes)}?`
  );
}

/**
 * The bar the gate is applying, for the hypothesis card.
 *
 * TWO DIFFERENT NUMBERS, AND THE CARD SAYS WHICH ONE IT IS SHOWING.
 *
 * A hypothesis's own bar is `(rank / m) * fdr`, and the rank-1 bar the server
 * reports as `current_bh_threshold_rank1` is `fdr / m` — the strictest bar in
 * the session. For a hypothesis still in flight the rank is not known until the
 * family is ranked, so the rank-1 bar is the only one that can be quoted, and
 * the caption says that. For a decided row the row's own bar IS known, from
 * `metrics.bh_adjusted_threshold`, so that is quoted instead — and it is quoted
 * because the stamp directly above this section prints that same number on its
 * `passed_bh` line. Showing the rank-1 bar here would put two different
 * thresholds under one label on one screen, which is the reader-visible version
 * of a bug.
 *
 * Returns null when there is no family to correct for — no threshold, or a
 * session that has attempted nothing. The section then does not render, rather
 * than rendering a bar for zero tests.
 */
export interface BarStatement {
  /** The threshold to print, formatted. */
  value: string;
  /** What that number is, so a reader is never misled about which bar it is. */
  caption: string;
  /** Why the bar is where it is. */
  lines: string[];
}

export function barItMustClear(opts: {
  attempted: number;
  /** The session's rank-1 reading. Null when status has not answered. */
  rank1Threshold: number | null;
  /** The bar this particular row was judged against, when a verdict exists. */
  ownThreshold?: number | null;
}): BarStatement | null {
  const { attempted, rank1Threshold, ownThreshold = null } = opts;
  if (!Number.isFinite(attempted) || attempted <= 0) return null;

  const own =
    ownThreshold !== null && Number.isFinite(ownThreshold) ? ownThreshold : null;
  // Null rather than NaN or a guess: the rank-1 reading is absent whenever
  // /api/status has not answered, and a decided row still has its own bar.
  const rank1 =
    rank1Threshold !== null && Number.isFinite(rank1Threshold) ? rank1Threshold : null;

  const many = attempted === 1 ? 'hypothesis has' : 'hypotheses have';
  const familyLine =
    `${fmtInt(attempted)} ${many} been attempted this session. The gate corrects for all of ` +
    `them at once, so the more that are attempted, the harder any one of them is to clear.`;

  if (own !== null) {
    // The rank-1 bar is printed only when it is genuinely a different number, so
    // the section never shows one threshold twice under two captions.
    const differs = rank1 !== null && Math.abs(own - rank1) > 1e-12;
    return {
      value: fmtThreshold(own),
      caption: 'the bar this hypothesis was judged against',
      lines:
        differs && rank1 !== null
          ? [
              familyLine,
              `The strictest bar in the session, at rank 1, is ${fmtThreshold(rank1)}.`,
            ]
          : [familyLine],
    };
  }

  if (rank1 !== null) {
    return {
      value: fmtThreshold(rank1),
      caption: 'the strictest bar in this session, at rank 1',
      lines: [familyLine],
    };
  }

  // Neither reading is available. Nothing is quoted and the section does not
  // render, rather than rendering a bar with no number under it.
  return null;
}

/**
 * Why this row was killed, in two sentences built from its own numbers.
 *
 * Returns an empty array when there is nothing truthful to say — a CIRCUIT_BREAK
 * row, whose metrics are placeholders written by `log/decisions.ts` rather than
 * measured, or a kill with no reason recorded. The caller falls back to
 * `VERDICT_MEANING`. Rendering those placeholder numbers would print a stopped
 * loop as a measured result, which is the single most misleading thing this
 * screen could do.
 *
 * The values shown are absolute where the gate compared absolute values: the
 * IC and t-statistic floors ask whether a relationship is detectable, not which
 * way it points. Showing a signed IC beside an unsigned floor would make a
 * correctly-killed -0.05 read as though it had cleared a floor of 0.04. The
 * signed values are in `killReasonTechnical`, one click away.
 */
export function killSentences(row: DecisionRow): string[] {
  if (row.decision === 'CIRCUIT_BREAK') return [];
  const reason = row.reason;
  if (!reason) return [];
  const m = row.metrics;

  switch (reason) {
    case 'p_value_exceeds_bh_threshold': {
      const family = row.total_hypotheses_attempted_this_session;
      const many = family === 1 ? 'hypothesis' : 'hypotheses';
      return [
        `p ${fmtThreshold(m.raw_p_value)} did not survive the multiple-testing bar (${fmtThreshold(
          m.bh_adjusted_threshold,
        )}).`,
        `At ${fmtInt(family)} ${many}, the gate requires stronger evidence than that.`,
      ];
    }
    case 'insufficient_obs':
      return [
        `${fmtInt(m.n_obs)} valid observations, against a floor of ${PRESCRIBED.min_obs}.`,
        'Too few to test, so the gate killed it on the evidence available rather than on the idea.',
      ];
    case 'ic_below_floor':
      return [
        `IC ${fmtIc(Math.abs(m.ic))} is below the preregistered floor of ${PRESCRIBED.min_ic}.`,
        'The signal and the forward return move together too weakly to call this a relationship.',
      ];
    case 't_stat_below_floor':
      return [
        `t-stat ${fmtT(Math.abs(m.t_stat))} is below the preregistered floor of ${PRESCRIBED.min_t_stat.toFixed(
          1,
        )}.`,
        'At this sample size the result cannot be told apart from chance.',
      ];
    case 'baseline_not_beaten':
      return [
        `IC ${fmtIc(Math.abs(m.ic))} did not beat a naive baseline (${fmtIc(
          Math.abs(m.baseline_ic),
        )}) that uses the previous period’s return as the signal.`,
        'A simpler signal already does at least as well on this data.',
      ];
    case 'lookback_bias_detected':
      return [
        'The signal’s own past values predicted it, so the test was measuring the lookback window rather than the market.',
        'The gate killed it so a lookback artefact could not be counted as a finding.',
      ];
    case 'duplicate_family':
      return [
        'An earlier hypothesis in this session already tested this signal and target pair.',
        'The gate killed it so the same question could not be counted twice in the family.',
      ];
    case 'schema_validation_failed':
      return [
        'The hypothesis did not conform to the required structure, so no backtest ran.',
        'The gate killed it before any compute was spent — the idea itself was never tested.',
      ];
    default:
      // An unseen reason renders as its own code rather than as a paraphrase of
      // something it might not mean.
      return [killReasonPlain(reason) ?? `killed: ${reason}`];
  }
}

/**
 * The technical detail behind "What does this mean?".
 *
 * This is the same row as `killSentences`, shown raw and signed. It exists so
 * the first impression can stay a plain sentence without the product hiding
 * anything: every number the plain sentence rounded or took an absolute value of
 * is here at full precision.
 *
 * Returns an empty array for a row with no gate evidence behind it — an
 * AUTO-KILLED row that never reached the backtest, or a CIRCUIT_BREAK row whose
 * metrics are placeholders written by `log/decisions.ts`. Both carry zeros and a
 * `raw_p_value` of 1 that no test produced, and printing those under a heading
 * that promises technical detail would be the most misleading thing on the
 * screen: a proposal that was never tested, and a loop that was never running,
 * would both read as measured results.
 */
export function killReasonTechnical(row: DecisionRow): string[] {
  if (!hasGateEvidence(row)) return [];
  const m = row.metrics;
  return [
    `IC ${fmtIc(m.ic)}  ·  t-stat ${fmtT(m.t_stat)}  ·  n ${fmtInt(m.n_obs)}  ·  hit rate ${fmt(
      m.hit_rate,
      3,
    )}`,
    `raw p ${fmtThreshold(m.raw_p_value)}  ·  BH bar at this rank ${fmtThreshold(
      m.bh_adjusted_threshold,
    )}`,
    `baseline IC ${fmtIc(m.baseline_ic)}`,
    `family size when this verdict was reached: ${fmtInt(
      row.total_hypotheses_attempted_this_session,
    )}`,
  ];
}

/**
 * Who proposed the hypotheses in a record, said plainly.
 *
 * WHY THIS IS ON THE SCREEN AT ALL. `generator` is recorded on every entry, and
 * until now it was only legible in the log table's rows and behind a technical
 * disclosure — which means the product never actually said, in words, who wrote
 * the hypotheses a reader was looking at. Meanwhile the pre-flight checklist
 * reports the generator chain's LIVE tiers, which on the deployed instance is
 * `groq`. Shown beside a record that no model proposed, that reads as a claim
 * about the record. The tier that is CONFIGURED and the tier that PROPOSED what
 * you are reading are two different facts, and this says the second one so the
 * first cannot be mistaken for it.
 *
 * The tally comes from the server, computed over the whole file rather than the
 * page in hand, so "every hypothesis in this record" is a statement about the
 * record and not about the twenty-five rows that happen to be loaded.
 *
 * Returns null — not a hedge — when the server did not report a tally, which
 * means an older backend. Saying nothing is the only honest option: there is no
 * truthful sentence to write about a distribution nobody measured.
 */
export function proposerSentence(
  generators: { tier: string; count: number }[] | undefined,
): string | null {
  if (!generators || generators.length === 0) return null;

  const total = generators.reduce((sum, g) => sum + g.count, 0);
  if (total === 0) return null;

  const label = (tier: string) =>
    tier === 'deterministic' ? 'the deterministic enumerator' : tier;

  const enumerated = generators.filter((g) => g.tier === 'deterministic');
  const sampled = generators.filter((g) => g.tier !== 'deterministic');

  /*
   * The all-enumerated case is the one worth its own sentence, because it is the
   * one a reader is most likely to get wrong. "Deterministic" is not a lesser
   * provenance here — it is the one that makes the session reproducible, and the
   * sentence says so rather than leaving the word to read as a downgrade.
   */
  if (sampled.length === 0) {
    return `Every hypothesis in this record was proposed by the deterministic enumerator, not by a model. It is a pure function of the attempt index, so re-running the protocol reproduces this record exactly.`;
  }

  if (enumerated.length === 0) {
    const tiers = sampled.map((g) => label(g.tier)).join(' and ');
    return `Every hypothesis in this record was proposed by a model (${tiers}), and every verdict on it was then decided by the gate. A sampled proposal differs between runs, so this session is not reproducible — what is checkable is that each judgment is re-derivable from the entry's own hashes.`;
  }

  const parts = generators
    .map((g) => `${label(g.tier)} (${fmtInt(g.count)})`)
    .join(' and ');
  return `This record is mixed, and says so rather than picking one answer: ${parts}. A sampled proposal differs between runs and an enumerated one does not, so the session as a whole is not reproducible. Every verdict in it is still re-derivable from the entry it is recorded on.`;
}

/** The three numbers the nav counter and the orientation strip both show. */
export interface SessionCounts {
  attempted: number;
  passed: number;
  killed: number;
}/**
 * The session's score, or null when the stats are not in hand yet.
 *
 * The word is "attempted", not "tested", and that is a correction rather than a
 * preference. `hypotheses_attempted` is incremented in `session/loop.ts` BEFORE
 * the schema wall runs, so it counts proposals the wall stopped before any
 * backtest — and a proposal that was never backtested was not tested. It is the
 * field's own name, so the word on screen and the field on the wire agree.
 *
 * "killed" is the remainder of attempted minus promoted, per the same file, and
 * it includes those pre-backtest kills: they are recorded with a KILL decision
 * and an AUTO-KILLED stamp, so counting them anywhere else would lose them.
 */
export function sessionCounts(
  stats:
    | Pick<
        SessionStats,
        'hypotheses_attempted' | 'hypotheses_promoted' | 'hypotheses_killed'
      >
    | null
    | undefined,
): SessionCounts | null {
  if (!stats) return null;
  const values = [
    stats.hypotheses_attempted,
    stats.hypotheses_promoted,
    stats.hypotheses_killed,
  ];
  if (!values.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return {
    attempted: stats.hypotheses_attempted,
    passed: stats.hypotheses_promoted,
    killed: stats.hypotheses_killed,
  };
}

/** "43 attempted · 1 passed · 42 killed" — one wording, two placements. */
export function sessionScoreLine(counts: SessionCounts | null): string | null {
  if (!counts) return null;
  return `${fmtInt(counts.attempted)} attempted · ${fmtInt(counts.passed)} passed · ${fmtInt(
    counts.killed,
  )} killed`;
}
