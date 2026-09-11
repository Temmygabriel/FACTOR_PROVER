# Bitget Data Feasibility Findings

All findings below were measured against the **live Bitget public API on 2026-09-11**, not
taken from documentation. Raw measurements are included so they can be re-verified.

Every request used unauthenticated public endpoints — no API key required.

---

## 1. Family 2 (OI shock) has no historical data — SPEC-BREAKING

Family 2 in the build spec is "Crypto OI shock → rToken return", requiring open-interest
*change over a lookback window*. Only a **current snapshot** is available publicly.

```
GET /api/v2/mix/market/open-interest?symbol=BTCUSDT&productType=usdt-futures
  -> 200 {"openInterestList":[{"symbol":"BTCUSDT","size":"37225.07..."}]}   # current only
```

Every historical variant returns `40404 Request URL NOT FOUND`:

| Endpoint probed | Result |
|---|---|
| `/api/v2/mix/market/history-open-interest` | 404 |
| `/api/v2/mix/market/open-interest-history` | 404 |
| `/api/v2/mix/market/oi-history` | 404 |
| `/api/v2/mix/market/history/open-interest` | 404 |
| `/api/v2/mix/market/openInterest` | 404 |

**Consequence:** a backtest needs OI at time *t* and *t − lookback*. Without history there is
no way to compute the signal. Family 2 cannot be built as specified. Options:

- Drop Family 2 (leaves 3 families — still a valid submission).
- Replace it with a signal that does have history (e.g. funding-rate *change* over a lookback,
  which is derivable from the funding history series).
- Record OI going forward and note the limitation honestly.

**Not yet tried:** accumulating our own OI snapshots from now until the deadline would build
~10 days of history — too short for a 100-observation gate. Not viable.

---

## 2. rTokens do not trade on weekends or US market holidays — SPEC-BREAKING for partitions

The spec splits history 60/20/20 by calendar time and asserts the gate needs ≥100 valid
observations. Measured coverage of `RCOINUSDT` 1-minute candles per UTC day:

| UTC date | Weekday | Candles | Coverage |
|---|---|---|---|
| 2026-08-28 | Fri | 1313 | 91.2% |
| 2026-08-29 | Sat | 33 | 2.3% |
| 2026-08-30 | Sun | 52 | 3.6% |
| 2026-08-31 | Mon | 1292 | 89.7% |
| 2026-09-01 | Tue | 1258 | 87.4% |
| 2026-09-02 | Wed | 1206 | 83.8% |
| 2026-09-03 | Thu | 1188 | 82.5% |
| 2026-09-04 | Fri | 1251 | 86.9% |
| 2026-09-05 | Sat | 38 | 2.6% |
| 2026-09-06 | Sun | 117 | 8.1% |
| 2026-09-07 | Mon (US Labor Day) | 65 | 4.5% |
| 2026-09-08 | Tue | 1235 | 85.8% |
| 2026-09-09 | Wed | 1188 | 82.5% |
| 2026-09-10 | Thu | 1113 | 77.3% |

**Pattern:** ~23 hours of continuous trading on normal US weekdays, with a ~1 hour daily halt
around 23:00–00:00 UTC. Weekends and US market holidays are effectively dead.

**Consequences:**

- A **calendar-time** 60/20/20 split gives wildly unequal amounts of *usable* data per
  partition, and a boundary can land inside a weekend, handing one partition almost nothing.
  Partitions should be split by **trading-session count**, not wall-clock.
- The daily ~1h halt means a forward window that crosses 23:00–00:00 UTC must be treated as
  a session boundary (the spec already anticipates this — it is correct here).

---

## 3. Forward windows are viable — but ONLY because of the spec's forward-fill rule

Spec rule: "gap ≤5 minutes → forward-fill with last valid close; gap >5 minutes → mark
INSUFFICIENT_DATA and auto-KILL; never interpolate across session boundaries."

Valid observation **starts per normal weekday** on `RCOINUSDT`, applying exactly that rule:

| Forward window | Thu 2026-09-10 | Wed 2026-09-09 |
|---|---|---|
| 15 min | 1008 | 1075 |
| 60 min | 858 | 890 |
| 240 min (4h) | 606 | 673 |
| 480 min (8h) | 366 | 433 |

**Without** the forward-fill rule — i.e. requiring every one of the N minutes to be literally
present in the response — these numbers collapse to near zero, because the raw series contains
many small 1–5 minute gaps:

```
7-day gap histogram (raw, unfilled): 10min x1, 6min x1, 5min x2, 4min x1,
                                      3min x14, 2min x55
```

A 240-minute window needs all 240 minutes present; a single 2-minute gap breaks it. So the
forward-fill rule is **load-bearing infrastructure**, not a nicety. Implementing the backtest
without it will auto-kill essentially every hypothesis for `insufficient_obs` and look like a
broken engine.

**Conclusion:** all four families clear the 100-observation floor, including Family 4's 8h
window — but only on weekdays, and only with forward-fill implemented.

---

## 4. Funding-rate history is paginated, ~2 months deep, 3 observations/day

```
GET /api/v2/mix/market/history-fund-rate?symbol=BTCUSDT&productType=usdt-futures
    &pageSize=100&pageNo=1   -> 100 rows  2026-08-08 .. 2026-09-10
    &pageSize=100&pageNo=2   -> 100 rows  2026-07-06 .. 2026-08-08
```

Funding settles every 8 hours → only **3 observations per day**. Over a ~44-weekday DISCOVERY
partition that is ~132 funding events, each spawnable into many overlapping forward-return
observations.

`RCOINUSDT` 1-minute candles begin around **2026-06-01** (found by bisection over the range
2024-01-01 → 2026-09-10). So the earliest DISCOVERY dates may have candles but no matching
funding history. **Partition boundaries must be set to the intersection of both series, not
the candle series alone.**

---

## 5. Overlapping-window autocorrelation — the central statistical threat

The numbers in §3 are *observation starts*, one per minute. A 4h-forward observation starting
at 10:00 and one starting at 10:01 share 239 of their 240 minutes of return data.

Naive Pearson IC and t-statistics on ~606 such overlapping observations per day are inflated
by roughly **sqrt(240) ≈ 15x**. A t-stat that would be ~0.16 on independent data reads as
~2.4 — clearing the spec's `min_t_stat: 2.0` floor on pure overlap.

**This directly undermines the submission's core claim.** The whole pitch is "a statistically
honest, falsifiable research protocol". If the gate promotes factors whose significance is an
artifact of window overlap, the honest framing collapses under any technically literate judge.

Mitigations, in order of preference:

1. **Non-overlapping sampling** — evaluate each hypothesis at intervals ≥ the forward window
   (e.g. one 4h observation per 4h). Cuts n by ~240x; still clears 100 on weekdays
   (~6/day × 44 days ≈ 264 for 4h).
2. **HAC / Newey-West standard errors** — keeps all observations, corrects the t-stat. More
   sophisticated, more implementation risk.
3. **Block bootstrap** — resample contiguous blocks.

Whichever is chosen must be **written into `config/gate_policy.json` at session start** and
disclosed, since the gate policy is preregistered and read-only thereafter. This is a
design decision that must be made before the gate is coded, not after.

---

## 6. Confirmed-good facts

**All 7 spec rToken symbols exist** on Bitget spot among **1200** `R*USDT` symbols
(1780 total symbols):

```
RCOINUSDT  RNVDAUSDT  RGOOGLUSDT  RAAPLUSDT  RAMZNUSDT  RSPYUSDT  RQQQUSDT   all FOUND
```

**Working endpoints:**

| Purpose | Endpoint | Notes |
|---|---|---|
| Candles | `/api/v2/spot/market/candles` | `granularity=1min`, `startTime`/`endTime` unix ms, **max 1000/request** |
| Funding (current) | `/api/v2/mix/market/current-fund-rate` | 8h interval |
| Funding (history) | `/api/v2/mix/market/history-fund-rate` | paginated, `pageNo`/`pageSize` |
| OI (current only) | `/api/v2/mix/market/open-interest` | no history available |
| Spot ticker | `/api/v2/spot/market/tickers` | price-sanity check for Execution Guard |
| Symbol list | `/api/v2/spot/public/symbols` | 1780 symbols |

Candles come from **two** endpoints with different limits and different 1-minute
retention — see §8. `startTime` is **ignored** by both — see §7.

**Bitget Agent Hub** is real: CLI is `bgc`, with `--paper-trading` (routes to Demo
environment), `--dry-run`, `--read-only`, and `--confirm` (required for high-risk ops).
Credentials are read from env vars and signed locally with HMAC-SHA256.

---

## 7. The candles endpoint paginates BACKWARD and ignores `startTime` — SILENT DATA LOSS

Measured directly against `/api/v2/spot/market/candles`:

| Request | What came back |
|---|---|
| `startTime=2026-06-15&endTime=2026-08-05&limit=1000` | `2026-08-05T04:51` .. `2026-08-05T23:59` — the **last** 1000 minutes of the range |
| `startTime=2026-06-15` only (no `endTime`) | `2026-09-10T04:26` .. `2026-09-10T23:52` — the most recent 1000 minutes; **`startTime` ignored entirely** |
| `endTime=2026-07-01` only, `limit=1000` | `2026-06-30T05:40` .. `2026-06-30T23:59` — the 1000 minutes **ending at** `endTime` |

**Consequence.** Walking *forward* from `startTime` returns one page and stops,
because the page it gets back is the tail of the window, not the head. A 52-day
DISCOVERY request silently yielded **1000 candles (16 hours) instead of 42,999**
and the backtest reported a 16-point observation grid instead of 762. Nothing
errored; the numbers were simply computed on 1.3% of the data.

**Correct approach.** Walk **backward from `endTime`**: send `endTime=cursor`
with no `startTime`, take the oldest row returned, and set the next cursor to
that row minus one minute. Implemented in `src/backtest/data.ts`.

---

## 8. There are TWO candle endpoints, and 1-minute retention depends on granularity — SPEC-BREAKING

| Endpoint | Max `limit` | 1-min retention |
|---|---|---|
| `/api/v2/spot/market/candles` | **1000** | shallow for BTC/ETH, deep for rTokens |
| `/api/v2/spot/market/history-candles` | **200** | deep — BTC/ETH back past 2026-04-01 |

Requesting `limit=300` or more from `history-candles` fails with
`40020 Parameter limit error`. Requesting an August `endTime` from `/candles`
for BTCUSDT returns an **empty array with `code: 00000`** — a success response
describing absent data, which is easy to mistake for "market was closed".

Earliest available 1-minute candle per symbol (measured by binary search on
`endTime`, 12-hour precision):

| Symbol | via `/candles` | via `/history-candles` |
|---|---|---|
| BTCUSDT | 2026-08-11 | **2026-04-01** (scan start) |
| ETHUSDT | 2026-08-11 | **2026-04-01** (scan start) |
| RNVDAUSDT | 2026-05-01 | 2026-04-21 |
| RCOINUSDT, RGOOGLUSDT, RAAPLUSDT, RAMZNUSDT, RSPYUSDT, RQQQUSDT | 2026-06-01 | 2026-06-01 |

**Intersection at 1 minute: 2026-06-01.** All three partitions
(DISCOVERY from 2026-06-15, VALIDATION from 2026-08-06, LOCKED_TEST from
2026-08-24) sit inside it **once `history-candles` is used**. Had the build
relied on `/candles` alone, Families 2 and 3 would have been silently
unbuildable for DISCOVERY and VALIDATION: their BTC/ETH signal legs would have
returned zero rows and every such hypothesis would have auto-KILLed for
`insufficient_obs` — a data-availability failure masquerading as a verdict on
the idea.

**Cost.** `history-candles` at 200 rows/request means one symbol's DISCOVERY
window is ~330 requests and ~6 minutes. See §10 for the resolution.

---

## 9. BTC funding rate is ceiling-ed at 0.0001 — thresholds above it select nothing

Measured over the DISCOVERY partition (156 settlements, 2026-06-15 .. 2026-08-05):

```
min -0.000125   p25 0.000005   median 0.000033   p75 0.000069   max 0.0001
15% of settlements sit at exactly 0.0001
```

| Threshold | Settlements above |
|---|---|
| `> 0.0001` | **0** |
| `> 0.00009` | 27 (17%) |
| `> 0.00005` | 61 (39%) |
| `> 0.00002` | 95 (61%) |
| `> 0` | 126 (81%) |

A hypothesis of the form `btc_funding_rate gt 0.0001` is therefore **vacuously
empty** — zero events, hence zero observations, hence an `insufficient_obs` KILL.
This is not an engine bug: it was the first hypothesis the end-to-end test ran,
and the engine was right to reject it.

**Implication for generation.** 0.0001 is the neutral/default rate and appears to
act as a cap, so `gt`/`gte` thresholds at or above it are dead on arrival. The
hypothesis prompt should state the attainable range, and the schema validator
should reject thresholds that cannot select a non-empty event set rather than
spending a backtest to discover it.

---

## 10. Resolution: frozen, hashed partition datasets

Because `history-candles` costs ~330 requests per symbol-partition and the
partitions are frozen anyway, the partition data is **fetched once, hashed, and
committed** to `apps/agent/data/frozen/` (one gzipped file per
symbol-partition-**kind**, plus a manifest of sha256 digests). Kinds are
`candles` and `funding`; see §11 for why freezing only the first was a mistake.

This turns a constraint into a strengthening:

- **Runtime is a file read**, not a six-minute crawl, so the app boots instantly
  and never depends on Bitget being up during a demo.
- **A DISCOVERY file contains only DISCOVERY**, so reading it *cannot* reach
  held-out data. The partition boundary is enforced by what the file contains,
  not only by a runtime assertion.
- **The dataset hash is recorded in every decision-log entry** as
  `dataset_sha256`. Any later edit to any frozen file is detectable from the log
  alone, which is far stronger evidence of a preregistered protocol than
  "we fetched live at run time".

The prefetch runs in GitHub Actions (`scripts/prefetch.ts`), which also keeps the
heavy network work off the development machine.

---

## 11. Freezing one of two legs is worse than freezing neither — HIGH

Section 10 froze the **candles**. It did not freeze the **funding rates**, and that
gap was invisible for a while because nothing errored.

A verdict in this protocol rests on two series: a price leg (the target's forward
return) and a signal leg (a funding rate, a spot return, or both). Freezing the
candles froze the price leg. But `computeSignalBundle` fetched funding live on
every backtest — and called `fetchCandles` *without* the partition option, so the
reference spot legs were going to the network too, even though their candle files
were sitting on disk.

So `dataset_sha256`, the hash recorded in every decision-log entry as evidence of
a preregistered protocol, covered the price legs and **silently missed the signal
legs behind most verdicts**. The provenance claim looked complete. It was partial.

This is the worst version of the problem, and it is worth stating plainly: a
dataset that covers *none* of a run is obvious — the run fails. A dataset that
covers *most* of a run produces a hash that reads as attestation while describing
something narrower than what actually happened.

**Fixed.** Funding is now frozen as `<COIN>__<PARTITION>.funding.json.gz`
(8-hourly settlements, `[fundingTime, fundingRate]`), for the two reference coins
only, since those are the only funding series any signal reads. Reference candle
files now carry a warm-up lead-in so the spot legs resolve from disk as well.

**And the verification was strengthened**, because the obvious test was not enough.
A numbers-only comparison — "does the frozen run reproduce the recorded live
values?" — **passes on a completely broken frozen path**, since a silent fallback
to the live endpoint returns the same data and therefore the same numbers. The
check now also asserts that the run reports its signal legs as coming from
`frozen`. Matching numbers prove the data is the same; they do not prove the store
answered.

522 funding settlements across 6 files (BTCUSDT and ETHUSDT × 3 partitions).

---

## 12. The partition bound is asymmetric — the END is absolute, the START is not

Warm-up reads reach back **before** their partition. A 240-minute spot return
evaluated at the partition's first grid minute needs a price 241 minutes earlier.
A funding step function needs the settlement in force at that minute. Under a
symmetric "the window must lie inside the partition" rule, every one of those
reads is refused — which pushes them onto the live network and reopens §11.

So `assertWithinPartition` now takes a bounded `leadInMs`, and the two bounds
behave differently:

| Bound | Rule |
|---|---|
| `endMs` | **Absolute.** Nothing after the partition end is ever read, and there is no parameter that relaxes it. |
| `startMs` | May be preceded by at most `leadInMs` of warm-up, capped at 7 days so the parameter cannot become a general exemption. |

The asymmetry is safe in the one direction it relaxes, and the reason is worth
being precise about: **data older than a partition has never been held out.**
DISCOVERY is the earliest window there is; VALIDATION's lead-in reaches only into
DISCOVERY, which has already been seen; LOCKED_TEST has its own separate gate.
Held-out data lives at the *end* of a partition's timeline, which is exactly why
the end is the bound that carries the protocol.

The lead-in is derived, not guessed: `CANDLE_LEAD_IN_MS` is computed from
`MAX_LOOKBACK_MINUTES`, the schema's own cap, plus an hour of headroom — so
raising the schema's lookback cap automatically widens the lead-in and freezes
enough history to satisfy it. Keeping those two numbers in separate files is how
you get a schema that permits a lookback the dataset cannot warm up.

Reference candle files carry a 300-minute lead-in; funding files carry 480
minutes (one settlement interval). Target files carry none, because the engine
reads a target at exactly its partition bounds.

---

## 13. A frozen file that cannot serve a warm-up read must return `null` — HIGH

The subtle failure introduced by §12: when a frozen candle file does **not** carry
enough lead-in to answer a warm-up read, the natural implementation clips the
request to what the file holds and returns a shorter array.

That is the dangerous outcome. A clipped array is a valid-looking candle list that
is simply missing its first few minutes, so `spotReturnSeries` drops the
observations that needed them, and the backtest returns a **different `n_obs` than
the same hypothesis measured against live data**. Nothing errors. Nothing warns.
The number just quietly changes.

`frozenCandlesFor()` therefore returns `null` rather than a clipped array when a
warm-up read cannot be served. The caller falls through to the live endpoint and
*reports itself as `live`*, which turns an invisible numeric discrepancy into a
visible provenance gap. A shortfall at the start of a request that is **not**
reaching back for warm-up is a different thing — an ordinary data gap at the
partition boundary — and is returned as-is.

---

## 14. A missing signal leg silently halves a combined hypothesis — HIGH

Found while verifying the frozen store against the live numbers it was supposed to
reproduce. Two of the three recorded baselines matched exactly. The third did not:

```
btc_funding_x_spot gt 0.00005 -> RQQQUSDT 60m
  recorded live : n=352, IC -0.0035, t -0.065, p 0.948
  frozen        : n=167, IC  0.0262, t  0.336, p 0.737
```

The frozen store was the correct one, and the recorded baseline was the broken
number — which is the outcome worth pausing on, because a verification pass that
assumes the *recorded* value is the target would have "fixed" the wrong side.

**What happened.** `computeSignalBundle` returns the second leg as
`spotLeg: SignalPoint[] | null`. When the spot series came back empty it was
returned as `[]` — not `null` — and **an empty array is truthy**. The engine's
guard was:

```ts
const spot = bundle.spotLeg ? (spotByTs.get(t) ?? null) : null;
```

`[]` passes the truthiness test, `spotByTs.get(t)` finds nothing, `?? null` yields
`null`, and the sign filter inside `conditionHolds` was written as
`if (spotValue !== null)` — so it did not run. The hypothesis **silently degraded
into its funding leg alone** and reported the result as a two-condition test.

**The measurement that proved it.** The condition `btc_funding gt 0.00005` selects
exactly **352** of the 864 grid points on its own — the recorded "live" figure to
the observation. Adding the sign requirement cuts it to **167**. A 48%
survival rate is what an independent sign filter should do; 100% is what a filter
that never ran looks like. The spot leg was present and populated for all 352
points the whole time; nothing about the data was missing. Only the *evaluation*
was.

**Why this is worse than a crash.** The half-condition number is
`IC -0.0035, p 0.948` — a completely ordinary-looking null result. It did not
announce itself, it was recorded, and it would have been published. A combined
hypothesis carries a stronger claim than either leg alone, so a silently
one-legged evaluation systematically **overstates the evidence** behind exactly
the family that claims the most.

**Resolution.** The rule now lives in the predicate rather than in the caller's
guard, so there is one place to read it:

```ts
if (COMBINED_SIGNALS.includes(hypothesis.signal)) {
  if (spotValue === null) return false;   // a missing leg is not a pass
  ...
}
```

A combined hypothesis whose spot leg is unmeasurable now drops every observation,
ends at `n_obs = 0`, and returns an honest `insufficient_obs` KILL — a verdict
that describes what actually happened.

**The generalisable lesson, which is the same one as §11 and §13.** Numbers
matching is not evidence that the right computation ran. §13 covers a dataset
that quietly supplies *less* data; this covers a predicate that quietly evaluates
*less of its condition*. Both produce plausible figures. The defence that
actually works is not comparing outputs, it is asserting on the **inputs the
computation claims to have used** — here, that the combined count is strictly
less than the funding-only count. That inequality is now a permanent check in
`_dbgfrozen.mjs`, and it is the check that would have caught this the first time.

---

## Summary of required spec amendments

1. **Drop or replace Family 2** — no OI history exists (§1).
2. **Split partitions by trading session, not calendar time** — and bound them by the
   intersection of candle and funding history (§2, §4).
3. **Implement forward-fill before the backtest is trusted** — it is load-bearing (§3).
4. **Choose and preregister an overlap correction** — without it the core claim is false (§5).
5. **Page candles backward from `endTime`** — `startTime` is ignored, and a forward
   walk silently returns 1.3% of the requested range (§7).
6. **Use `history-candles` for BTC/ETH signal legs** — `/candles` has no 1-minute
   data for them before 2026-08-11 (§8).
7. **Preregister attainable signal thresholds** — funding thresholds at or above
   0.0001 select an empty event set (§9).
8. **Split the partition bound in two** — the end must be absolute, the start must
   permit a bounded warm-up lead-in, or every signal's warm-up read goes to the
   network and the committed dataset stops describing the run (§12).
9. **Freeze every series a verdict rests on, not just the prices** — and verify by
   *source*, not by matching numbers, since a silent live fallback reproduces the
   same numbers and will pass a numbers-only check (§11, §13).
10. **Treat a missing signal leg as a dropped observation, never as a pass** — a
    combined hypothesis evaluated on one leg reports a plausible number about a
    claim it did not test (§14).
