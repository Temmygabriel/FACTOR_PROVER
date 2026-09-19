# Factor Prover — Build Progress

**Hackathon:** Bitget AI × Crypto Hackathon — Genesis Season 2, Agentic Trading track
**Deadline:** 2026-09-21
**Repo:** https://github.com/Temmygabriel/FACTOR_PROVER (public)
**Specs:** `factor_prover_build_spec.md`, `factor_prover_design_spec.md`

---

## Status at a glance

| Phase | State |
|---|---|
| Spec study | Done |
| Live API feasibility recon | Done — 6 findings, 2 spec-breaking |
| Repo scaffold | Done |
| Frozen partition datasets | **Done — 33 files, 844,839 candle + 522 funding rows, integrity verified** |
| Tester (backtest engine) | **Done — verified end-to-end on real data; frozen↔live reproduction 28/28** |
| Statistical core (IC/t/p/BH) | **Done — 12/12 checks vs published t-tables** |
| Gate (deterministic adjudication) | **Done — verified across 11 cases** |
| Hash-chain verifier | **Done — verified against 7 corruption cases** |
| Schema validator | **Done — incl. measured funding-cap rejection** |
| LLM provider layer | **Done — Groq → Gemini → deterministic, verified** |
| Session loop + event bus + family registry + paper ledger | **Done — 26/26 end-to-end checks** |
| Execution Guard + circuit breaker | **Done — 5-check guard, breaker verified** |
| SSE stream + Express server | **Done — 41/41 route checks over real HTTP** |
| Secret redaction at the wire boundary | **Done — verified** |
| Frontend (Next.js) | **Done — 33 files; correctness pass found and fixed 9 bugs** |
| Test suites + CI workflow | **Green — 13 files, 406 tests, both Node 20 and 24** |
| GitHub repository | **Live — `Temmygabriel/FACTOR_PROVER`, 4 commits, CI on every push to `main`** |
| CI: typecheck + test + build | **Green — 4/4 jobs. 3 type errors and 8 test failures found and fixed en route** |
| Frontend production build | **Verified — `next build` compiled; 4 routes, 6 static pages generated** |
| Frozen dataset integrity job | **Green — every file re-hashed against the committed manifest on every push** |
| Render backend deploy | **Live and verified — `https://factor-prover-agent.onrender.com`** |
| Vercel deploy | **Live — `NEXT_PUBLIC_API_BASE_URL` set at project creation** |
| UI redesign brief (8 changes) | **6 of 7 implementable changes done; Change 8 has no target route** |
| Demo run workflow | **Green — was pinned to a Node that cannot run it. See finding 31.** |
| **Committed demo run** | **DONE — 200 hypotheses, 201 entries, chain intact (`6022039`)... see "The demo run"** |
| **Deployed site vs. committed record** | **FIXED — the copy is scoped to the session. Finding 35, verified live.** |
| README / demo-script numbers | **DONE — `README.md` written (it did not exist), `docs/DEMO_SCRIPT.md` written from the committed log. Finding 36.** |
| **Agent Hub command vector** | **VERIFIED against the real CLI — it was wrong in 4 ways and had never been run. Findings 37–42.** |

**Backend is deployed and independently verified (2026-09-12).** Render created
`factor-prover-agent` from the committed `render.yaml`; the deploy succeeded first try. The
service was then tested from outside by its own public URL rather than trusted because a
dashboard said "Deployed" — see "The deployment, verified" below for what was actually
checked. Everything the wire contract promises answers.

**Vercel-ready: yes, the build gate is passed.** `next build` ran on CI and produced all four
routes (`/`, `/log`, `/leaderboard`, `/_not-found`) with no build-time env var required, which
is the first time this frontend has ever been compiled. The frontend needs one thing at build
time — `NEXT_PUBLIC_API_BASE_URL` — and it is baked into the bundle, so it must be set *during*
the Vercel project creation, not after. Until the two are pointed at each other the deployed
frontend renders its `BackendNotice` panels by design rather than failing, but that is a
degraded demo, not the deliverable.

---

## The demo run (2026-09-13)

**The submission now has the artifact it was missing: a real session, recorded and committed.**

`apps/agent/logs/decisions.jsonl`, committed by `.github/workflows/demo-run.yml` as `6022039`
(201 entries, ~180 KB). It is produced by the same `SessionLoop` the deployed server runs,
against the committed frozen dataset, on the same Node major the service runs.

It had never once succeeded. The workflow was pinned to Node 20 and ran
`node --experimental-strip-types`, a flag Node 20 does not have, so it died at its first real
step with `node: bad option` and exit code 9 — before the session began. Finding 31 has the
detail, including the false comment that justified the pin.

| | |
|---|---|
| session id | `S-1a6c5d66` |
| bound | 200 iterations (the policy's own `max_hypotheses_per_day`) |
| hypotheses attempted | **200** |
| promoted / killed | **0 / 200** |
| log entries | **201** — 200 hypotheses, one of them decided twice |
| chain | **PASS** — chain intact and append-only |
| generator | `deterministic` (no provider key configured) |

**It stopped on its own bound, not on the circuit breaker.** That is guaranteed by the loop's
ordering rather than lucky: `runLoop()` tests the iteration limit *before* it calls
`breaker.check()`, and `recordHypothesis()` runs exactly once per iteration, so
`hypotheses_today` reaches 200 only on the iteration the bound check has already claimed. The
last event in the run log is `reached the configured iteration limit (200); stopping`. Worth
stating because the opposite outcome — a `CIRCUIT_BREAK` entry — would have meant the run was
cut off by its own safety rule, and the runner prints a NOTE saying so.

**Why each hypothesis was decided** (this is the shape of a session, and it is a result):

| count | reason |
|---|---|
| 73 | `ic_below_floor` |
| 58 | `t_stat_below_floor` |
| 31 | `duplicate_family` |
| 29 | `insufficient_obs` |
| 8 | `p_value_exceeds_bh_threshold` |
| 1 | `baseline_not_beaten` |
| 1 | `PROMOTE` |

**Zero promotions, and one of them was promoted first.** H-0006 clears the gate at m=6, and is
re-adjudicated to `KILL` at **m=7** because the Benjamini-Hochberg threshold at rank 1 falls as
the family grows — the exact behaviour the gate was built to have, visible in the committed
record for the first time. It is also what makes the log 201 entries long for 200 hypotheses,
and it exposed finding 33.

*Corrected 2026-09-14:* this paragraph said "m=8" and that was wrong, in the same family as
finding 33. `m` is the count of hypotheses that produced a p-value, not the count of log
entries — E-0008 is the eighth *entry* but the seventh *testable* hypothesis, because E-0005
was excluded for `insufficient_obs`. The entries state it themselves: E-0006's `gate_detail`
reads "rank 1 of **6**" and E-0008's reads "rank 1 of **7**", and 0.1/6 = 0.016667 and
0.1/7 = 0.014286 are exactly the `bh_adjusted_threshold` values logged against them. The
correction matters because the wrong number was about to be written into the README.

This is the honest outcome, not a disappointing one: the whole claim is that the protocol
reports what it found. Every hypothesis died at a preregistered bar, the bars are quoted per
entry, and the one that briefly survived was demoted by the correction that exists to catch
exactly that. Spec §16's example numbers — a PROMOTED factor at "IC 0.071, t 2.41, obs 187" —
remain mathematically impossible (finding 7). **Fixed 2026-09-14:** the README is written and
`docs/DEMO_SCRIPT.md` is written, both from the committed log's actual numbers. See finding 36
for why replacing the numbers was not sufficient.

**Re-runnable by anyone, with no secrets.** Actions → Demo run → Run workflow. With
`commit: false` it re-runs the session and fails if the decisions differ from the committed
ones, leaving the tree alone — so the reproducibility claim is checked rather than asserted.

---

## Decisions taken

Locked by the builder on 2026-09-11:

1. **Loop host: Render free tier + Vercel frontend**, per spec §2 architecture.
   A standalone Node service runs the autonomous loop and exposes the REST + SSE API;
   the Next.js app on Vercel consumes it. Enables true live SSE streaming.
   *Accepted risk:* Render free web services sleep after ~15 min idle with a 30–60s cold
   start. Mitigated by a **keep-warm ping** (scheduled GH Action or cron hitting `/api/status`).
   Railway was rejected — it has no real free tier, only a 30-day $5 trial.
2. **Family 2 (OI shock) is DROPPED.** No historical OI data exists publicly (§1 of
   DATA_FINDINGS). Submission ships **3 families**: funding→rToken, BTC momentum→rToken,
   combined cross-asset. `oi_shock_to_rtoken` is removed from the `ExperimentFamily` enum
   and `btc_open_interest`/`eth_open_interest` from `SignalId`.
3. **Overlap correction: non-overlapping sampling.** One observation per forward-window
   length (one 4h obs per 4h block). Frozen into `config/gate_policy.json` as
   `"sampling": "non_overlapping"` and disclosed. Clears the 100-obs floor (~264 for 4h
   over the discovery window).
4. **LLM: provider-agnostic wrapper, three-tier.** Groq (primary, free, no card,
   OpenAI-compatible) → Google Gemini (automatic fallback on rate limit/429) →
   deterministic enumerator (last resort so the loop never dies). Provider selected by
   env var; no code change to switch. Spec §12's model IDs are invalid and must not be used.
   The `generator` field is recorded per hypothesis so the log is honest about which tier
   produced it.

**Heavy compute runs on GitHub Actions**, not locally — dev machine has 8GB RAM. Local work
= editing, reading, lightweight API probes only. **No local `npm install`.**

---

## Credentials required

| Credential | Needed for | Status |
|---|---|---|
| `GROQ_API_KEY` | LLM hypothesis generation (primary) | Builder to obtain — console.groq.com, free, no card |
| `GEMINI_API_KEY` | LLM fallback | Builder to obtain — aistudio.google.com, free, no card |
| `BITGET_API_KEY` / `_SECRET` / `_PASSPHRASE` | Agent Hub execution only | Not needed for market data (public) or backtesting |

---

## Open questions

None blocking.

---

## API key question — answered

**Yes, an LLM API key is required.** The LLM hypothesis generator is the core of the
product; it is not optional and there is no offline substitute.

- The spec assumes `ANTHROPIC_API_KEY` and an Anthropic SDK client.
- The spec's model IDs (`claude-sonnet-4-6`, `claude-opus-4-1`) **do not exist**. Current
  valid IDs are `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`.
- A Bitget API key is a *separate* credential and is not needed for read-only market data
  (public endpoints need no key). It is only needed for Agent Hub execution.

See `docs/DATA_FINDINGS.md` for the full evidence.

---

## Verified API findings (2026-09-11)

Full detail and evidence: `docs/DATA_FINDINGS.md`

| # | Finding | Severity |
|---|---|---|
| 1 | OI history endpoint 404s — **Family 2 unbuildable** | Spec-breaking |
| 2 | rTokens have no weekend/holiday data (2–8% coverage) | Spec-breaking for partitions |
| 3 | Overlapping forward windows inflate t-stats ~15x | Statistical integrity |
| 4 | Funding history only ~2 months; 3 obs/day | Scope limit |
| 5 | Forward windows viable once ≤5min forward-fill applied | Resolved — good news |
| 6 | All 7 rToken symbols exist; 1200 total; 1000-candle/request cap | Confirmed |

### Post-build findings (2026-09-11)

| # | Finding | Severity |
|---|---|---|
| 7 | **Spec §16 demo numbers are mathematically impossible.** It shows "IC 0.071, t 2.41, obs 187". IC 0.071 at n=187 yields t=**0.968**, not 2.41. Getting t=2.41 at n=187 requires IC ≈ 0.175. The demo script's example PROMOTED factor cannot exist. All demo numbers must come from a real run. | Demo credibility |
| 8 | **480-minute (8h) forward windows are unsatisfiable.** Non-overlapping sampling yields only **70** valid observations in DISCOVERY (Jun 15–Aug 5), below the preregistered `min_obs: 100`. Every Family 4 hypothesis with an 8h window auto-KILLs for `insufficient_obs`. | Gate design |
| 9 | **Long windows need implausibly strong signals.** Non-overlapping observation counts and the IC required to clear `min_t_stat: 2.0`: 15m→3126 obs (IC≥0.036), 30m→1547 (IC≥0.051), 60m→742 (IC≥0.073), 120m→346 (IC≥0.107), 240m→161 (IC≥0.157), 480m→70 (impossible). | Strategy |
| 10 | **`min_ic: 0.04` is nearly dead weight.** The t-stat floor dominates at every realistic sample size; the IC floor only binds once n ≥ ~2500, i.e. only for 15-minute windows. | Gate design |
| 11 | **Spec §2's BH pseudocode is not the BH procedure.** It decides each hypothesis independently at `(rank/m)*q`. The real procedure is a step-up: find the largest k with `p_(k) <= (k/m)*q`, then reject every rank ≤ k. The spec's version can reject a hypothesis while accepting a worse one at a better rank. Implemented the standard step-up (strictly more permissive — the honest direction to err) and documented the deviation in `stats.ts`. | Correctness |

**Measured on the real DISCOVERY partition** (42,098 raw 1-min candles across 38 weekday fetches).

**Verified:** the statistical core passes 12/12 checks against published t-table values; BH step-up confirmed to reject full prefixes.

### End-to-end findings (2026-09-11, during Tester verification)

| # | Finding | Severity |
|---|---|---|
| 12 | **The candles endpoint paginates BACKWARD and ignores `startTime`.** Walking forward from `startTime` returns one page and stops, because the page returned is the tail of the window. A 52-day DISCOVERY request silently yielded **1,000 candles instead of 42,999** — the engine reported a 16-point observation grid instead of 762, and nothing errored. Fixed by walking backward from `endTime`. | **Silent data loss** |
| 13 | **Two candle endpoints with different 1-min retention.** `/spot/market/candles` (limit 1000) has **no BTC/ETH 1-min data before 2026-08-11**; `/spot/market/history-candles` (limit **200** max) reaches back past 2026-04-01. A `code: 00000` success with `data: []` means "no data", not "market closed" — easy to misread. | **Spec-breaking for Families 2 & 3** |
| 14 | **1-min intersection across all 9 symbols is 2026-06-01**, so all three partitions are covered *once `history-candles` is used*. Relying on `/candles` alone would have made Families 2 and 3 silently unbuildable for DISCOVERY and VALIDATION — every such hypothesis would have auto-KILLed for `insufficient_obs`, a data-availability failure wearing the costume of a verdict. | Resolved |
| 15 | **BTC funding rate is ceiling-ed at 0.0001.** Over DISCOVERY: min −0.000125, median 0.000033, max 0.0001, with 15% of settlements at exactly the max. `gt 0.0001` selects **zero** events. The validator must reject thresholds that cannot produce a non-empty event set. | Generation quality |
| 16 | **Resolution: frozen, hashed partition datasets.** `history-candles` costs ~330 requests per symbol, so partitions are fetched once, gzipped, hashed, and committed to `apps/agent/data/frozen/`. Runtime is a file read. A DISCOVERY file contains only DISCOVERY, so reading it *cannot* reach held-out data. The dataset hash is recorded per log entry as `dataset_sha256`. | Strengthening |

### Frozen-dataset findings (2026-09-11, during prefetch and wiring)

| # | Finding | Severity |
|---|---|---|
| 17 | **`partitions.json` listed only `BTCUSDT` as a reference asset**, but the schema licenses `eth_funding_rate` and `eth_spot_return`. Two of five signals would have been silently unbuildable — the LLM could propose them, validation would pass, and every such hypothesis would have died on missing data. ETHUSDT added before any session was recorded, and the addition is disclosed in the file rather than made quietly. | **Config gap** |
| 18 | **The prefetcher overwrote the manifest instead of merging it.** A `--symbols ETHUSDT` run wrote a 3-entry manifest over the 24 already recorded, leaving all 27 `.gz` files on disk but only 3 visible to `loadFrozenManifest()`. The failure is silent and corrosive: `frozenEntryFor()` returns null → the backtest falls through to **live API fetch** → verdicts are reached on data other than the frozen set, while `dataset_sha256` attests to a 3-file dataset. Fixed by merging; a guard now fails the run if any `.gz` on disk is absent from the manifest. | **Silent, hit the live tree** |
| 19 | **The deterministic fallback enumerated near-identical variants.** With `lookback_minutes` innermost, the first 20 proposals were one family, one signal, one target, one condition and one window — differing only in lookback. Measured: 150 of 199 consecutive steps changed ≤1 dimension. A model outage would therefore have produced exactly the multiple-testing anti-pattern this system exists to detect. Fixed with a strided walk (`i × 337 mod 2240`); measured average dimensions changed per step rose from **1.32 → 4.51**, with 0 of 199 steps changing ≤1. | **Design bug** |
| 20 | **The frozen dataset reproduces the live measurements — and caught a bug the live run had hidden.** Two of the three recorded baselines reproduced *exactly* against frozen data. The third did not: `btc_funding_x_spot gt 0.00005 -> RQQQUSDT 60m` recorded n=352, frozen gave n=167. The frozen figure was correct. An empty spot leg is `[]` rather than `null`, and `[]` is truthy, so the sign filter was skipped and the combined hypothesis was evaluated on its **funding leg alone** — 352 is exactly what the funding condition selects unaided. A plausible-looking null result (`IC −0.0035, p 0.948`) that would have been published. Fixed in `conditionHolds`; a missing leg now drops the observation and yields an honest `insufficient_obs` KILL. See DATA_FINDINGS §14. | **Silent — found by verification** |

| 21 | **`FUNDING_LEAD_IN_MS` was used in `signals.ts` but never imported.** A `ReferenceError` waiting on the first funding hypothesis — which is the *primary* family, so it would have fired within seconds of the session starting. Introduced during the funding-freeze work and not caught because the verification runs at that point exercised the combined path rather than the funding-only path. Fixed. Both legs are now covered by the frozen verification. | **Runtime crash, latent** |
| 22 | **`rebuild-manifest.ts --check` never compared against the committed `manifest.json`.** It recomputed every hash from disk and confirmed the files were internally consistent — but never asked whether the committed manifest *described* them. Demonstrated: edit one row count in `manifest.json`, run `--check`, and it printed "all files intact" and **exited 0**. `manifest.json` is what every reader resolves a frozen file through and what `dataset_sha256` attests to, so a drifted manifest breaks the provenance claim while CI stays green. Fixed; four tamper modes now each exit 1 (wrong row count, wrong sha256, file on disk with no entry, entry with no file). | **Integrity check with no teeth** |
| 23 | **The HTTP layer is the only thing between a public URL and a multi-hour session.** Three specific hazards, all fixed: (a) Express 4 does not catch a rejected promise from an `async` handler, so one transient network error in one request would have **killed the process** — every handler is now wrapped; (b) `last_error` and stream events carry arbitrary provider error text and are served to any browser — everything now passes through `redactSecrets` at the boundary; (c) a missing log file produced `unavailable_reason: "ENOENT: ... 'C:\Users\USER\...'"`, disclosing the deployment's filesystem layout from a public endpoint — now a written sentence. | **Public exposure** |
| 24 | **`cors({origin: true})` would let any website stop the session.** Two of the three control routes change session state, so a page the operator merely *visited* could end a running session. Replaced with an explicit `WEB_ORIGIN` allowlist (plus localhost for development). `ADMIN_TOKEN` is optional and, when unset, the server says so **loudly at boot** rather than leaving the exposure implicit. | **CSRF-shaped** |

### Frozen dataset as committed

33 files: **9 symbols × 3 partitions** of candles (27 files) + **2 reference symbols ×
3 partitions** of funding (6 files) — **844,839 candle rows + 522 funding rows**, ~4 MB gzipped.

```
combined dataset hash: sha256:b0fd26a32fa0314debb6d2784d09c01904d5e173a73b77809cd50558bdf2f02b
```

Both legs of every signal are frozen, not just prices: `candles` (`[ts, close]`) and
`funding` (`[fundingTime, fundingRate]`). Freezing only the price leg was rejected as
strictly worse than freezing neither — the backtest would read one leg from a hashed
file and the other from a live endpoint, so the recorded `dataset_sha256` would attest
to data the verdict did not rest on (DATA_FINDINGS §11).

Verified by `scripts/rebuild-manifest.ts --check`: every sha256 recomputed from the file
bytes, every row confirmed inside its partition window, timestamps confirmed strictly
ascending, all 33 expected `(symbol, partition, kind)` entries present, **and every
recomputed field compared against the committed `manifest.json`** (finding 22). A row
outside its partition would be the one failure that breaks the protocol's central claim,
so it is checked explicitly rather than assumed.

The four tamper modes that now exit 1, each verified by injecting it and re-running:

| Tamper | Reported as |
|---|---|
| a row count in the manifest edited | `row count differs from the committed manifest (disk 74805, manifest 74804)` |
| a sha256 replaced with zeros | `sha256 differs from the committed manifest — the committed record does not describe these bytes` |
| a `.gz` on disk dropped from the manifest | `on disk but ABSENT from the committed manifest … the backtest will silently fall back to the live endpoint` |
| a manifest entry with no file on disk | `present in the committed manifest but has NO file on disk — a stale entry` |

The reference-coin files carry a warm-up lead-in (300 min for candles, 480 min for funding)
so a lookback read is served from disk rather than the network. `frozenCandlesFor()`
returns `null` rather than a clipped array when it cannot serve such a read, because a
short array is a valid-looking list missing its first minutes and would silently change
`n_obs` (§13).

**Verification: `_dbgfrozen.mjs`, 28 checks, all passing.** It asserts three things, and
the third is the one that matters:

1. the store holds every candle and funding pair the signals need;
2. the frozen numbers reproduce the recorded live numbers;
3. **the frozen store is what answered** — `signalSources` reports `frozen`, not `live`.

(3) is not redundant with (2). A silent fallback to the live endpoint returns the same data
and therefore the *same numbers*, so a numbers-only check passes on a completely broken
frozen path. A fourth check now asserts that the combined hypothesis's `n_obs` is strictly
less than the funding-only count, because a spot leg that is silently ignored also produces
a plausible number — that is exactly how finding 20 stayed hidden.

### Build results actually observed

Real backtest runs on the DISCOVERY partition (not simulated):

| Signal | Condition | Target | Fwd | Grid | n_obs | IC | t | p | hit |
|---|---|---|---|---|---|---|---|---|---|
| btc_funding_rate | gt 0.00005 | RCOINUSDT | 60m | 762 | 312 | −0.0063 | −0.111 | 0.912 | 0.484 |
| btc_funding_rate | gt 0.00009 | RNVDAUSDT | 30m | 1760 | 327 | 0.0081 | 0.146 | 0.884 | 0.453 |
| btc_funding_x_spot | gt 0.00005 | RQQQUSDT | 60m | 864 | **167** | 0.0262 | 0.336 | 0.737 | 0.485 |

The combined row is the **corrected** measurement — both legs applied. It was previously
recorded as n=352 on a single leg; see finding 20 and DATA_FINDINGS §14.

These are the honest numbers: tiny ICs, insignificant t-statistics, below every
preregistered floor. All of them KILL — the correct outcome, and the point of the
project. The promotion path is exercised by synthetic fixtures in the test suite.

One number to be careful about: `baseline_ic` is **0.2660** on the combined case and
**0.4344** on the second. Those look large, and they are — the naive baseline is the
target's own trailing return, which on non-overlapping windows is highly autocorrelated
with the forward return. That is the baseline the gate requires a candidate to *beat*,
so a high baseline makes promotion harder, never easier. It is recorded rather than
tuned.

Gate behaviour was verified on 11 cases, including the one that matters most: **the
same candidate with p = 0.001 is PROMOTED at m = 5, 20 and 60, and KILLED at m = 200**,
because the BH threshold at rank 1 falls from 0.02 to 0.0005 as the family grows.
Verdicts are revisable by construction, and a demotion is appended as a new entry.


### The HTTP layer

`src/index.ts` serves `src/api/contract.ts` and nothing else. It computes no statistics of
its own and holds no second copy of anything: every number it returns was produced by the
loop, the gate, or the log, so a reader can always check the UI against the committed
artifact. If the UI could invent a number, the submission's central claim would be
unverifiable by construction.

| Route | What it does |
|---|---|
| `GET /health` | Keep-warm ping. Touches nothing, so pinging it can neither fail nor perturb a session. |
| `GET /api/status` | Phase, provenance, stats, breaker, honest execution + generator capability. |
| `GET /api/leaderboard` | Promoted factors, or an `empty_reason` explaining rather than showing "no data". |
| `GET /api/log` | Paginated decision log. `limit` 1–500, refused with a 400 rather than coerced. |
| `GET /api/log/verify` | Re-verifies the whole hash chain and reports what it found (10 s cache). |
| `GET /api/stream` | SSE. 15 s heartbeat, 50-client cap, detaches on abort. |
| `POST /api/start\|stop\|reset` | Control. `reset` requires `requested_by` — a circuit-breaker reset must be attributable to a person. |

`GET /api/log/verify` is the endpoint that makes the submission's claim **checkable rather
than merely asserted**. It returns `ok`, `entries_checked`, `head_hash`, `failures[]`, the
log path, and the exact command to reproduce the result from a checkout. A verification you
have to take on faith is not a verification. Two states are deliberately kept distinct:
`ok: true` with `entries_checked: 0` means the log exists and is empty — vacuously true, not
evidence of integrity — and a log that cannot be read at all reports
`unavailable_reason` rather than `ok: false`, because "nothing to check" and "checked and
found broken" are different statements.

Two bugs in this layer were found by testing it rather than by reading it:

- **A temporal dead zone in my own SSE hub.** `detach` closed over `heartbeat` and
  `unsubscribe` declared *after* it, but `send` runs during the subscribe replay — so a
  client that disconnected during replay hit `ReferenceError: Cannot access 'heartbeat'
  before initialization`. Fixed by hoisting the declarations; the regression test was
  confirmed to fail without the fix.
- **An unguarded write to a dead socket.** `res.write('retry: 3000')` threw out of the route
  when the socket had already closed. Now caught, detached, and ended — returning `false`
  there would have meant "at capacity", which is a different and untrue statement.

### Verification achieved without a local `npm install`

Node 24's strip-only type stripping makes most of this testable on the 8GB machine, since a
`.ts` file with type-only imports erases to runnable JavaScript. All three harnesses are
disposable and gitignored.

| Harness | Checks | What it proves |
|---|---|---|
| `_dbgfrozen.mjs` | 28/28 | Frozen numbers reproduce live **and** the frozen store is what answered — `signalSources` reports `frozen`, not a silent live fallback |
| `_dbgsse.mjs` | 27/27 | Hub lifecycle, capacity, abort, heartbeat — including a negative control proving the TDZ test has teeth |
| `_dbgapi.mjs` | 41/41 | The real `src/index.ts` booted over real HTTP: validation, CORS allowlist, redaction, capacity, verify endpoint |

(3) in the frozen harness is not redundant with (2): a silent live fallback returns the same
data and therefore the *same numbers*, so a numbers-only check passes on a completely broken
frozen path. That is exactly how finding 20 stayed hidden.

### Dependency and module-resolution bugs fixed before CI

Found by reading, not by a compiler — no compiler has run yet:

- `@types/express@^5.0.0` against `express@^4.21.2`. A version mismatch that fails typecheck.
- `moduleResolution: "Bundler"` in `tsconfig.json`. Wrong for code executed directly by
  `node dist/index.js` — `Bundler` describes code a bundler processes. All relative imports
  use `.js`, there are no JSON imports, so `NodeNext`/`NodeNext` is correct.
- An `init-session` npm script pointing at a `src/scripts/initSession.ts` that does not exist.
- `new URL(\`file://${process.argv[1]}\`)` for the "am I the entry module?" check — wrong on
  Windows, where `argv[1]` is `C:\...`. Now `pathToFileURL()`.

---

## What GitHub Actions actually found (2026-09-12)

The repo was initialised, committed (134 files, 23,433 insertions) and pushed. Then CI ran
for the first time in the project's life, and every claim in the table above was finally
tested by a compiler. Three runs, and the pattern is worth recording: **each run revealed
only the layer above the one that failed.**

### Run 1 — the first typecheck ever: 3 real bugs

All three were genuine, none were false positives, and all three were in code that runtime
probes had already declared working. Type-checking found what running the code could not:

- `session/loop.ts:978` — `partitions_sha256: partitions`, the whole `LoadedConfig` wrapper
  instead of its `.sha256`. The endpoint served an object where the contract promises a
  hash. Every runtime probe stayed green because the field *existed*; only the type said it
  was the wrong *kind*. The frontend's provenance panel — the one panel whose entire job is
  to let a reader trace a number to its source — would have rendered `[object Object]`.
- `data/fundingHistory.ts:95` — `Property 'data' does not exist on type 'never'`. Caused by
  `body = (await res.json()) as typeof body` where `body` had been narrowed to `null` by an
  earlier assignment; `as typeof body` resolves to the *narrowed* type, not the declared one.
  Fixed with a named `FundingPage` interface.
- `web/app/page.tsx:231` — `HypothesisShape | null | undefined` passed where
  `HypothesisShape | null` was declared. The panel's contract is explicit and `?? null`
  keeps it honest instead of widening the prop to accept a case it does not reason about.

Also fixed here: `apps/agent/.env.example` documented `CORS_ORIGIN` while the server reads
`WEB_ORIGIN`, which would have left the deployed Vercel frontend CORS-blocked; three env vars
were documented but read by nothing and three were read but undocumented.

### Run 2 — typecheck green, 8 test failures

`Test Files 6 failed | 7 passed (13)`. Each was triaged as product-bug or test-bug before
anything was edited. **Two were product bugs** — the more interesting half:

- **The suite's test seam could not express "no store".** `manifestCache = null` was
  indistinguishable from "nothing read yet", so `__setFrozenManifestForTest(null)` fell
  straight through to the committed `data/frozen/manifest.json` and answered four tests that
  meant to simulate an *empty* store with the *real* one. The failure direction is what makes
  this worth naming: the store looked **present** immediately after a test removed it. A test
  double that silently substitutes the real thing is worse than no double, because it converts
  "I forgot to set this up" into "this passed".
- **A NaN t-statistic scored as maximally significant.** `!Number.isFinite` is false for NaN
  and ±Infinity alike, so both fell through to p = 0 — and p = 0 clears every
  Benjamini-Hochberg threshold. `tStatFromR` caps |r| at a finite 1e6 so it never returns an
  infinite t, but it *does* return NaN for a degenerate input such as a zero-variance series.
  A statistic that was never computed must not be the easiest kind to promote. NaN now takes
  the same "no evidence" value as `df <= 0`.

Four more were genuinely wrong assertions, and two of those had been **passing for the wrong
reason**:

- `candleFetch` asserted `[]` for a warm-up read that the frozen store was answering from
  disk with 300 rows — the stub was never consulted, so the test would have kept passing even
  if the gate had stopped admitting the read entirely.
- `freezeWindow` asserted candles have the longer lead-in. Funding's is 8h (one settlement
  interval) against candles' 5h (240 + 60 min), so the test was simply backwards.
- `frozenStore`'s "complete store" fixture supplied candle legs only, while `frozenCoverage`
  enumerates candles *and* funding — so `complete` was correctly false.
- `fundingHistory` had **13** callbacks that awaited without being `async`. Node reports only
  the first error, so CI showed one and a careful read of the file found two; the file held
  thirteen. Fixing only what the error named would have left it unparseable and CI red again.

That last one is the lesson of the whole run: **read the failure to the end of its class, not
to the end of its message.** The same habit caught the loop.ts bug — a probe that checked the
key *existed* rather than that the value was the right *kind*.

### Verification without a local `npm install`

Type-stripping probes were used to verify the fixes, and their teeth were proven in both
directions rather than assumed:

- The seam probe asserts the disk manifest genuinely answers when *unpinned* — so the
  pinned-null checks cannot pass for the wrong reason. With the new guard removed, it fails
  exactly the three assertions CI reported, on the committed entry and hash.
- The gate probe reproduces the 300 frozen rows that masked the `candleFetch` test and
  confirms the network is consulted only for the unfrozen symbol.

110 runtime checks green (`_dbgfrozen`, `_dbgsse` 27, `_dbgapi` 42, `_dbgseam` 21,
`_dbggate` 9, `_dbgcover` 11), plus a parse check over every test file.

### Run 3 — green, and the project builds for the first time

All four jobs pass on both Node 20 and Node 24: **13 test files, 406 tests, 0 failures**;
the frozen-dataset integrity job re-hashes every committed file against the manifest; the
decision-log job reports that no log is committed yet and passes.

The step that had never once completed is `Build`, and it is worth naming what it did, because
`npm run build --if-present` at the root is a no-op unless the root script fans out — it does
(`npm run build --workspaces --if-present`), so both workspaces really built. The agent
type-checked to `dist/`, and **Next.js compiled the frontend for the first time**: an
optimized production build, 6 static pages, 4 routes.

```
Route (app)                    Size     First Load JS
┌ ○ /                          9.18 kB  104 kB
├ ○ /_not-found                873 B    88.2 kB
├ ○ /leaderboard               3.56 kB  98.7 kB
└ ○ /log                       3.12 kB  98.2 kB
```

No build-time environment variable was required, so the frontend is independently
deployable; it needs only the backend's URL at runtime.

**This is the gate for Vercel, and it is now passed.** What remains is deployment, not
verification: Render (backend + keep-warm ping) first, then Vercel with the API base set.

---

## The deployment, verified (2026-09-12)

### Render

`render.yaml` was created at the repo root and committed as `ee418a7`, so the build and start
commands live in version control rather than in a web form where they can be neither reviewed
nor reproduced. Three settings in it are load-bearing and each would fail *quietly* if wrong:

1. **`startCommand` is `cd apps/agent && node dist/index.js`.** Not cosmetic. `loop.ts`
   resolves its decision log as the *relative* path `logs/decisions.jsonl`, so the process's
   working directory decides which file a session appends to. Launching from the repo root
   would write to `<repo>/logs/decisions.jsonl` while `GET /api/log/verify` advertises
   `npm run verify-log --workspace apps/agent`, which verifies
   `apps/agent/logs/decisions.jsonl`. The server and its own advertised reproduction command
   would then be reading two different files — and the one panel whose whole job is letting a
   reader check the record would be pointing somewhere else.
2. **`--include=dev` on the install.** `tsc` is a devDependency; if Render sets
   `NODE_ENV=production` the install would skip it and the build would fail on a missing
   compiler.
3. **`NODE_VERSION` pinned to 24**, because CI actually tests Node 24. Unset would mean
   deploying an interpreter nothing has ever run the suite on.

Deliberately **not** set: `ADMIN_TOKEN` (it gates `/api/start|stop|reset` behind an
`x-admin-token` header the frontend never sends — setting it would break the Pause/Resume
buttons in the UI), and `GROQ_API_KEY` (blank is a supported configuration; the loop falls
back to the deterministic enumerator by design).

### What was actually checked, from outside

The service was probed over its public URL rather than trusted because a dashboard read
"Deployed". Every route answered, with real values:

| Check | Observed |
|---|---|
| `GET /health` | `{"ok":true,"phase":"idle","uptime_s":568}` |
| `GET /api/status` | `dataset_frozen: true`, `frozen_files: 33`, `dataset_sha256` matching the committed manifest; `partitions_sha256` a **string**, confirming the Run-1 type fix reached production |
| `GET /api/leaderboard` | empty, with `empty_reason`: "No hypotheses have been attempted yet. Nothing has been tested, so nothing has been promoted or rejected — this is an empty session, not a null result." |
| `GET /api/log` | `{"entries":[],"total":0,"next_cursor":null}` |
| `GET /api/log/verify` | `ok:false` + `unavailable_reason: "no decision log at logs/decisions.jsonl yet"` — **correct, not broken**: no session has run, so there is nothing to check. This is the "nothing to check" state that the endpoint exists to keep distinct from "checked and found broken", reporting correctly in production. |
| `GET /api/stream` | `200`, `Content-Type: text/event-stream`, `retry: 3000` delivered through Cloudflare with `no-transform` — SSE survives the CDN |
| CORS from a foreign origin | **No `Access-Control-Allow-Origin` header** — correctly refused, because `WEB_ORIGIN` is still blank |

That last row is both correct and the reason for next action 12: the deployed frontend cannot
talk to this backend until `WEB_ORIGIN` names it.

### Findings from the deploy

| # | Finding | Severity |
|---|---|---|
| 25 | **There is no lockfile anywhere in the repo** — not at the root, not per workspace. Every `npm install` (CI, Render, and the coming Vercel build) resolves fresh version ranges from `package.json` alone. For a project whose entire claim is that a reader can reproduce its numbers from a checkout, `npm install` producing a different dependency tree on a different day is a reproducibility hole in the *build*, distinct from the reproducibility of the *data* (which is frozen and hashed). Not urgent — nothing is broken and the deploy succeeded — but it should be closed before submission, and it cannot be closed locally without an `npm install`. | **Reproducibility** |
| 26 | **The frontend has no way to start the loop.** The loop boots at `phase: 'idle'`, and the UI renders Pause/Resume only for `'running'` or `'paused'`. So a judge opening the deployed dashboard sees a permanently idle agent with no control to change that. `POST /api/start` works and is unauthenticated, but nothing in the UI calls it. Either a Start control is added for the `idle` phase, or the demo script starts the loop via the API before showing the dashboard. | **Demo blocker** |
| 27 | **Execution is refused at CHECK 1 on the deployed instance.** `/api/status` reports `BITGET_PAPER_TRADING is not "true"` and `ENABLE_EXECUTION is not "true"`, with no Bitget credentials present, so every order is validated and then refused. This is the *honest* configuration and is reported rather than hidden, but it means the deployed demo currently exercises the Execution Guard's refusal path only. Whether to enable paper trading (needs free Bitget demo credentials, no card) is a demo decision, not a correctness one. | **Demo scope** |

---

## Environment

- Windows 11, 8GB RAM, node v24.14.0, npm 11.9.0, git 2.53.0, Python 3.14.3
- `gh` v2.100.0 at `C:\Users\USER\AppData\Local\gh-install\bin\gh.exe` (not on PATH), authed as `Temmygabriel`
- **Local `.git` now exists.** The repo was initialised and pushed to
  `Temmygabriel/FACTOR_PROVER` on 2026-09-12. The earlier caveat in this file — that nothing
  had ever been committed and *no line had ever been type-checked by a compiler* — is now
  closed: CI type-checks, tests and builds on both Node 20 and Node 24 on every push to
  `main`. Nothing in this project should be described as verified on the strength of runtime
  probes alone again now that a compiler is available for free.

---

## UI redesign brief (2026-09-12)

`factor_prover_ui_redesign_brief.md`, 8 changes, all implemented except Change 8.

| # | Change | State |
|---|---|---|
| 1 | Orientation strip | **Done** — `components/OrientationStrip.tsx`. **Moved 2026-09-15**: it was rendered *below* the nav and on `/` only; `factor_prover_ui_fix_exact.md` puts it *above* the nav on **every** route, and it now is. The CTA came out with the move — it pointed at `#empty-bench` / `#live-hypothesis`, which exist only on the loop view, so on the other two routes it was a link to nowhere |
| 2 | Plain-English hypothesis sentence | **Done** — `hypothesisQuestion` + `barItMustClear` in `lib/copy.ts` |
| 3 | Plain-English kill line + expander | **Done** — `killSentences` / `killReasonTechnical` / `TechnicalDisclosure` |
| 4 | Leaderboard ratio + bar | **Done** — `BenchRatio` in `app/leaderboard/page.tsx` |
| 5 | Empty state with Start button | **Done** — `components/EmptyBench.tsx` |
| 6 | Nav score counter | **Done** — `NavBar` |
| 7 | Log chain banner, verify on mount | **Done** — `app/log/page.tsx` |
| 8 | Factor detail frame | **Skipped** — targets `app/factors/[id]/page.tsx`, which does not exist |

**Seven places the brief and the real codebase disagree.** Each was resolved in
favour of the code, and each is recorded in the file it touches:

1. **"Bitget API connected" pre-flight row** — no endpoint reports it. A tick
   beside a check nothing computed is the one thing this product cannot print, so
   the row was dropped and the hypothesis-generator row (which is real) replaced
   it. `EmptyBench.tsx`.
2. **`SIGNAL_LABELS` maps `btc_funding_rate` to "funding rate spike"** — a spike
   is a *change*, and `gt 0.00005` is a *level*: the funding rate being positive
   and above a floor at the moment of measurement. Calling it a spike would put a
   claim in the question the backtest never made. `pct_change_gt` gets the change
   wording and the spike belongs to it. `lib/copy.ts`.
3. **"tested" in the brief's counters** — `hypotheses_attempted` is incremented
   *before* the schema wall (`session/loop.ts:368` vs `:396`), so it includes
   proposals the wall stopped before any backtest. A proposal that was never
   backtested was not tested. The UI says "attempted", matching the field.
4. **`postStart` does not exist** — `lib/api.ts` has `postResume` (→ `/api/start`)
   and `postPause` (→ `/api/stop`). Used as they are.
5. **Equal weight means the expander is on PROMOTED too** — the brief asks for
   "What does this mean?" on the KILL stamp. Gating it on the verdict would hand
   one outcome a depth the other does not have.
6. **"All of them died at the Benjamini-Hochberg correction"** (spec §9, not the
   brief) is **false**. A 361-entry run on the deployed instance recorded
   ic_below_floor 112, t_stat_below_floor 100, duplicate_family 99,
   insufficient_obs 48, **p_value_exceeds_bh_threshold 11**, baseline_not_beaten
   2. Eleven of 361 died at BH. The copy now names BH as one of five bars rather
   than as the cause of every kill. `lib/copy.ts`.
7. **"At 43 hypotheses tested, the bar has tightened"** — the number the brief
   shows is the *session's* rank-1 bar, but a decided row has its own bar
   (`(rank/m)·fdr`) and the stamp directly above prints it. Quoting the rank-1 bar
   in the card would put two different thresholds under one label on one screen,
   so the card quotes the row's own bar when one exists and says which it is.

**A probe, not a vibe.** `probe.mjs` (scratch, gitignored) asserts the exact
sentences with the exact numbers: **52 assertions, 0 failures**. It was proved to
have teeth twice — forcing the card to quote the rank-1 bar failed exactly the 2
assertions that claim otherwise, and deleting the placeholder-metrics guard failed
exactly the 2 that claim that. The unit trap (0.00005 is 0.005%, not 0.00005%) has
its own 4 assertions, because a wrong unit renders as plausible prose.

---

## Next actions

1. ~~Finish the frozen dataset prefetch~~ — **done**, 33 files verified.
2. ~~Wire `dataset_sha256` into `AppendContext`~~ — **done** via `buildAppendContext()`.
3. ~~Build the LLM provider layer~~ — **done** (Groq → Gemini → deterministic enumerator).
4. ~~Session loop, event bus, family registry, paper ledger, log→row conversion~~ — **done**.
5. ~~Frontend files~~ — **written**; correctness pass completed, 9 bugs fixed.
6. ~~Execution Guard (`src/execution/guard.ts`) and circuit breaker~~ — **done**.
7. ~~SSE stream (`src/stream/sse.ts`) and Express server (`src/index.ts`)~~ — **done**, 41/41.
8. ~~Vitest suites and `.github/workflows/ci.yml`~~ — **written**; 13 files, ~357 `it()` sites.
9. ~~`git init` + first commit + push~~ — **done** 2026-09-12. Repo live, CI running.
10. ~~Get the vitest suite green~~ — **done** 2026-09-12. 406 tests in 13 files, both Node
    versions. Read the *whole* failure class, not just the line the error names — one of the
    eight was really thirteen.
11. ~~Deploy the backend to Render~~ — **done 2026-09-12**, first try, from the committed
    `render.yaml`. `https://factor-prover-agent.onrender.com`, live and independently
    verified on every route. Note the *keep-warm ping is not yet set up*, so the free instance
    sleeps after ~15 min idle and the first request after that pays a 30–60s cold start.
    **Correction to what this action previously claimed:** the frozen dataset is committed,
    but the decision log is **not** — `apps/agent/logs/` is empty. A fresh clone has all the
    data the protocol needs and no recorded session, which is action 17.
12. ~~Deploy the frontend to Vercel~~ — **done**. Live at `https://factorprover.vercel.app`,
    Hobby tier, root directory `apps/web`, with
    `NEXT_PUBLIC_API_BASE_URL=https://factor-prover-agent.onrender.com` set at project creation
    as required — it is a `NEXT_PUBLIC_` variable, so it is inlined at build time.
13. ~~Set `WEB_ORIGIN` on Render to the Vercel URL~~ — **done**, and committed as a literal in
    `render.yaml` so the allowlist is reviewable config rather than a dashboard value. Verified
    from outside: a request bearing `Origin: https://factorprover.vercel.app` is answered with a
    matching `Access-Control-Allow-Origin`, where a foreign origin still gets none.
14. Get the Groq key into the Render environment variables; add `GEMINI_API_KEY` when
    convenient. Both are free and need no card. Until then `/api/status` reports
    `deterministic_fallback: true` and the generator chain names each tier as `(no key)` —
    honest, and reported rather than hidden, but it means the deployed demo shows the last-resort
    enumerator rather than the LLM path the product is about.
15. Add a lockfile (finding 25). It cannot be generated locally without an `npm install`, so
    the honest route is a small CI job or workflow-dispatch step that runs `npm install`,
    commits the resulting `package-lock.json`, and switches CI and Render to `npm ci`.
16. Decide the `idle`-phase control (finding 26) and whether to enable paper trading (finding
    27). Both are demo-scope decisions, not correctness ones. Note the redesign's Change 5 added
    a Start button to the empty state, so check whether that already answers finding 26 before
    adding anything.
17. ~~**Replace the README's and the demo script's numbers with the real run's output.**~~
    **DONE 2026-09-14.** The log half was done 2026-09-13 (`6022039`). The copy half is now
    done too: `README.md` (which **did not exist** — see finding 36) and `docs/DEMO_SCRIPT.md`
    are both written from the committed log's actual numbers. Spec §16's impossible example is
    gone from every submission-facing document. `factor_prover_build_spec.md` itself is left
    untouched as the historical input of record; `docs/DEMO_SCRIPT.md` supersedes its §16 and
    says so.
18. **Type-check the redesign in CI.** `lib/copy.ts` is covered by a local probe, but Node
    cannot parse `.tsx` (`ERR_UNKNOWN_FILE_EXTENSION`), so the 4 components the redesign
    touched have never been compiled. The push is the check. See finding 28.
19. **`total_hypotheses_attempted_this_session` overstates the family (finding 33).** The field
    counts log entries, not hypotheses, so it is wrong by the number of re-entries — one, in the
    committed log. A proper fix separates the two quantities: an explicit dense `entry_index`
    for the verifier's positional witness (check 6), and the true attempt count in the field
    that names it, taken from the family registry that BH already uses. That touches the hashed
    payload, `verify.ts`, the API contract and the log screen, and needs the log regenerated —
    which is cheap, because the run is reproducible. Worth weighing against the remaining
    deadline: the gate's arithmetic is unaffected, so this is a reporting defect, not a
    statistical one.
20. Keep the local `_dbg*.mjs` / `_e2e.mjs` / `_scratch/` harnesses — they are gitignored, so
    they cannot reach the repo, and they are the **only** way to re-verify the agent locally
    (no `npm install` is permitted). The requirement is "untracked", not "deleted": confirm
    with `git check-ignore`, and never `git add -f` them. Only `_regen-scratch.sh` is
    un-ignored, and it is referenced by the `.gitignore` comment as the way to regenerate
    `_scratch`. `_dbgseam.mjs`, `_dbggate.mjs` and `_dbgcover.mjs` added 2026-09-12 and
    confirmed ignored.
21. `Killed (N)` in the frontend header counts *hypotheses* while the table lists *log rows*,
    so `{killRows.length} of {killCount} shown` can read "51 of 50". Cosmetic, but it is a
    number that does not mean what it says on the page that exists to be honest about numbers —
    and with the committed log it is no longer hypothetical: 201 rows against 200 hypotheses is
    exactly this mismatch, caused by the same demotion that produced finding 33.
22. ~~Two comments that had become lies~~ — **done 2026-09-13**, see finding 34.
23. ~~Stop the deployed site contradicting itself~~ — **done 2026-09-14**, see finding 35. The
    copy is scoped to the session everywhere it was unscoped, `EmptyBench` is told the committed
    total, and the two `??` fallbacks that a booted process's zero was suppressing are now `||`.
    Remaining and deliberately NOT done: the header still names the live session's id while the
    rows beneath come from the committed run, so two sessions are on screen at once and only one
    is named. Fixing that properly means the row projection carries `session_id` — a wire-contract
    change, not a copy change — and it is worth doing only if the log screen needs to distinguish
    runs anyway.

---

## Findings from the redesign pass (2026-09-12)

28. **The free tier has no persistent disk, and it has already eaten a session.**
    `/api/status` now reports `phase: idle`, `hypotheses_attempted: 0` — the 361-entry run
    that produced finding 6's distribution is gone, and so is its `decisions.jsonl`. This is
    not a bug in the agent; it is Render's free tier, which sleeps an idle service and resets
    the container filesystem on wake. Two consequences, one of which is a submission risk:
    - `/api/log/verify` correctly answers `unavailable_reason: "no decision log at
      logs/decisions.jsonl yet"` rather than claiming an intact chain over nothing. The log
      screen's banner handles exactly this state, which is why Change 7 turned out to matter
      more than it looked.
    - **A judge who opens the URL after any idle period sees an empty product**, however good
      the UI is. The structural fix is action 17: commit a real run's `decisions.jsonl`, so
      the record survives the container. Until then the empty state is doing the work of
      explaining a product that has no results on screen.
29. **`ADMIN_TOKEN` must stay unset on Render.** With it set, `POST /api/start|stop|reset`
    require an `x-admin-token` header and both the empty state's Start button and the
    header's Pause/Resume break. Verified: `POST /api/start` answers 200 unauthenticated.
30. **Three source comments in the frontend overstate what the code does** — `nullResultCopy`
    was one (fixed above), and two more were reported earlier and are still open: the
    `spotReturnSeries` doc comment claiming it "returns NaN" when the body `continue`s, and
    `guard.ts` CHECK 5's `detail` string. Comments that become lies after one edit are the
    cheapest kind of dishonesty to fix and the easiest to leave. **Both are now fixed — see
    finding 34.**

---

## Findings from the demo run (2026-09-13)

31. **The workflow that produces the submission artifact was pinned to a Node that cannot run
    it, and a false comment said otherwise.**
    `demo-run.yml` pinned Node 20 and then ran
    `node --experimental-strip-types apps/agent/scripts/rebuild-manifest.ts --check`. Node 20
    has no such flag, so the job died at its first real step — `node: bad option:
    --experimental-strip-types`, exit code 9 — and the session never started. Not a failed
    run: no run at all, so `apps/agent/logs/` stayed empty and the one artifact the submission
    is judged on did not exist.
    The pin was not arbitrary. It carried a comment justifying it: "20 … is the version the
    Render service runs, so this session is produced by the same runtime that produces the live
    one." **That was false.** `render.yaml` pins `NODE_VERSION` to `24`. And `ci.yml`'s
    frozen-dataset job had been pinning 24 for this exact command all along, with a comment
    saying the flag is why. So the workflow whose output becomes the record disagreed with both
    the deploy config and the CI job that verifies the same script.
    Fixed by pinning 24, which fixes the crash *and* makes the comment's original intent true —
    the live service runs 24, so the session is now genuinely produced by the same runtime.
    Verified before pushing on the same major: the command that exited 9 on the runner exits 0
    locally on v24.14.0 and re-verifies the frozen dataset on the way past (33 entries, the
    committed combined hash, every file intact). First green run: 200 hypotheses, 201 entries,
    chain PASS.

32. **Git does not run CI on the commit that produces the log.**
    The demo run commits with the run's own `GITHUB_TOKEN`, and GitHub suppresses workflow runs
    for pushes made with that token to prevent recursion. So `6022039` — the commit carrying
    `decisions.jsonl` — has **no CI run at all**; `gh run list --commit 6022039` returns
    nothing, and the author is `github-actions[bot]`.
    The consequence is narrow but worth naming, because it is exactly backwards: the commit
    that adds the artifact is the one commit CI cannot see. The `decision-log` job — written to
    re-verify the chain on every push, and which until now had always reported "no log
    committed yet" — therefore still has not verified a committed chain automatically. It runs
    only on a human's push.
    The bytes are not unverified: the workflow's own verify step ran `verify.ts` against the
    file it had just written, and the commit step refuses to commit without a `[run] PASS`
    line. But "CI re-verifies the committed log on every push" is not true of the commit that
    created it. Any future regeneration via this workflow has the same hole.

33. **`total_hypotheses_attempted_this_session` counts log ENTRIES, not hypotheses attempted.**
    It is stamped `this.count + 1`, where `count` advances once per appended entry. That is
    indistinguishable from a hypothesis count while one entry means one hypothesis, and it
    stopped being so with the first demotion — which this run produced.
    The committed log holds **201 entries for 200 distinct hypotheses**: H-0006 is promoted at
    m=6 and re-adjudicated to KILL at m=8. The last entry therefore records
    `total_hypotheses_attempted_this_session: 201`, while 200 hypotheses were tested. The
    verifier makes the entry-count reading binding — check 6 fails unless the field equals the
    entry's own 1-based position in the file — so the field *cannot* hold the true count while
    any re-entry exists. A `CIRCUIT_BREAK` entry does the same thing for the same reason; the
    writer's own comment notes that it "still advances by one" and reads that as a feature of
    the dense-counter check, without noticing the field's name.
    **The statistics are unaffected, and that is the point of separating them.** BH's `m` comes
    from `family.size`, not from this field: the last entry's `bh_adjusted_threshold` of 0.011
    is `(22/200) · 0.1`, i.e. m=200, the true attempt count. So the gate is honest and the
    overstatement is confined to a reported field — on the log screen whose entire argument is
    that the bar tightens as more hypotheses are tested. It overstates that family by the
    number of re-entries.

34. **Two comments that had become lies, fixed — and a third was hiding in a test.**
    Both were reported (finding 30) and left; both are cheap and both are now closed.
    - `spotReturnSeries` documented "Returns NaN where the lookback would cross a hole in the
      series". The body `continue`s; no NaN is ever produced. `SignalPoint.value` is a
      `number`, so a NaN *was* representable — the comment described a shape the function never
      produced. The real behaviour is the more dangerous of the two: a NaN is visible to every
      caller, whereas a dropped point is indistinguishable from one that was never on the
      grid, so the array is simply shorter and `n_obs` lower with nothing to say why. That is
      the same silent-difference class as finding 20, in the same function family.
    - `guard.ts` CHECK 5 pushed a record reading "the two-phase confirm is SKIPPED and the
      order is sent in a single confirmed call" whenever policy set `require_confirm: false`.
      Nothing skipped it. `require_confirm` was read in exactly one place and changed no
      control flow; with a hub present the guard still issued the unconfirmed call first and
      still re-issued. The one sentence describing the check that stands between a validated
      order and a sent one said the opposite of what happened.
    - **The test already knew.** `executionGuard.test.ts` asserted
      `hub.calls.map(c => c.confirm) === [false, true]` — proving the flow was *not* skipped —
      while a comment above it explained that the detail "overstates the effect", and the
      assertion pinned only the half of the string that was true
      (`/require_confirm is false in policy/`). A comment that describes a false string
      instead of removing it is the same defect one level up. Both halves are pinned now,
      including a negative assertion on the exact false sentence
      (`not.toMatch(/sent in a single confirmed call/)`), so the fix has teeth.
    Neither change alters behaviour, which is why neither was urgent — and why neither would
    ever have been caught by a test that only checks what the code does.

35. **The deployed site contradicts itself, on two screens a judge will click between — and it
    does so right now.** Committing the log (finding 28's structural fix) removed the empty
    product and replaced it with a self-contradiction.
    The two numbers come from two different places and neither endpoint is wrong:

    - `/api/status` reports `stats.hypotheses_attempted` from `this.attemptsMade`
      (`session/loop.ts:176`), a counter of hypotheses attempted **by this process**. It starts
      at 0 on every boot, and the server boots to `idle` and does not auto-start the loop
      (`src/index.ts:383–391`). On a free tier that sleeps when idle, "0 attempts" is the normal
      state of a live deployment *however much work it has ever done*.
    - `/api/log` reports `this.log.entryCount`, read out of the committed `decisions.jsonl` at
      boot.

    So the two disagree by construction after any sleep/wake, and the frontend keys three
    separate things on the status counter alone:

    - `app/page.tsx:103` — `isEmpty`, which renders `EmptyBench` and suppresses the loop controls.
    - `app/page.tsx:206` — the header line, `0 attempted · 0 promoted · 0 killed · 0 retired`.
    - `components/NavBar.tsx:143` — the orientation strip's link target, which sends the reader
      to `#empty-bench` instead of to the live hypothesis.
    - plus `/api/leaderboard`'s `empty_reason` (`session/loop.ts:992`): *"No hypotheses have been
      attempted yet. Nothing has been tested, so nothing has been promoted or rejected — this is
      an empty session, not a null result."*

    **Verified live on 2026-09-13**, against `https://factor-prover-agent.onrender.com`:
    `/api/status` returns `"phase":"idle"`, `"hypotheses_attempted":0`, session `S-f545ca29`;
    `/api/log` returns `total: 201`. The home page therefore renders a heading — "No hypothesis
    has been tested yet." — with the compact decision table on the *same screen* showing twelve
    real rows and "201 total", and the log screen showing "201 entries · chain intact".

    The server's distinction is the correct one and worth keeping: `attemptsMade` genuinely is
    this process's count and `entryCount` genuinely is the file's. What is false is the **copy**,
    which does not say which of the two it means. "No hypothesis has been tested yet" reads as a
    claim about the project; it is only true of the live session, and the screen that prints it
    has a committed record of 201 tests sitting underneath it. `EmptyBench` already receives the
    whole `StatusResponse`; the log reading is the thing it does not receive.

    A second instance of the same defect is in the header: it prints `Session S-f545ca29` — the
    live session — directly above rows produced by the committed run. Two sessions are on screen
    at once and nothing names which is which.

    Same family as 33 and 34: **the words assert more than the data supports.** 33 is a field
    whose name overstates its value, 34 is comments that had become lies, 35 is interface copy
    that reads as a claim about the project when it is a claim about one process.

    **Fixed the same day.** The server's distinction was kept — both endpoints were right — and
    the copy was scoped to the session: the empty bench's heading now reads "No hypothesis has
    been tested in this session yet" and the panel is handed the committed total so it can state
    it rather than report an absence; the session header reads "N attempted in this session"; the
    leaderboard names which count its numbers are counting; and `empty_reason` and the null-result
    copy are scoped the same way. Two `??` fallbacks became `||`, because zero is precisely the
    value those fallbacks exist for and `??` therefore never fired. The "Show all" control on the
    kill table was gated on `killCount > killPageSize`, which a zero suppressed — so the two
    hundred committed kills behind the first page were unreachable; it is now gated on the log's
    own cursor. Verified on the redeployed services: `/api/leaderboard` returns the scoped
    sentence, and the deployed frontend bundle contains "attempted in this session" and no longer
    contains any of the three unscoped strings.

36. **The README did not exist, and the demo script described three events that never happened.**
    Action 17 had been written as "replace the README's and the demo script's numbers", which
    presumed both documents existed. Neither did:

    - **There is no README in the repository.** Not a stale one, not a thin one — `git ls-files`
      lists no README at any path. A judge arriving at the repository lands on a directory
      listing. Action 17's instruction to *replace* its numbers could never have been carried
      out, and the task had been carried for three days as though it were a find-and-replace.

    - **The "demo script" is spec §16**, inside `factor_prover_build_spec.md`. Replacing its
      numbers is not sufficient, because three of its twelve steps describe events the committed
      session does not contain. Step 7 shows a PROMOTED hypothesis ("43 hypotheses attempted, 1
      promoted"); the run promoted zero. Step 8 shows an out-of-sample LOCKED_TEST number on that
      promoted factor; LOCKED_TEST was never read, because nothing earned the read. Step 10 shows
      a paper order executing through Agent Hub; no order was ever issued, because the guard
      never had a promotion to act on.

    **The fabricated numbers were the smaller half of the problem.** Finding 7 established that
    §16's example — "IC 0.071, t 2.41, obs 187" — is arithmetically impossible, and the fix that
    suggested itself was to swap in real figures. Doing only that would have left a demo script
    that is numerically true and still describes a session that cannot occur: a script whose
    middle act is a promotion, filmed against a run that promoted nothing. A presenter following
    it would have had to invent a result on camera, which is precisely the failure the project
    exists to argue against.

    **Written instead:** `README.md` (new) and `docs/DEMO_SCRIPT.md` (new, and it declares itself
    the supersession of §16). The demo's step 7 is rebuilt around the H-0006 arc — the one
    hypothesis that was promoted and then demoted two entries later, with its own IC, t-stat and
    p-value unchanged and only the BH threshold moving beneath it. Step 8 replaces the
    out-of-sample reveal with the honest and stronger beat: LOCKED_TEST is still sealed, and
    reading it now on H-0006 would be selecting the hypothesis *because* it looked best, which is
    the exact effect the partition exists to prevent. Step 10 states plainly that no order exists
    and why that is the safety property working.

    `factor_prover_build_spec.md` is left untouched as the historical input of record. The spec
    records what was planned; the new documents record what happened, and the difference between
    them is the submission.

    Same family as 33, 34 and 35, one level further out: not a wrong number in a document, but
    documents that asserted the existence of a result before one existed.

    **Also corrected here:** the demo-run paragraph above said H-0006 was re-adjudicated at
    "m=8". It was m=7 — the eighth *entry*, seventh *testable* hypothesis. Caught while mining
    the log for real numbers to write into the README, which is the argument for writing
    documents from the data rather than from a summary of the data.

---

## The Agent Hub integration, verified (2026-09-17)

**`apps/agent/src/execution/agentHub.ts` had never been run. It was wrong in four ways.**
It says so in its own old header — `STATUS: UNVERIFIED` — and the deployed banner told a
reader the command vector was "documented but UNVERIFIED against a live Agent Hub". That was
honest, and then it was checked, and the honest answer turned out to be worse than the
disclaimer: the vector did not work. Not "might not" — the CLI rejects it before reading a
single argument.

**Why it had never been run, and why that was reasonable until it wasn't.** This machine has
8GB of RAM and no toolchain by design; `bgc` is an npm package, not a prebuilt binary (the
Agent Hub GitHub repo publishes no releases), so running it meant installing Node packages on
the one machine the project kept clean. `docs/DATA_FINDINGS.md` had recorded the flags from
documentation, and nothing in the repo could contradict a documented flag.

**How it was verified.** `.github/workflows/verify-agent-hub.yml`, dispatched to a Linux
runner. It installs `@bitget-ai/bitget-agent-cli` 3.0.0 into a scratch directory outside the
repo (the root is an npm workspace, so a root install relinks both workspaces), asserts no
Bitget credential exists in the environment or on disk **before** running anything, then
interrogates the CLI with `--help`, `discover`, and dry-run invocations. Runs:
[35263451872](https://github.com/Temmygabriel/FACTOR_PROVER/actions/runs/35263451872) and
[35264648127](https://github.com/Temmygabriel/FACTOR_PROVER/actions/runs/35264648127).

**Finding 37 — the grammar changed and we did not.** v3 replaced `bgc <module> <tool>` with
`bgc <tool> --action <name>`. The builder emitted `order place`, which produces:

```
Error: unexpected extra arguments [place]. The v3 grammar is
`bgc <tool> --action <name> --<param> <value>` (it replaced `bgc <module> <tool>`).
```

This is worse than a wrong flag, because a wrong flag is caught by the parser one argument
later and the error names the flag. A wrong *shape* fails before parsing, and the builder had
no branch in which it could ever have been told.

**Finding 38 — one of the flags never existed, and two required ones were missing.**
`--notional-usdt` is not a flag. The size parameter is `--qty`, and `bgc discover --tool order
--action place` names five required params for `place`: `category`, `symbol`, `qty`, `side`,
`orderType`. The builder sent two of them. `category` was absent because nothing had ever told
it a category was needed. `--json` was also appended to every order; JSON is the CLI's default
output and `--pretty` is the modifier, so that flag did not exist either.

**Finding 39 — `qty` is not one unit, and the difference is the order size.** From the CLI's
own `qty` description: quote coin for a market **buy**, base coin for a market **sell**. So
the USDT notional passes through unchanged in one direction and must be divided by the price
in the other. Had this been fixed by simply renaming `--notional-usdt` to `--qty` — the
obvious repair — every **sell** would have been sized at `notional × price`. For RCOINUSDT at
~172 USDT, a 100 USDT order becomes a ~17,200 USDT one, and `max_order_usdt: 100` never fires,
because the guard approves the notional it is shown and the multiplication happens afterwards
inside the CLI. `qtyFor` now divides for sells and refuses outright when the price it needs is
not usable.

**Finding 40 — the capability banner named credentials the CLI does not read.** The deployed
banner said *"Bitget credentials incomplete (BITGET_API_KEY, BITGET_API_SECRET,
BITGET_API_PASSPHRASE missing)"*. `bgc --help` lists `BITGET_API_KEY`, `BITGET_SECRET_KEY`,
`BITGET_PASSPHRASE`. Two of the three names were wrong, so a reader who followed the banner
would set variables nothing reads and the banner would go on saying they were missing. The
same banner is where a reader decides whether the product works.

**Finding 41 — a dry run would have read as a placed order.** `parseResult` looked for a flat
`success`/`accepted`/`status`/`orderId` and treated `parsed['data']` as an order id — in the
real body `data` is an object, so that branch could never fire. More importantly, a dry run
returns a success-shaped body, exit 0, no error, for an order that was never sent. Reading
that as accepted would have made `BGC_DRY_RUN` — a setting whose entire purpose is to not
place orders — look like working execution in every log and on every screen. Both observed
envelopes are now handled explicitly and a dry run is reported as a preview.

**Finding 42 — `cliPresent` was a constant.** It asked `existsSync("bgc")`, which is false for
every bare name, so the capability report said the CLI was absent no matter what was
installed, and the one branch that would have looked it up on PATH was unreachable. A
capability probe whose answer cannot vary is worse than no probe, because it looks like a
measurement. `resolveOnPath` now walks PATH the way a shell does.

**What is verified now, and what is still not.** The **request** is verified: every flag the
module passes was accepted in the run, and the dry-run probes answered with a full `wouldSend`
preview while `get_auth_status` reported `authorized: false` and no credentials existed
anywhere in the job. The **placement** is not, and `unverified` stays `true` for that reason
alone — stated narrowly rather than as a blanket disclaimer over the parts that were checked.

One consequence worth recording because it is easy to get backwards: `--confirm` is **not**
the CLI's two-phase contract. Discovery reports `requiresConfirm: false` for `place`, and the
dry-run probes returned no `confirmationRequired`. The CLI places on the first call. The
two-phase confirm this project relies on is Execution Guard CHECK 5, which is ours. `--confirm`
is kept because it is tolerated and keeps the command line self-describing, but no safety
property depends on it.

**Also measured, not assumed:** the traded targets are SPOT instruments. `RTOKEN_SYMBOLS` are
Bitget's tokenised-equity rTokens, and `market --action tickers --category SPOT --symbol
RCOINUSDT` returned `lastPrice 172.31` while the same call against `USDT-FUTURES` returned
`Trading pair RCOINUSDT does not exist`. `market` is a public endpoint, so that answer cost
nothing and needed no credential.

**Pinned by 30 tests** (`apps/agent/test/agentHub.test.ts`) whose fixtures are stdout copied
verbatim from the run — including two error messages that exist precisely because something
was wrong. The tests reach the private builders through a subclass, so nothing in the suite
can spawn a process. The one that matters most asserts that a dry run is **not** an accepted
order.

**The pattern in findings 33–36 and 37–42 is the same one, one level deeper.** Those were
documents asserting results that did not exist. This is code asserting an interface that was
never contacted. Both are what happens when a plausible description goes untested long enough
to be repeated — and in both cases the thing that found it was running it, not reading it.

---

## Change log

- **2026-09-11** — Spec study complete. Live API recon done; 6 findings recorded, 2 spec-breaking.
  Memory files + this progress file created. Repo confirmed public and empty. Awaiting decisions on loop host and Family 2.
- **2026-09-11** — Architecture locked (Render + Vercel, Family 2 dropped, non-overlapping
  sampling, three-tier LLM). Scaffold built. Statistical core verified 12/12.
- **2026-09-11** — Tester verified end-to-end against live Bitget data. Found and fixed a
  silent pagination bug that had been reducing every backtest to 1.3% of its data (finding 12);
  found the second candle endpoint that makes Families 2 and 3 viable (findings 13–14).
  Gate and hash-chain verifier built and tested. Frozen dataset layer added (finding 16).
  Node type-stripping used for all local verification — still no local `npm install`.
- **2026-09-11** — Frozen dataset complete and verified: 27 files, 9 symbols × 3 partitions,
  843,047 rows. Found and fixed the missing ETH reference asset (17), the manifest-overwrite
  bug that had already corrupted the live manifest (18), and the fallback enumerator's
  near-duplicate ordering (19). Confirmed frozen reproduces live measurements exactly (20).
- **2026-09-11** — Funding leg frozen (33 files, 844,839 candle + 522 funding rows, new dataset
  hash `b0fd26a3…`), so no verdict rests on a live endpoint. Session loop, event bus, family
  registry and paper ledger built. Frozen verification now **28/28**, asserting provenance and
  not merely matching numbers. That verification caught two real bugs: `FUNDING_LEAD_IN_MS`
  used but never imported (21 — would have crashed on the first funding hypothesis), and a
  combined hypothesis silently degrading to one leg when the spot leg was empty (20 — a
  plausible-looking null result that would have been published). Both fixed; the second is
  now a permanent regression check. Frontend written (33 files); correctness pass re-running
  after a network interruption killed the first attempt.
  `dataset_sha256` wired into every log entry. LLM provider layer built. Added
  `scripts/rebuild-manifest.ts` as a permanent integrity check.
- **2026-09-11** — Execution Guard, circuit breaker, SSE hub, Express server and the whole
  wire contract built. `GET /api/log/verify` added — the endpoint that makes the hash-chain
  claim reproducible from a checkout rather than asserted. Secret redaction placed at the
  wire boundary. Frontend correctness pass completed (9 bugs fixed). 13 vitest files and a
  3-job CI workflow written. Three harnesses pass without a local `npm install`: frozen
  28/28, SSE 27/27, routes 41/41. Fixed in this pass: a TDZ crash in my own SSE hub (proved
  by re-introducing the bug), an unguarded write to a dead socket, a response that leaked
  the deployment's absolute path from a public endpoint, `cors({origin: true})` replaced
  with an explicit allowlist, `moduleResolution: "Bundler"` → `NodeNext`, an
  `@types/express` v5/v4 mismatch, and finding 22 — `rebuild-manifest.ts --check` exited 0
  on a tampered manifest, now caught in four distinct tamper modes.
  **Discovered this pass: the project has no local `.git`.** Nothing has ever been committed
  or pushed, so CI has never run and no code has ever been type-checked. That is now action 9.


- **2026-09-12** — **Repository live and CI running for the first time in the project's life.**
  `git init`, first commit (134 files, 23,433 insertions), pushed to `Temmygabriel/FACTOR_PROVER`.
  Three CI runs, each revealing only the layer above the one that broke:

  - *Run 1 — first typecheck ever, 3 real bugs.* `loop.ts` assigned the whole `LoadedConfig`
    wrapper to `partitions_sha256` where a hash string belongs (the provenance panel would
    have rendered `[object Object]` while every runtime probe stayed green, because the key
    existed and only its *kind* was wrong); `as typeof body` in `fundingHistory.ts` resolving
    to the narrowed `null`; `?? null` needed in `page.tsx`. Also fixed: `.env.example`
    documented `CORS_ORIGIN` while the server reads `WEB_ORIGIN`, which would have left the
    deployed Vercel frontend CORS-blocked. Added `if: ${{ !cancelled() }}` to the test-typecheck
    and build steps, so one red layer no longer hides the two below it.
  - *Run 2 — typecheck green, 8 test failures.* Triaged individually before any edit.
    **Two product bugs:** the frozen-store test seam could not express "no store"
    (`manifestCache = null` was indistinguishable from "nothing read yet", so four tests meant
    to simulate an empty store were answered by the committed manifest — and the store looked
    *present* right after a test removed it); and `studentTTwoTailedP` scored a NaN statistic
    as maximally significant, since `!Number.isFinite` is false for NaN and ±Infinity alike and
    both fell through to p = 0, which clears every BH threshold. NaN now takes the "no evidence"
    value. **Four wrong assertions**, two of which had been passing for the wrong reason: the
    `candleFetch` gate test asserted `[]` for a read the frozen store was answering with 300
    rows from disk, and `freezeWindow` asserted candles have the longer lead-in when funding's
    is 8h against candles' 5h. `fundingHistory` had **13** callbacks awaiting without `async` —
    Node names only the first, CI showed one, a careful read found two, and the file held
    thirteen. Fixing what the error named would have left it unparseable.
  - Verified without a local `npm install` by type-stripping the real sources: the seam probe
    asserts the disk manifest answers when *unpinned*, so its pinned-null checks cannot pass
    for the wrong reason, and with the fix's guard removed it fails exactly the three
    assertions CI reported. 110 runtime checks green (`_dbgseam` 21, `_dbggate` 9,
    `_dbgcover` 11, plus the existing 27/42/28).
  - Pushed as `d918ea3` (CI tooling) and `315723c` (the fixes); CI re-run in flight.
  - **Still unproven: the `Build` step has never completed.** No Vercel deploy until it does.

- **2026-09-12 (later)** — **CI green; the project builds for the first time in its life.**
  All four jobs pass on both Node 20 and Node 24: **13 test files, 406 tests, 0 failures**,
  frozen-dataset integrity re-hashed, decision-log job correctly reporting no log yet.

  The run that matters most is `Build`, which had never once completed. Worth recording what it
  actually proved, because `npm run build --if-present` at the root is a no-op unless the root
  script fans out to the workspaces — it does (`--workspaces --if-present`), so both really
  built: the agent type-checked to `dist/`, and **Next.js compiled the frontend for the first
  time** — an optimized production build, 6 static pages, 4 routes (`/` 9.18 kB, `/log` 3.12 kB,
  `/leaderboard` 3.56 kB, `/_not-found` 873 B). No build-time env var was needed, so the
  frontend is independently deployable and needs only the backend URL at runtime.

  **This passes the gate the user asked about: it is now Vercel-ready.** What remains is
  deployment, not verification — Render (backend + keep-warm ping on `/health`) first, then
  Vercel with the API base set, then `WEB_ORIGIN` back on Render pointed at the Vercel URL.
  Added as next actions 11–13, along with action 17: the submission still needs a real demo
  run, since spec §16's example numbers are mathematically impossible (finding 7).

- **2026-09-12 (later still)** — **The backend is deployed and verified from outside.**
  `render.yaml` committed as `ee418a7` beforehand, so the deploy was a read of versioned
  config rather than a form filled in by hand. Render built `factor-prover-agent` first try
  and it went live at `https://factor-prover-agent.onrender.com`.

  Verification was done by probing the public URL, not by trusting the dashboard word
  "Deployed": `/health` (`ok`, `phase: idle`, uptime counting), `/api/status` (33 frozen
  files, the committed `dataset_sha256`, and `partitions_sha256` as a **string** — confirming
  the Run-1 type fix reached production), `/api/leaderboard` (empty, with an `empty_reason`
  that explains rather than showing "no data"), `/api/log` (empty page), `/api/log/verify`
  (`ok:false` + `unavailable_reason` — the correct "nothing to check yet" state, reported
  correctly in production), and `/api/stream` (SSE headers and `retry: 3000` surviving
  Cloudflare with `no-transform`). A request from a foreign origin got **no**
  `Access-Control-Allow-Origin`, which is the allowlist doing its job and is why `WEB_ORIGIN`
  is now a required step rather than a nicety.

  Three findings, none of them correctness bugs and all of them things that would have been
  discovered late and painfully:

  - **No lockfile exists anywhere in the repo** (25). Every install — CI, Render, and the
    coming Vercel build — resolves fresh ranges from `package.json`. The *data* is frozen and
    hashed; the *build* is not pinned. That is a reproducibility hole in the half of the
    project that is supposed to be reproducible.
  - **The deployed frontend will have no way to start the loop** (26): the loop boots `idle`
    and the UI renders Pause/Resume only for `running`/`paused`.
  - **Execution is refused at CHECK 1** on the deployed instance (27), because
    `BITGET_PAPER_TRADING` and `ENABLE_EXECUTION` are unset and no Bitget credentials exist.
    Honest and reported, but it means the live demo currently exercises only the refusal path.

  Also corrected in this pass: next action 11 had claimed the decision log was committed. It
  is not — `apps/agent/logs/` is empty. The frozen dataset is committed and the recorded
  session is not, which is action 17.

- **2026-09-12 (redesign)** — **The UI redesign brief implemented: 7 of 8 changes; the 8th has
  no target route.** The brief's own goal was that a judge who has never heard of Factor Prover
  understands within 30 seconds what it is, what it is doing live, and why the KILL is the
  point. Every sentence the redesign adds is a template over fields the server actually sent —
  nothing is authored prose, and `lib/copy.ts` is the single home for all of it.

  The largest single piece of work was not layout, it was **units**. The log stores a condition
  as a bare number and the same number means different things per signal: a funding rate of
  `0.00005` is `0.005%`, while a spot return of `0.5` is already `0.5%`. Rendering one with the
  other's unit overstates it a hundredfold and the sentence still reads as perfectly plausible.
  So the unit is looked up per signal, an unknown signal gets **no** unit rather than a guessed
  one, and the trap has its own four assertions in the probe.

  Seven disagreements with the brief and with spec §9 were found and resolved in favour of the
  code; the table and the list are in "UI redesign brief" above. The one worth repeating here
  is that spec §9's null-result copy — "All of them died at the Benjamini-Hochberg correction"
  — is **false**, and the run that disproved it recorded 11 BH kills out of 361. A sentence on
  the leaderboard that the log beside it contradicts overstates the product's rigour in exactly
  the direction the whole submission is built to avoid, so the copy now names BH as one of five
  bars rather than as the cause of every kill.

  Also corrected: `fmtThreshold` printed four decimals below 0.01, at which precision the live
  session's bar (0.000277) and a raw p (0.000510) both rendered "0.0005" — producing kills that
  read "p 0.0005 did not survive the bar (0.0005)". It now prints six below 0.01.

  Verified by `probe.mjs`: **52 assertions, 0 failures**, and proved to have teeth by mutation
  twice. What is **not** verified locally is the four `.tsx` files — Node cannot parse JSX, so
  the components the redesign touched have never been compiled. The push is the check (finding
  28).

  **The risk this pass surfaced is bigger than the redesign.** `/api/status` answered `phase:
  idle`, `hypotheses_attempted: 0`: Render's free tier has no persistent disk, slept, and reset
  the container — taking the 361-entry session and its `decisions.jsonl` with it. A judge who
  opens the URL after any idle period now sees an empty product, however good the empty state
  is. The structural fix is action 17, and it has moved from housekeeping to the top of the
  list: **commit a real run's `decisions.jsonl`**.

- **2026-09-13** — **The demo run exists. The submission's missing artifact is committed.**

  `apps/agent/logs/decisions.jsonl`, 201 entries, committed as `6022039` by
  `.github/workflows/demo-run.yml`. Session `S-1a6c5d66`, 200 hypotheses attempted, **0
  promoted, 200 killed**, chain **PASS**. Every hypothesis died at a preregistered bar, and the
  distribution is recorded above.

  Getting there meant finding the reason it had never run. The workflow was pinned to Node 20
  and ran `node --experimental-strip-types`, a flag Node 20 does not have — so it died at its
  first real step with `node: bad option` and exit code 9, before the session began (finding
  31). The pin carried a comment justifying it as "the version the Render service runs"; it
  isn't, `render.yaml` pins 24, and `ci.yml` had been pinning 24 for that exact command all
  along. One line changed, and the comment's original intent became true rather than merely
  plausible.

  The run also produced the first demotion in the project's history — H-0006 promoted at m=6,
  re-adjudicated to KILL at m=8 as the BH threshold tightened — which is the gate behaving as
  designed and is now visible in a committed record. It is what made the log 201 entries long
  for 200 hypotheses, and that in turn exposed finding 33: the log's
  `total_hypotheses_attempted_this_session` counts entries rather than hypotheses, so it
  overstates the family by the number of re-entries. The BH correction is unaffected — its `m`
  comes from the family registry, and the last entry's 0.011 threshold is `(22/200)·0.1`, i.e.
  200 — so the gate is honest and the misstatement is confined to a reported field.

  Also fixed, both left open since 2026-09-12: the `spotReturnSeries` doc comment promising a
  NaN the body never produces, and `guard.ts` CHECK 5's detail claiming the two-phase confirm
  was skipped when nothing skipped it. The guard's test had been asserting the half of that
  string that was true while a comment above it described the half that wasn't (finding 34).

  And one thing found rather than fixed: GitHub does not run CI on a push made with the
  workflow's own `GITHUB_TOKEN`, so the commit that adds the log is the one commit CI never
  sees (finding 32). The workflow verifies the file itself before committing it, so the bytes
  are checked — but the `decision-log` CI job still has not verified a committed chain
  automatically.

- **2026-09-13** — Closed the loop on the demo run by checking what the **deployed site** actually
  serves, and found it arguing with itself (finding 35). `/api/status` reports
  `hypotheses_attempted: 0`, phase `idle`, session `S-f545ca29`; `/api/log` reports `total: 201`.
  Both are correct readings of different things — this process's attempts, and the committed
  file's entries — and the frontend prints them as though they were the same quantity. So the
  home page renders the heading "No hypothesis has been tested yet." with a twelve-row decision
  table and "201 total" on the same screen, while the log screen shows "201 entries · chain
  intact". Three frontend call sites key on the status counter alone (`page.tsx:103` for
  `isEmpty`, `page.tsx:206` for the header line, `NavBar.tsx:143` for the strip's link target)
  and `/api/leaderboard`'s `empty_reason` (`loop.ts:992`) states outright that nothing has ever
  been tested.

  Not a bug in either endpoint — the server's distinction between the live session and the
  committed record is exactly right, and a cold deployment really has attempted nothing. The
  false thing is the copy, which reads as a claim about the project. Recorded as action 23; it
  is the same defect family as 33 (a field whose name overstates its value) and 34 (comments
  that had become lies): words asserting more than the data supports, which is the defect this
  whole submission is built to hunt in other people's factors.

- **2026-09-14** — Closed finding 35 end to end, and closed a real gap in how the frontend is
  verified. The copy that contradicted the committed log is scoped to the session everywhere it
  was unscoped, two `??` fallbacks that a booted process's zero was silently suppressing are now
  `||`, and the leaderboard's "Show all" control — previously unreachable on a cold deployment,
  which is the only state the deployed service is ever in — is gated on the log's own cursor
  instead. Confirmed on the redeployed services rather than on the diff: `/api/leaderboard` now
  returns the scoped sentence, and the deployed Vercel bundle contains "attempted in this
  session" while containing none of the three unscoped strings it replaced.

  The larger item is `apps/web/scripts/check-tsx-structure.mjs`. There is no `npm install` here,
  so `.tsx` cannot be compiled and — unlike `.ts`, which Node's type stripping will run — cannot
  even be parsed: Node rejects the extension outright. Every frontend edit was therefore
  unverified until CI ran, which meant the person typing a dropped `</div>` found out from a
  build minutes later rather than from the machine in front of them. The new script checks
  bracket and JSX-tag nesting, which is the part of that gap a source-text check can close. It is
  explicitly not a type-check and says so in its own output; CI is still the gate for that.

  It took four iterations to become trustworthy, and the iterations are the interesting part.
  Written naively it reported **twelve of twenty-two files as broken**, all false. Each fix came
  from reading the reports instead of trusting them: generic type arguments (`Record<SessionPhase,
  string>`, `useState<VerifyState>(…)`) look exactly like JSX tags; closing tags needed exempting
  from that same rule, because `</h2>` follows JSX text ending in a full stop and every heading in
  the codebase desynchronised the stack; `<></>` was scanned past its own `>`; and a prose comment
  between two JSX props — `// the log's own cursor` — opened a phantom string at the apostrophe
  that ran to the next apostrophe in the file and swallowed the tag's terminator. It was then
  tested against three separately injected breakages (a dropped `</div>`, a dropped `}`, a stray
  `)`) and catches each with the right line. **Both halves were needed**: a checker that never
  fires proves nothing, and neither does one that fires on correct code. All 22 files now report
  balanced, and CI's typecheck and build run green on both Node 20 and 24.

- **2026-09-14** — **Wrote the two submission-facing documents that action 17 had been waiting
  on, and found that neither existed.** Action 17 was phrased as "replace the README's and the
  demo script's numbers", which presumed both documents were there to be corrected. `git ls-files`
  lists no README at any path — a judge arriving at the repository lands on a directory listing —
  and the "demo script" turned out to be spec §16, inside the build spec.

  Replacing §16's numbers would not have been enough, and this is the finding (36). Three of its
  twelve steps describe events the committed session does not contain: a PROMOTED hypothesis, an
  out-of-sample LOCKED_TEST number computed on that promoted factor, and a paper order executing
  through Agent Hub. The run promoted zero, never read LOCKED_TEST, and issued no order. Swapping
  in real figures would have produced a script that is numerically true and still unfilmable —
  whose middle act is a promotion that does not exist, in a project whose entire claim is that it
  does not invent results. The fabricated numbers were the smaller half of the problem.

  `README.md` and `docs/DEMO_SCRIPT.md` are written from the committed log rather than from a
  summary of it, which is how the m=8 error surfaced: the demo-run paragraph above said H-0006 was
  demoted at "m=8", but E-0008 is the eighth *log entry* and the seventh *testable* hypothesis —
  E-0005 was excluded for `insufficient_obs`. Both entries state the real family size themselves
  ("rank 1 of 6", "rank 1 of 7"), and 0.1/6 and 0.1/7 are exactly the logged thresholds. The
  README now carries the correct number, and the demo script's step 7 is built on the arc: the
  hypothesis that cleared every preregistered check at m=6 and was killed at m=7 with its IC,
  t-stat and p-value unchanged, only the bar moving beneath it.

  Step 8 was rewritten the other way round from the spec's intent, and is a better beat for it.
  LOCKED_TEST stays sealed: nothing was promoted, so nothing earned the read, and running it now
  on H-0006 would mean choosing the hypothesis *because* it looked best — the selection effect the
  partition exists to prevent. Step 10 says plainly that no order exists, and that this is the
  safety property working rather than a gap. `factor_prover_build_spec.md` is left untouched as
  the historical input; the new script declares itself its supersession.

  Two README claims were wrong on first draft and were corrected against the repository before
  committing: it said Node 24 alone, when CI tests 20 and 24, and it said the log verifier needed
  no dependencies beyond Node, when it runs through `tsx`. Both were the same failure mode as
  everything above — a sentence asserting more than the code supports — this time in a document
  written specifically to avoid it.
- **2026-09-14** — **The deployed site halted a live session and blamed the provider for the
  loop's own request rate (finding 37).** A live session on the real Groq key stopped after eight
  hypotheses with `reason: max_consecutive_llm_failures` and the detail *"the provider is down"*.
  The provider was fine: it was answering HTTP 429 with
  `x-ratelimit-reset-tokens: 46.755s` and `"Limit 8000, Used 6321, Requested 2077"` — the loop was
  asking roughly ten times faster than an 8,000-token-per-minute free tier allows. A 429 was
  classified `kind: 'transport'`, which both advanced the provider circuit and satisfied the
  session breaker's "was a provider called and did it fail" filter, so three throttled iterations
  in a row killed a healthy session. Fixed at the classification: a 429 is now `rate_limited`,
  carries the provider's own reset hint (parsed from Go-style durations, `retry-after` only as a
  fallback — it said 3s where the bucket needed 47), triggers a bounded deterministic backoff
  instead of instantly degrading to the enumerator, and counts as neither a provider failure nor
  a success. The rule that decides it is now `countsAsProviderFailure()` in `src/llm/provider.ts`
  rather than an inline `.some()` no test could reach, and `test/generatorChain.test.ts` covers it
  end to end through the real generator against a stubbed network — the chain had **no** test
  file before this.

  Proved to have teeth rather than asserted: the same harness run against the pre-fix tree fails
  exactly the checks that describe the bug — `circuitOpen=true` after six consecutive 429s and
  only **3 of 6** model calls, the other three having silently fallen through to the enumerator.
  On the fixed tree, 46/46. Three user-visible strings that had become false were corrected with
  it, including the circuit-breaker tooltip on the live site.

- **2026-09-15** — **`factor_prover_ui_fix_exact.md` reconciled against the code, not re-implemented.**
  The brief was already built on 2026-09-12 — Changes 2–7 exist and are wired
  (`hypothesisQuestion` / `barItMustClear` / `killSentences` / `killReasonTechnical` in
  `lib/copy.ts`, `BenchRatio` + `nullResultCopy` on the leaderboard, `ChainIntegrityBanner` on
  the log, the score line in the nav). Diffing the "exact" spec against the tree found **two**
  real deltas, both now closed:

  - **The strip's position and reach.** It was rendered after the nav and only on `/`. It is now
    above the nav on every route, which is what the spec asks for and also the better argument:
    a judge opening a shared link lands on the leaderboard or the log — a table of kills with no
    statement of how many hypotheses produced them. The CTA was dropped rather than made
    conditional, because its two anchors exist only on the loop view and the strip is now on all
    three.
  - **The stamp's 2° tilt.** This is the interesting one. The spec's `transform: rotate(-2deg)`
    cannot be applied as a class on the stamp element: `.stamp-in` runs with
    `animation-fill-mode: both`, so its final keyframe (`transform: scale(1)`) keeps applying
    after the 180ms and **outranks** a class `transform`. `-rotate-2` there would render as
    nothing on every animated verdict — a change that looks implemented, passes a structural
    check, and does nothing. The tilt is on a wrapper element instead, so the animation and the
    rotation never touch the same property.

  Two deviations from the spec were kept, both deliberate and both already argued in the files:
  the counter reads **"attempted"** rather than "tested" (the field increments *before* the
  schema wall, and the spec's own `schema_validation_failed` copy says those hypotheses were
  killed *before testing* — the two cannot both be true on one screen), and the strip uses the
  Tailwind palette tokens rather than the spec's inline hex, which are the same values, since the
  spec also says not to change the palette. `borderRadius: 0` needed no work: `tailwind.config.ts`
  replaces the radius scale with `none | full` only, so the stamp was already square.

  **Favicon added** (`app/icon.svg`, Next's file convention — no `layout.tsx` change). The brief
  says "put the logo as the favicon"; **there is no logo file in the repository** — the wordmark
  is the literal text "FACTOR PROVER" in the nav. The icon is therefore derived from it: the two
  letters a 16px tab can carry, drawn as rectangles rather than as SVG text, because a text
  element would depend on a font being present at raster time and would clip or render empty if
  it were not. Ink ground, amber letters, and the strip's amber rule along the base.

  and the homepage said so out loud.** `render.yaml` never declared `BITGET_PAPER_TRADING`, so the
  deployed Execution Guard refused at CHECK 1 and `src/execution/agentHub.ts` reported
  *"BITGET_PAPER_TRADING is not 'true'"* on the front page — while `docs/DEMO_SCRIPT.md` printed
  `✅` beside "`BITGET_PAPER_TRADING=true` in production". Two of the project's own artifacts
  disagreed in public about a submitted checklist item. Finding 27 had already recorded the
  unset flag as an open demo-scope decision; the contradiction is what forced it. The flag is now
  declared in `render.yaml` — non-secret, reviewable, and it authorises nothing on its own, since
  `ENABLE_EXECUTION` and the Bitget credentials remain absent and the guard's later checks still
  refuse. The demo script's row now says what is true rather than what was hoped for.

- **2026-09-17** — **The Agent Hub integration was verified against the real CLI, and it was
  broken.** A new cloud workflow installed `@bitget-ai/bitget-agent-cli` 3.0.0 on a Linux
  runner and ran the commands this repo had only ever written down. Four errors, none of which
  any artifact in the repo could have caught: v3 replaced `bgc <module> <tool>` with
  `bgc <tool> --action <name>`, so `order place` is rejected before parsing (37); `--notional-usdt`
  does not exist, `--category` and `--orderType` were missing, and `--json` was never a flag (38);
  `qty` is quote coin for a buy and base coin for a sell, so the obvious repair would have sized
  every sell at `notional × price` past a guard that had already approved it (39); the deployed
  banner named two credential variables the CLI does not read (40); a dry run would have parsed
  as a placed order, making `BGC_DRY_RUN` look like working execution (41); and `cliPresent`
  asked `existsSync("bgc")`, which is false for every bare name, so the capability report was a
  constant wearing the shape of a measurement (42). Fixed, with 30 tests whose fixtures are
  stdout copied verbatim from the run. `unverified` stays `true` for a narrower and now-stated
  reason: the request is verified, a live placement is not.

- **2026-09-19** — **The committed artifact was not the demo run. It had been overwritten twice
  by pacing calibration, and nothing in the repository noticed.**

  Found while auditing the docs before submission. Every document in this repository describes
  the 2026-09-13 session: 200 hypotheses, 201 entries, the H-0006 demotion. The file those
  documents describe, `apps/agent/logs/decisions.jsonl`, did not describe it. It held **60**
  entries and **zero** promotions.

  The history is unambiguous once the file is followed through git rather than read as it
  stands:

  | Commit | Date | Entries | Generator | Verdicts |
  |---|---|---|---|---|
  | `6022039` | 2026-09-13 | **201** | deterministic | 200 KILL, 1 PROMOTE |
  | `514cc38` | 2026-09-16 | 60 | 28 groq + 32 deterministic | 60 KILL |
  | `b198c0c` | 2026-09-17 | 60 | 60 groq | 60 KILL |

  Neither of the two later commits is a demo run. Both are the pacing calibration recorded in
  `demo-run.yml`'s own comments: the 16,000ms experiment that *"landed with twenty-eight model
  proposals and thirty-two enumerated ones"* is `514cc38` exactly, and `b198c0c` is the re-test
  after the delay was raised to 24,000ms, which is what proved the pacing fix worked — all 60
  hypotheses came back model-proposed. Both were committed by the workflow, because
  `iterations` is a workflow input and the session step writes to the log with `--replace`.

  **The failure is not that a calibration run happened. It is that the artifact could not tell
  one from the other.** Every one of the three commits carries the same subject
  (`demo run: session on the frozen dataset`) and writes the same path, so the repository's own
  record of what it shipped was replaced by an experiment in which the only difference is a
  number inside the file. The docs were right throughout; the bytes were wrong, and for three
  days the submission pointed a judge at a log that contradicted every claim made about it —
  in a project whose entire thesis is that it does not do that.

  Restored from `6022039`, after checking that restoring was actually valid rather than merely
  desirable. The 09-13 entries attest to three hashes, and all three still describe what is on
  disk today: `policy_sha256` and `partitions_sha256` recomputed from the working tree match
  byte for byte, and `dataset_sha256` was re-derived independently from the committed manifest —
  `sha256` over `symbol|partition|kind|sha256` in the manifest's own sort order — and matches
  `b0fd26a3…`. The project's own verifier then returns **PASS — 201 entries, chain intact and
  append-only**, head hash `sha256:956d09b1…`. Nothing the restored log vouches for has moved
  since it was written, so no verdict in it is stale. Re-running the workflow instead would not
  have recovered it: `SessionLoop` has changed since 09-13, so a fresh keyless run reproduces
  *a* session, not *this* one, and the H-0006 demotion is in this one.

  Finding 43: **the demo log has no protection against being overwritten, and no detector.**
  The workflow verifies the file it just wrote and commits it; nothing compares it against what
  is already committed, so a run with a smaller `iterations` silently shrinks the submission.
  The guard is one conditional in the commit step — refuse to commit a log shorter than the
  committed one unless that is asked for explicitly. Left unbuilt here deliberately: it edits
  the one workflow the submission depends on, three days before the deadline, and the restore
  is the fix. It is the first thing to do with the next free hour.
