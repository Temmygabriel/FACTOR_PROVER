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
| Test suites + CI workflow | **Written — 13 vitest files, `.github/workflows/ci.yml`, never yet run** |
| Local git repository | **Does not exist — nothing has ever been committed or pushed** |
| Vercel deploy | Not started |

**Vercel-ready:** Not yet. The frontend exists but has never been type-checked or built
(no local `npm install` allowed on this machine), so it is unverified until GitHub Actions
compiles it. Do not attempt a Vercel deploy before a green CI build.

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

## Environment

- Windows 11, 8GB RAM, node v24.14.0, npm 11.9.0, git 2.53.0, Python 3.14.3
- `gh` v2.100.0 at `C:\Users\USER\AppData\Local\gh-install\bin\gh.exe` (not on PATH), authed as `Temmygabriel`
- **No local `.git`.** The project directory was never `git init`-ed: it has `.github/` and
  `.gitignore` but no repository. So nothing has ever been committed, pushed, or run by CI,
  and **no line of this project has ever been type-checked by a compiler** — every "Done" in
  the table above rests on runtime probes and reading, not on `tsc`. The GitHub repo
  `Temmygabriel/FACTOR_PROVER` exists and is empty. This is the single largest unverified
  surface in the project and the next action closes it.

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
9. **`git init` + first commit + push.** The repo has never existed locally. This is the only
   way to type-check — no local `npm install` is permitted on this machine. Nothing is
   verified until Actions is green.
10. Deploy backend to Render (with keep-warm ping on `/health`), frontend to Vercel — **only
    after a green CI build**. Set `WEB_ORIGIN` to the Vercel URL and set `ADMIN_TOKEN`.
11. Get the Groq key into the Render environment variables; add `GEMINI_API_KEY` when convenient.
12. Keep the local `_dbg*.mjs` / `_e2e.mjs` / `_scratch/` harnesses — they are gitignored, so
    they cannot reach the repo, and they are the **only** way to re-verify the agent locally
    after a CI run (no `npm install` is permitted). The requirement is "untracked", not
    "deleted": confirm with `git check-ignore` after `git init`, and never `git add -f` them.
    Only `_regen-scratch.sh` is un-ignored, and it is referenced by the `.gitignore` comment
    as the way to regenerate `_scratch`.
13. Two findings from the frontend correctness pass that were reported but **not yet acted on**:
    - `spotReturnSeries` in `signals.ts` has a doc comment claiming it "returns NaN" for a
      missing point, but the body `continue`s, so the point is simply absent.
    - `guard.ts` CHECK 5's `detail` string overstates its effect.
    Neither changes behaviour; both are the kind of comment that becomes a lie after one edit.
14. `Killed (N)` in the frontend header counts *hypotheses* while the table lists *log rows*,
    so `{killRows.length} of {killCount} shown` can read "51 of 50". Cosmetic, but it is a
    number that does not mean what it says on the page that exists to be honest about numbers.

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

