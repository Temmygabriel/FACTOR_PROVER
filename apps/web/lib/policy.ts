/**
 * The preregistered thresholds, mirrored from apps/agent/config/gate_policy.json
 * (v1.0, locked 2026-09-11) and config/partitions.json (v1.0).
 *
 * WHY THESE ARE HERE AT ALL. The API reports the thresholds it APPLIED per
 * entry — `bh_adjusted_threshold`, `fdr_level`, and the boolean checks — and
 * those are always the numbers rendered next to a verdict. What the API does not
 * report is the absolute floor each check was judged against (min_ic,
 * min_t_stat, min_obs), so the stamp cannot say "0.041 against a floor of 0.04"
 * without a copy of the preregistered values.
 *
 * So these constants are for LABELLING, never for deciding anything: they are
 * printed as the bar, and the passed/not-passed result beside them always comes
 * from the entry's own `checks` block. If a future session ran a different
 * policy, the labels here would be wrong and the verdicts would still be right,
 * which is why `provenance.policy_sha256` is rendered next to them.
 */

/** From gate_policy.json. Changing these invalidates a session. */
export const PRESCRIBED = {
  policy_version: 'v1.0',
  locked_at: '2026-09-11T00:00:00Z',
  fdr_level: 0.1,
  min_ic: 0.04,
  min_t_stat: 2.0,
  min_obs: 100,
} as const;

/**
 * The circuit breaker's limits, from gate_policy.json's `circuit_breaker`
 * block. The counters come from `GET /api/status`; these are the denominators
 * that make them readable ("43 of 200"), so the panel can show how close the
 * loop is to tripping rather than only that it tripped.
 */
export const BREAKER_LIMITS = {
  max_hypotheses_per_day: 200,
  max_promotes_per_day: 10,
  max_paper_orders_per_day: 20,
  max_consecutive_llm_failures: 3,
} as const;

/**
 * Partition boundaries, from partitions.json v1.0. The API reports
 * `partitions_sha256` but not the window dates, so they are mirrored here and
 * labelled with their source on screen. The hash beside them is what a reader
 * should check if they doubt the label.
 */
export const PARTITIONS = {
  version: 'v1.0',
  discovery: { start: '2026-06-15T00:00:00Z', end: '2026-08-05T23:59:59Z' },
  validation: { start: '2026-08-06T00:00:00Z', end: '2026-08-21T23:59:59Z' },
  locked_test: { start: '2026-08-24T00:00:00Z', end: '2026-09-10T23:59:59Z' },
} as const;

/**
 * The order the checks are rendered in, and the reason it is this order: it is
 * the preregistered `kill_reason_precedence`, which runs from "the test was not
 * meaningful" (too few observations to compute anything) outward to "the test
 * was meaningful and did not clear the bar". The first failing row is therefore
 * the reason named in the stamp's own line, and a reader can watch the reason
 * being derived rather than being told it.
 */
export const CHECK_ORDER = [
  'passed_min_obs',
  'passed_ic_floor',
  'passed_t_stat_floor',
  'passed_baseline_beat',
  'passed_bh',
] as const;
