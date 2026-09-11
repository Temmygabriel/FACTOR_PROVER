/**
 * Prompt construction.
 *
 * The model proposes a hypothesis as strict JSON. It does not compute anything,
 * does not see price data, and cannot influence a verdict. Everything it knows
 * about what is possible comes from this file — so the constraints measured
 * against real Bitget data are stated here explicitly rather than left for the
 * model to discover by proposing something dead.
 *
 * Two design rules:
 *
 *  1. NO FREE TEXT INSIDE THE SCHEMA. Every field is an enum member, an integer
 *     in a bounded range, or a number. A proposal with prose in it fails
 *     validation and is logged as a schema failure.
 *
 *  2. STATE THE FAILURE MODES. A model that has not been told the funding rate
 *     is capped at 0.0001 will propose `gt 0.0001` and burn a backtest learning
 *     nothing. The prompt therefore carries the measured ranges and the power
 *     analysis, and says plainly which thresholds are dead.
 */

import {
  DIRECTIONS,
  FAMILY_SIGNALS,
  FAMILY_WINDOW_BOUNDS,
  MAX_LOOKBACK_MINUTES,
  OPERATORS,
  RTOKEN_SYMBOLS,
  SIGNAL_IDS,
  type ExperimentFamily,
  type LLMContext,
} from '../types.js';

/** Human-readable description of each signal, for the prompt. */
const SIGNAL_DESCRIPTIONS: Record<string, string> = {
  btc_funding_rate:
    "BTC perpetual funding rate, settled every 8h and held constant between settlements. Range over the discovery window: -0.000125 to 0.0001. It is CAPPED at 0.0001, so `gt 0.0001` selects nothing.",
  eth_funding_rate:
    "ETH perpetual funding rate, same mechanics and same 0.0001 cap. Range: -0.00015 to 0.0001.",
  btc_spot_return:
    "BTC spot percent return over `lookback_minutes`. Units are PERCENT: a value of 0.25 means +0.25%. Thresholds under 0.01 select essentially every bar and are rejected.",
  eth_spot_return:
    "ETH spot percent return over `lookback_minutes`. Units are PERCENT, as above.",
  btc_funding_x_spot:
    "Conjunction: the funding-rate threshold must hold AND the BTC spot return over the lookback must agree in sign with `direction`. The threshold applies to the funding leg only.",
};

export function buildSystemPrompt(): string {
  const familyLines = (Object.keys(FAMILY_SIGNALS) as ExperimentFamily[])
    .map((f) => {
      const b = FAMILY_WINDOW_BOUNDS[f];
      return `  - ${f}: signals [${FAMILY_SIGNALS[f].join(', ')}], forward window ${b.min}-${b.max} minutes`;
    })
    .join('\n');

  return [
    'You are a quantitative researcher proposing ONE testable market hypothesis.',
    '',
    'You are part of a falsification system, not a prediction system. Your',
    'hypotheses will be tested against a frozen historical dataset and most will',
    'be rejected. A clean rejection is a valid, expected, useful outcome. Do not',
    'try to propose something that will pass — propose something that is',
    'interesting and genuinely testable. Reaching for significance by proposing',
    'many near-identical variants is the specific failure this system exists to',
    'detect, and the multiple-testing correction will catch it.',
    '',
    'OUTPUT: a single JSON object, and nothing else. No prose, no markdown, no',
    'code fences, no explanation before or after.',
    '',
    'EXACT SHAPE:',
    '{',
    '  "signal": <one of the allowed signals>,',
    '  "condition": {',
    '    "operator": <one of: ' + OPERATORS.join(', ') + '>,',
    '    "threshold": <number>,',
    '    "lookback_minutes": <integer, 1..' + MAX_LOOKBACK_MINUTES + '>',
    '  },',
    '  "target": <one of: ' + RTOKEN_SYMBOLS.join(', ') + '>,',
    '  "direction": <' + DIRECTIONS.join(' | ') + '>,',
    '  "forward_return_minutes": <integer, bounded by family below>,',
    '  "experiment_family": <one of the families below>',
    '}',
    '',
    'FAMILIES (signal and forward-window bounds are enforced):',
    familyLines,
    '',
    'SIGNALS:',
    ...SIGNAL_IDS.map((s) => `  - ${s}: ${SIGNAL_DESCRIPTIONS[s] ?? ''}`),
    '',
    'HOW A HYPOTHESIS IS TESTED:',
    'The condition SELECTS a set of observations. At every non-overlapping',
    'interval of `forward_return_minutes` on the target\'s timeline, if the',
    'condition holds, one observation is recorded: the signal value, and the',
    "target's forward return over the next `forward_return_minutes`. The system",
    'then measures whether the signal and the forward return move together, and',
    'how likely that relationship would be under pure noise.',
    '',
    'So `threshold` decides WHICH moments you are betting on, and `direction`',
    'decides WHICH WAY. A hypothesis with a threshold that almost always holds',
    'has no contrast and will not be distinguishable from noise.',
    '',
    'MEASURED CONSTRAINTS (do not propose against these):',
    '- The BTC/ETH funding rate is capped at 0.0001. A `gt`/`gte` threshold at or',
    '  above the cap selects zero observations and is refused before testing.',
    '- Statistical power falls steeply with the forward window. Over the',
    '  discovery partition, non-overlapping observation counts and the correlation',
    '  each window needs to reach t = 2.0:',
    '      15m -> 3126 obs, needs |IC| >= 0.036',
    '      30m -> 1547 obs, needs |IC| >= 0.051',
    '      60m ->  742 obs, needs |IC| >= 0.073',
    '     120m ->  346 obs, needs |IC| >= 0.107',
    '- Windows beyond 120 minutes are refused: too few independent observations',
    '  remain to reach significance at all.',
    '- Real markets rarely produce |IC| above 0.10 at these horizons. A hypothesis',
    '  that would only pass with an implausibly strong effect is not a good bet.',
    '',
    'Choose thresholds from the MEASURED distribution, not from intuition:',
    'funding rates in the discovery window had a median of 0.000033 and a 75th',
    'percentile of 0.000069. A threshold of 0.00005 selects a minority of moments;',
    'a threshold of 0.000005 selects almost all of them.',
  ].join('\n');
}

/**
 * The user turn: the current session state, as typed numbers.
 *
 * `recent_kills` and `promoted_factors` are included so the model can avoid
 * re-proposing something already tested, and `hypotheses_attempted` so it can
 * see how the multiple-testing bar is tightening as the session grows.
 */
export function buildUserPrompt(ctx: LLMContext): string {
  return [
    'Current session state:',
    '',
    JSON.stringify(ctx, null, 2),
    '',
    'Propose ONE hypothesis that has not already been tested or killed. Return',
    'only the JSON object.',
  ].join('\n');
}
