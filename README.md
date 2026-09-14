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

## Disclosures

These are stated up front because a project whose entire claim is honesty about its own
results does not get to be quiet about its own limits.

- **The committed session was generated by the deterministic fallback, not by an LLM.** No
  provider key was configured when it ran, so the hypothesis generator was the rule-based
  enumerator in `src/llm/deterministic.ts`. The statistical pipeline, the gate, the log and
  the hash chain are the real ones and are unchanged by which generator proposed the
  hypotheses. The deployed service reports which generator is active in `/api/status`.
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
apps/agent/     the loop: generation, backtest, gate, guard, log, REST + SSE API
apps/web/       Next.js dashboard — leaderboard, decision log, live feed, provenance
docs/           DATA_FINDINGS.md — measured Bitget API behaviour that reshaped the spec
config/         gate_policy.json and partitions.json — the preregistered protocol
logs/           decisions.jsonl — the hash-chained research record
PROGRESS.md     the build record, including every finding and correction
```

---

## What this is not

It is not a trading strategy, and it does not claim a profitable signal. It is a
falsification protocol with a user interface: a machine that generates ideas cheaply, tests
them against data it cannot change, and reports the ones that die — which, in the committed
session, was all of them.
