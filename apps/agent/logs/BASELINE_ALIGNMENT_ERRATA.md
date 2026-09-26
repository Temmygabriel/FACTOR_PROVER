# Errata: the `baseline_ic` field is misaligned

**Found:** 2026-09-26, while checking the v1.1 preregistration's own predictions.
**Status:** defect present in the engine; **measured to change no verdict in either
published record**; not fixed before submission — see §6 for why and what the fix is.

This document is written because the project's central claim is that every field in
the record can be checked. A field that cannot be trusted has to be named, not
quietly left in place.

---

## 1. The defect

`apps/agent/src/backtest/engine.ts`, lines 271–338. Two arrays are built during the
observation loop:

```ts
observations.push({ timestamp: t, signal_value: sv, target_return: ret });

// Naive baseline: the target's own trailing return over the same lookback.
const base = trailingReturn(series, idx, t, hypothesis.condition.lookback_minutes);
if (base !== null) baselineSignals.push(base);
```

`observations` gains an entry for **every** event. `baselineSignals` gains one **only
when the trailing return exists**. Then:

```ts
const usableForBaseline = Math.min(baselineSignals.length, ys.length);
const baselineIc =
  usableForBaseline >= 3
    ? pearson(baselineSignals.slice(0, usableForBaseline), ys.slice(0, usableForBaseline)).r
    : 0;
```

`baselineSignals` is therefore a **compacted** array, and `ys` is not. When any
observation has no trailing return, index *k* of `baselineSignals` is no longer the
baseline for index *k* of `ys` — the baseline series is shifted one place early for
every null. The correlation is then computed between the target's trailing return at
one timestamp and the forward return at a **different** timestamp.

A single null is enough. There is no `null` filter and no index carried alongside the
value.

## 2. Why it was not caught earlier

`trailingReturn` looks up the exact millisecond `t - lookback * 60000`. When the
target has no candle at that exact timestamp it returns `null`. This is rare for
BTCUSDT (24/7) and common for rTokens (2–8% candle coverage on weekends, and no
trading on US market holidays).

The preregistration for v1.1 predicted, correctly, that for `btc_spot_return ->
BTCUSDT` the signal and the baseline are the *same number*, so `|IC| == |baseline_IC|`
by algebra. That prediction is what exposed the bug: 25 of those candidates showed
`|IC| != |baseline_IC|`, which is arithmetically impossible if the pairing is correct.

The algebra was verified to hold at the value level: for E-0162, across 449
observations, `signal_value` equals the target's trailing return in **449 of 449**
cases (max absolute difference `0.000e+0`). The two series are identical. The
*correlation* differed only because the baseline array had been shifted.

## 3. Measured impact — v1.1 (`logs/v1.1.jsonl`, 320 entries)

| | |
|---|---|
| computable entries (`n >= min_obs`) | 249 |
| entries with ≥ 1 null baseline | 94 |
| largest null count in one entry | 16 |
| baseline-check outcome flips | **58** |
| **entries whose verdict changes** | **0** |

The 58 flips split into two groups:

- **56** where the bug failed a baseline check that truly passes. Of these, **53 were
  already killed earlier** in the preregistered precedence (`ic_below_floor`,
  `t_stat_below_floor`), so the reason and the verdict are both unchanged. The other
  **3** — `E-0251`, `E-0260`, `E-0264` — were killed *on* the baseline check.
- **2** where the bug passed a baseline check that truly fails. Both were already
  killed on an earlier check, so neither reason nor verdict moves.

For those 3 at-risk entries, the verdict is decided by the next check in the
precedence. Raw p-value against the BH bar:

| entry | raw p | BH bar | clears BH? |
|---|---|---|---|
| `E-0251` | 3.041e-2 | 2.500e-3 | no |
| `E-0260` | 3.746e-2 | 3.750e-3 | no |
| `E-0264` | 3.735e-2 | 3.438e-3 | no |

All three are more than an order of magnitude above their bar. With a corrected
baseline they are killed on `p_value_exceeds_bh_threshold` instead of
`baseline_not_beaten` — **a different reason for the same KILL**. The v1.1 headline
result, zero survivors, is unchanged.

P-values are unaffected by this defect: `p` is a function of `ic` and `n` only, and
both are computed from correctly-aligned arrays. Family-wide BH thresholds are
therefore also unchanged.

## 4. Measured impact — v1.0 (`logs/decisions.jsonl`, 201 entries)

| | |
|---|---|
| computable entries | 141 |
| entries with ≥ 1 null baseline | **137 of 141** |
| baseline-check outcome flips | 54 |
| **flips among the 1 PROMOTE** | **0** |

The defect is near-universal in v1.0 because rToken coverage is sparse.

The single promotion, `E-0006` / `H-0006` (`eth_spot_return -> RGOOGLUSDT`, 60m
lookback, 30m forward), is **not** one of the flips — its baseline-check outcome is
the same either way. Its numbers do change:

| | logged | correctly aligned |
|---|---|---|
| `baseline_ic` | `0.067253` | `-0.027364` |
| comparison | `|0.093904| >= |0.067253|` → beats | `|0.093904| >= |-0.027364|` → beats |

The correction **widens** the margin rather than eroding it: the true baseline is
weaker than the logged one. The one promotion in the published record survives on the
corrected computation. That promotion was separately killed out of sample on the
spent LOCKED_TEST pass (`logs/locked-test.jsonl`), which this defect does not touch.

## 5. What is wrong and what is not

**Wrong:** the `baseline_ic` field in most entries of both records. Wherever the
target had a missing candle at an observation's lookback offset, the recorded value is
a correlation against the wrong returns. In v1.1 that is 94 of 320 entries; in v1.0,
137 of 141 computable entries. The field should not be quoted as-is.

**Not wrong:** every `gate_decision`, every `gate_reason` **except** the three named
in §3, every `ic`, `t_stat`, `n_obs`, `hit_rate`, `raw_p_value` and every
`bh_adjusted_threshold`. No promotion in either record is an artifact of this defect,
and no kill that would otherwise have been a promotion was produced by it.

## 6. Why the engine was not changed before submission

Three reasons, stated so the decision can be disagreed with:

1. **Reproducibility.** The published records were produced by the engine as it
   stands. Changing the engine would mean HEAD no longer reproduces the
   `baseline_ic` values in the published record — the exact property the record
   exists to provide. A fix and this errata must land together, so the divergence is
   documented rather than discovered.
2. **It is a live-system change.** The deployed agent runs v1.0 on a schedule and
   writes to a committed log. Changing the meaning of a field mid-record, on the day
   before submission, would leave the record internally inconsistent.
3. **No verdict depends on it.** Measured, not assumed: 0 verdict changes across 320
   v1.1 entries and 201 v1.0 entries, and the one promotion survives with a wider
   margin.

**The fix** is small and belongs in one place: carry the timestamp alongside the
baseline value, or skip the observation when the trailing return is null, so the two
arrays cannot drift. The second is safer — it keeps every recorded correlation
computed over one aligned observation set. It should be applied together with a
re-run and a fresh disclosure rather than slipped in.

Anyone re-deriving these numbers can do so with the audits in
`src/scripts/audit-baseline.ts` (v1.1), `src/scripts/audit-v1-baseline.ts` (v1.0),
`src/scripts/audit-e0006.ts` (the promoted entry) and
`src/scripts/audit-signal-vs-baseline.ts` (the value-level equality check behind §2).
None of them writes a log.
