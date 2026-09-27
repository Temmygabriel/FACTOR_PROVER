# Factor Prover

An autonomous factor-mining agent over Bitget cross-asset market data. It proposes
structured hypotheses about the relationship between crypto derivatives signals (BTC/ETH
funding rate, spot momentum) and tokenized-equity (rToken) forward returns, backtests each
one against a frozen historical partition, and adjudicates it with a deterministic gate
under a preregistered statistical protocol.

**It promoted nothing, and that is the result.**

---

## The headline: a real session, with the null result reported

Session `S-1a6c5d66`, run 2026-09-13 against the committed frozen dataset. The full record is
in [`apps/agent/logs/decisions.jsonl`](apps/agent/logs/decisions.jsonl).

| | |
|---|---|
| Hypotheses attempted | **200** |
| Promoted | **0** |
| Killed | **200** |
| Decision-log entries | **201** — 200 hypotheses, one of them decided twice |
| Hash chain | **PASS** — intact and append-only |
| Generator | `deterministic` — **no LLM provider key was configured; see the disclosure below** |

Every kill has a stated reason, and the reasons are the shape of the session:

| Count | Reason |
|---|---|
| 73 | `ic_below_floor` — the measured relationship is too weak to trade |
| 58 | `t_stat_below_floor` — indistinguishable from noise |
| 31 | `duplicate_family` — too close to a hypothesis already tested |
| 29 | `insufficient_obs` — fewer than 100 valid observations |
| 8 | `p_value_exceeds_bh_threshold` — did not survive multiple-testing correction |
| 1 | `baseline_not_beaten` — a naive baseline did as well |
| 1 | `PROMOTE` — and then that one was demoted |

### The most interesting thing in the log is two entries apart

Hypothesis `H-0006` (ETH spot momentum → RGOOGLUSDT, +30 min forward return) was **promoted**
at entry `E-0006`, then **killed** at entry `E-0008`. Its own measured numbers never changed:

```
IC 0.0939   t 2.447   n 675   baseline IC 0.0673   raw p 0.0147
```

What changed was the bar it faced:

| Entry | Family size | BH threshold | p-value | Verdict |
|---|---|---|---|---|
| `E-0006` | m = 6 | 0.016667 | 0.0147 | **PROMOTE** — p is below the bar |
| `E-0008` | m = 7 | 0.014286 | 0.0147 | **KILL** — p is above the bar |

The Benjamini-Hochberg threshold at rank 1 is `(1/m) × q`. As the family of tested
hypotheses grows, the bar rises, and a result that looked real at six attempts stops looking
real at seven. This is the exact failure mode the correction exists to catch, it happened on
its own, and the committed log is the proof.

**Which is why this project does not claim to have found profitable alpha.** The claim is
narrower and checkable: the protocol ran, the arithmetic is in the record, and it killed 200
of 200 ideas — including one it had briefly liked.

### What happened to that one afterwards

Two things, and both are results.

**It failed the reserved out-of-sample test.** `H-0006` was re-evaluated on `LOCKED_TEST`, a
partition the loop cannot reach, and was killed there too —
[`logs/locked-test.jsonl`](apps/agent/logs/locked-test.jsonl), one entry, reason
`ic_below_floor`. The partition was spent once and never reused. So the promotion did not
merely get demoted by arithmetic: it did not survive data it had never seen. That is the
test the whole split exists to make possible, and the project reports it against its own
best candidate.

**Then a second, larger phase was run — and it also found nothing.** v1.1 was a
preregistered sweep of **320 hypotheses** targeting `BTCUSDT`, the one instrument this
project has verified its execution path can actually place an order on. The policy was
written and hashed **before** any result was seen (`sha256:5efb3dbb…`), the earlier
partitions and the spent `LOCKED_TEST` were left untouched, and no threshold was loosened to
produce a promotion. Result: **320 tested, 0 survivors** —
[`logs/v1.1.jsonl`](apps/agent/logs/v1.1.jsonl), with the counts and hashes in
[`logs/v1.1.meta.json`](apps/agent/logs/v1.1.meta.json). `VALIDATION`, the only partition
never read by any recorded result, is still unspent.

The strongest raw candidate in that sweep (`H-V11-0262`) reached `p = 9.27e-3` against a
rank-1 Benjamini-Hochberg bar of `3.125e-4` — an order of magnitude short — and its own
naive baseline beat it anyway.

**Two sweeps, 520 hypotheses, zero survivors, no threshold moved.** A system that can only
ever report this is not obviously useful. A system that reports it *about itself*, with the
hashes and the spent holdout to prove the rules were fixed in advance, is the thing this
project is actually claiming.

---

## How it works

```
  hypothesis              backtest                gate                  guard
  ──────────              ────────                ────                  ─────
  LLM proposes a    →     evaluated on      →     deterministic   →     five checks,
  bounded, enum-          the DISCOVERY           rules + BH FDR        then a paper
  constrained JSON        partition only          step-up               order
```

1. **Propose.** The LLM emits a structured hypothesis — signal, condition, target,
   direction, forward window — against a closed enum. It cannot write free text, invent a
   signal, or set a threshold. Schema validation rejects anything off-spec before it is tested.
2. **Backtest.** Measured on the **DISCOVERY** partition only. The engine hard-rejects any
   query outside it.
3. **Adjudicate.** A deterministic gate applies the preregistered thresholds, with
   Benjamini-Hochberg step-up correction across the whole family. No LLM is involved in the
   verdict.
4. **Guard.** If — and only if — a hypothesis is promoted, five deterministic checks run in
   sequence before any order is issued. The first is `BITGET_PAPER_TRADING`, checked before
   anything touches the network.

### The partitions were frozen before anything was tested

`config/partitions.json`, split 60/20/20 by **real trading day count** — not calendar time,
because rTokens do not trade on weekends or US market holidays.

| Partition | Window | Trading days | Who may read it |
|---|---|---|---|
| `DISCOVERY` | 2026-06-15 → 2026-08-05 | 36 | The backtest engine, and only here |
| `VALIDATION` | 2026-08-06 → 2026-08-21 | 12 | The gate's final evaluation only |
| `LOCKED_TEST` | 2026-08-24 → 2026-09-10 | 13 | Inaccessible to the loop entirely |

33 frozen data files — 844,839 candle rows and 522 funding rows — carry a combined digest of
`sha256:b0fd26a32fa0314debb6d2784d09c01904d5e173a73b77809cd50558bdf2f02b`. CI re-derives it
on every push, so a silent change to the data fails the build rather than invalidating a
result quietly.

### The thresholds were preregistered

`config/gate_policy.json`, locked 2026-09-11 before any session ran:

| Threshold | Value |
|---|---|
| FDR level (`q`) | 0.10 |
| Minimum \|IC\| | 0.04 |
| Minimum \|t\| | 2.0 |
| Minimum observations | 100 |
| Must beat naive baseline | yes |
| Sampling | non-overlapping |

**Non-overlapping sampling is the load-bearing choice.** Testing every minute would produce
roughly 606 overlapping 4-hour-forward observations per weekday sharing 239/240 of their
data, inflating t-statistics by about √240 ≈ 15× and promoting noise. Sampling one
observation per window costs sample size and keeps every observation independent.

The forward-window cap of 120 minutes is likewise pre-registered from a measured power
analysis, not chosen for convenience: at 480 minutes only 70 valid observations exist in
DISCOVERY, below the 100-observation floor, so an 8-hour hypothesis would auto-kill on data
availability rather than on merit.

---

## The record cannot be edited quietly

Every decision appends one line to `decisions.jsonl`, carrying the hash of the line before
it. Change any entry and every hash after it stops verifying.

Verify it yourself. This needs `npm install` first — the verifier runs through `tsx`, so it is
not a zero-dependency script:

```bash
npm install          # from the repository root
cd apps/agent
npm run verify-log
```

Or against the deployed service:

```bash
curl https://factor-prover-agent.onrender.com/api/log/verify
```

Each entry also carries the policy hash, the partitions hash, and the dataset hash it was
decided under — so an entry can be tied to the exact rules and exact data that produced it.

---

## Live

| | |
|---|---|
| Frontend | https://factorprover.vercel.app |
| API | https://factor-prover-agent.onrender.com |

The API runs on Render's free tier and sleeps after ~15 minutes idle, so the first request
after a quiet period may take 30–60 seconds. That is the free tier, not a fault.

---

## The execution path is real, and it is bounded

The statistics are the point, but the pipeline does reach a venue. Every record is committed
at [`apps/agent/logs/paper-live.jsonl`](apps/agent/logs/paper-live.jsonl), captured live
rather than reconstructed — the Execution Guard and the order-intent builder are the
production modules, and `CHECK 5` invoked the real `bgc` binary, which signed the request.

| | |
|---|---|
| Accepted by Bitget demo | **2 orders**, `BTCUSDT` sell — ids `1485970832289546240`, `1485982824169586688` |
| Refused by the venue | **every `RGOOGLUSDT` attempt**, verbatim error below |
| Environment | `--paper-trading` on every call; no real money exists in this account |
| Cadence | Appended **daily** by `.github/workflows/live-execution.yml` — a trail, not a snapshot |

The counts are deliberately not hardcoded: the record grows on a schedule, so any fixed
number in this file would be wrong the moment it was written. Read the file for the current
state.

The daily cadence is itself part of the claim. The Agentic Trading track asks for a
paper-trading record **actually run during the competition period**; one run on one day is an
anecdote, a consecutive daily trail is a record. Each run places the order the committed
decision log implies — `H-0006`'s `RGOOGLUSDT` buy — through the production guard and the
real `bgc` binary, and appends whatever the venue says.

The rToken refusal is the venue's, not ours:

```
HTTP 400 from Bitget: papTradingService not support RWA order validation error
```

That is Bitget's paper-trading service declining tokenised equities as an instrument class.
It arrives before any sizing or balance logic runs, and it is why the accepted orders are
`BTCUSDT`: the project found the one instrument its execution path could actually reach and
then targeted its research there.

**What the accepted orders are not.** They are venue checks, not factor-generated trades. The
only factor that ever reached the Guard was `H-0006`, and it was refused — that refusal is
the first record in the file. So the honest summary of the execution leg is: the path works,
it has been proven to work on a real order id, and **no promoted factor has ever filled a
trade**, because no factor has survived to be traded.

---

## Disclosures

These are stated up front because a project whose entire claim is honesty about its own
results does not get to be quiet about its own limits.

- **The committed session was generated by the deterministic fallback, not by an LLM.** No
  provider key was configured when it ran, so the hypothesis generator was the rule-based
  enumerator in `src/llm/deterministic.ts`. The statistical pipeline, the gate, the log and
  the hash chain are the real ones and are unchanged by which generator proposed the
  hypotheses. The deployed service reports which generator is active in `/api/status`.
- **There are two committed records, and `generator` on every entry says which is which.**
  `decisions.jsonl` is the deterministic session — 201 entries, all `deterministic`. The
  **LLM-proposed** record is [`decisions-llm.jsonl`](apps/agent/logs/decisions-llm.jsonl):
  **60 entries, all `groq`**, produced with a real provider key. It contains **60 KILLs and
  0 PROMOTEs.** So the model's proposals were tested, were recorded, and were rejected on
  the same bar as everything else — which is the thesis working, not a gap in it. The
  deterministic fallback exists so the loop still runs with no key configured; it is not a
  substitute for the model, and the two are never mixed in one file.
- **No real money is involved and none can be.** The execution guard refuses every order
  unless `BITGET_PAPER_TRADING=true` exactly, and that check runs first.
- **An empty session is not an empty project.** `/api/status` reports what *this process* has
  attempted since it booted; `/api/log` reports what is committed to disk. Both are correct
  about different things, and the UI labels which is which.
- **A null result is a result.** Zero promotions is reported at the same visual weight as a
  promotion would be. The kills are on the leaderboard, not hidden below it.
- **Open interest is absent by necessity.** Bitget exposes only a current OI snapshot; every
  historical OI endpoint returns `40404 Request URL NOT FOUND`. The `oi_shock_to_rtoken`
  family was removed rather than approximated with data that does not exist. See
  [`docs/DATA_FINDINGS.md`](docs/DATA_FINDINGS.md).
- **Two defects were found by auditing this project's own output, and both are published.**
  A baseline-alignment bug in the backtest engine was discovered while checking a prediction
  that appeared to fail; it was measured across all 520 entries and **changed no verdict in
  either research phase**, and the published numbers were **not** quietly rewritten —
  [`logs/BASELINE_ALIGNMENT_ERRATA.md`](apps/agent/logs/BASELINE_ALIGNMENT_ERRATA.md). And
  the confirmation leg of the Execution Guard cannot fire against this venue, because the
  CLI's confirm gate covers destructive operations only and order placement is not one of
  them — [`docs/CHECK5_CONFIRMATION_FINDING.md`](docs/CHECK5_CONFIRMATION_FINDING.md), which
  also records a latent parser defect left unfixed on purpose. A project arguing that a
  system must not grade its own homework has to publish what it finds when it checks its
  own.

---

## Running it

Node 20 and 24 are both tested in CI, on every push. The session runner and the dataset
tooling use Node's TypeScript type stripping, which needs **24**; the library and its test
suite run on either.

```bash
npm install
npm run test        # all workspaces
npm run typecheck
```

Run a session against the frozen dataset — no API keys, no network, deterministic:

```bash
cd apps/agent
npm run run-session
```

Re-run the exact committed demo session and compare it against the committed log without
touching the tree:

> **Actions → Demo run → Run workflow**, with `commit: false`

It re-runs the session and **fails if the decisions differ** from the committed ones. The
reproducibility claim is therefore checked by CI rather than asserted in prose.

### Layout

```
apps/agent/          the loop: generation, backtest, gate, guard, log, REST + SSE API
apps/agent/config/   gate_policy.json and partitions.json — the preregistered protocol
apps/agent/logs/     the committed records: decisions.jsonl (deterministic), decisions-llm.jsonl
                     (LLM-proposed), v1.1.jsonl, locked-test.jsonl, paper-live.jsonl, errata
apps/web/            Next.js dashboard — leaderboard, decision log, live feed, provenance
docs/                DATA_FINDINGS.md, CHECK5_CONFIRMATION_FINDING.md, TRY_IT.md
PROGRESS.md          the build record, including every finding and correction
```

**New here?** [`docs/TRY_IT.md`](docs/TRY_IT.md) is a nine-step guide for checking the
project's central claim yourself, in about five minutes, without reading any of the above.

---

## What this is not

It is not a trading strategy, and it does not claim a profitable signal. It is a
falsification protocol with a user interface: a machine that generates ideas cheaply, tests
them against data it cannot change, and reports the ones that die — which, in the committed
session, was all of them.
