# Demo Script — 12 steps, 5–6 minutes

**This supersedes spec §16.** The spec's demo flow was written before the project had ever
produced a session, and it describes three things that cannot happen in the committed run.
The numbers below are not illustrative — every one of them is read from a committed decision
log and can be checked by anyone with the repository.

## The argument underneath the twelve steps

The twelve steps are the recipe. The **seven beats** below are the argument, and they are what
is being scored. If a step has to be cut on the day, cut one that carries no beat.

| # | The beat | Carried by |
|---|---|---|
| 1 | Bitget's own market data, hashed and frozen | Step 1 |
| 2 | **A model proposes a trading hypothesis** | Steps 2–3 |
| 3 | The deterministic backtest | Step 4 |
| 4 | The preregistered statistical gate decides | Steps 5–9 |
| 5 | The execution and risk guard | Step 9 |
| 6 | Bitget paper execution | Step 10 |
| 7 | The tamper-evident record | Steps 11–12 |

## Two records, and the one sentence that keeps them straight

The repository holds **two** decision logs, and they are different documents:

| File | Entries | `generator` | Session | What it evidences |
|---|---|---|---|---|
| [`decisions-llm.jsonl`](../apps/agent/logs/decisions-llm.jsonl) | 60 | `groq` | `S-6fae9ffa`, 2026-09-17 | Beat 2 — **every hypothesis proposed by a model** |
| [`decisions.jsonl`](../apps/agent/logs/decisions.jsonl) | 201 | `deterministic` | `S-1a6c5d66`, 2026-09-13 | Beats 3–6 — where the promotion, the demotion and the executed order are |

Both verify with the project's own verifier, and CI re-verifies both on every push.

**Steps 4–12 below read `decisions.jsonl`,** because that is where the promotion, the demotion
and the executed order live. The model's session produced **60 kills and zero promotions**, so
it has nothing for the execution leg to act on — say that on camera rather than let a viewer
assume the model's session placed the order.

**The one sentence that must never be said:** do not call the deterministic session a
language-model session, and never let a caption imply a model produced the H-0006 promotion or
its demotion. The honest sentence is that **both sessions happened** — one protocol, run once
with a model proposing and once with the model replaced by a pure function, which is what makes
the protocol checkable rather than merely described.

---

## Why §16 could not be recorded as written

Spec §16's example numbers — "IC 0.071, t 2.41, obs 187" — are **mathematically impossible**:
an IC of 0.071 at n = 187 yields t ≈ 0.968, not 2.41. Clearing t = 2.41 at that sample size
needs an IC near 0.175. That was finding 7.

Fixing the numbers alone is not enough, because three of the twelve steps describe events the
real session never contained:

| §16 step | As written | What actually happened |
|---|---|---|
| Step 7 | "Show a PROMOTED hypothesis. 43 attempted, 1 promoted." | 200 attempted, **0 promoted** |
| Step 8 | "Show the LOCKED_TEST evaluation. Out-of-sample IC 0.038, down from 0.071." | **LOCKED_TEST was never read** — nothing earned it |
| Step 10 | "Show a paper order executing through Agent Hub." | **No order was ever issued** — the guard never had a promotion to act on |

The rewrite below keeps the twelve-step shape and the timing, and replaces those three beats
with the true events — which are better material. The promoted-then-demoted hypothesis in
step 7 is a stronger demonstration of the protocol than an invented winner would have been.

---

## Before recording

- `npm install` at the repository root — the log verifier in step 11 runs through `tsx`, so
  it will not work on a clean checkout without this.
- Node 24 on the recording machine (step 11 and the session runner need it).
- Service warm: `curl https://factor-prover-agent.onrender.com/api/status` (Render's free
  tier sleeps; a cold start takes 30–60s and you do not want that on camera).
- Two browser tabs: the dashboard at https://factorprover.vercel.app, and the repository.
- Say the word **"killed"** the same way you say **"promoted"**. Tone is the argument.

---

## The 12 steps

```
Step 1  (0:00–0:20)  Bitget-native data sources
```
Screen: the frozen dataset directory, `apps/agent/data/frozen/`.

> "All the data is Bitget's, pulled from their API. It was downloaded once, hashed, and
> frozen on the 11th of September. 33 files, 844,839 candles. If anyone changes a single
> candle, the hash changes and CI fails the build."

Show the combined digest: `sha256:b0fd26a32fa03…`

```
Step 2  (0:20–0:40)  The preregistered gate policy
```
Screen: `apps/agent/config/gate_policy.json`.

> "These are the thresholds — written once, on the 11th of September, before the loop ran a
> single test. FDR level 0.1. Minimum IC 0.04. Minimum t-stat 2.0. Minimum 100 observations.
> The agent is shown these so it knows what bar it is proposing against. It cannot change any
> of them."

Point at `locked_at` and at `max_forward_window_minutes: 120`.

> "The 2-hour window cap isn't a preference. It's measured — at 8 hours only 70 observations
> exist, below our own 100 floor, so the hypothesis would die on data availability rather than
> on merit. We capped it and wrote down why."

```
Step 3  (0:40–1:15)  The hypothesis a model proposes
```
Screen A: the dashboard. The structured hypothesis JSON — signal, condition, target,
direction, forward window.

> "The agent proposes a structured hypothesis. It cannot write free text. It cannot invent a
> signal — that's a closed list. It cannot set a threshold that isn't in the schema. If it
> goes off-spec, schema validation rejects it before anything is tested."

Screen B: [`apps/agent/logs/decisions-llm.jsonl`](../apps/agent/logs/decisions-llm.jsonl),
first line, scrolled slowly along until `"generator":"groq"`. **This is beat 2, and it is the
shot the track is scored on — do not cut it.** Optionally `Ctrl+F` for `"generator":"groq"` and
let the editor show it matching all 60 lines.

> "This is the record of a session where a model proposed every hypothesis — 60 entries, and
> every one carries `generator: groq`. Groq wrote the question."

Then the split, stated once and plainly:

> "The model picks the question. It has no vote on the verdict. That's the whole design: a
> model that could mark its own work would just tell us its ideas were good."

**And the model's own record contains the proof.** Two of the sixty hypotheses it proposed were
killed *by the multiple-testing correction* — the gate overruling the model on exactly the
judgement a model cannot make about itself. The better of the two is `E-0046`: a BTC
spot-return hypothesis into `RAMZNUSDT` with a raw p-value of **0.0095**, which looks like a
finding to anyone reading it alone. The preregistered bar at rank 2 of 46 was **0.0043**, so it
died. On screen: search `decisions-llm.jsonl` for `E-0046` and hover its `gate_detail`.

> "0.0095 looks like a discovery. It isn't — test 46 ideas and a p-value that size is expected
> by chance. The model proposed it, the model can't be trusted to judge it, and the gate
> killed it. That's the layer doing its job on the model's own output."

```
Step 4  (1:15–1:45)  The backtest on DISCOVERY
```
**This step changes records, and the change is spoken aloud.** Steps 4–12 read
`decisions.jsonl`, the 13 September session, because that is where the promotion, the demotion
and the executed order are.

Screen: an entry from the deterministic decision log.

> "From here the walkthrough follows the other record — 201 entries, the same protocol, with
> the model replaced by a pure function. That one is reproducible: run it again and you get the
> same 201 lines. The model's session isn't, and that's the honest price of using a model."

> "It's tested on DISCOVERY only — 15 June to 5 August, 36 trading days. The engine
> hard-rejects any query outside that window. This is the only partition the agent can see."

```
Step 5  (1:45–2:05)  KILL #1 — the signal is too weak
```
Screen: entry `E-0001`, `H-0001`. On screen, verbatim:

> `|IC| = 0.0088 is below the preregistered floor of 0.04. Any relationship present is too
> weak to be worth trading.`

> "IC is 0.0088. Our floor is 0.04. Killed — and the reason is written into the log, not into
> a slide. Killed is a result. This one is 73 of the 200."

```
Step 6  (2:05–2:25)  KILL #2 — a different reason, and a more honest one
```
Screen: entry `E-0005`, `H-0005`.

> `Only 75 valid non-overlapping observations; the preregistered floor is 100. Nothing is
> concluded about the idea — the data cannot test it.`

> "This one is worse than a failure — it's a hypothesis we simply can't test. 75 observations,
> we need 100. And notice the wording: *nothing is concluded about the idea.* We don't get to
> call it wrong. We only get to say we couldn't check. 29 hypotheses died this way."

```
Step 7  (2:25–3:05)  The centrepiece — promoted, then demoted
```
**This replaces §16's "show a PROMOTED hypothesis".** Screen: entries `E-0006` and `E-0008`,
side by side.

> "Here's the most interesting thing in the whole record. Hypothesis H-0006 — ETH spot
> momentum into Alphabet, 30-minute forward return — **passed**. IC 0.0939, t 2.447, 675
> observations, and it beat the baseline. Every preregistered check cleared. That's `E-0006`:
> PROMOTE."

Read the entry's own words:

> "Cleared every preregistered check: n = 675 (floor 100), |IC| = 0.0939 (floor 0.04),
> |t| = 2.447 (floor 2), baseline |IC| = 0.0673, p = 0.0147 vs BH threshold 0.0167 at rank 1
> of 6."

Then scroll two entries down.

> "Two hypotheses later, the same hypothesis is **killed**. Same IC. Same t-stat. Same
> p-value — 0.0147, it never moved. What moved was the bar. At six hypotheses the
> Benjamini-Hochberg threshold was 0.0167 and it cleared. At seven it was 0.0143 and it
> didn't."

> "That is the entire point of the project. Test enough ideas and one will look brilliant by
> luck. The correction exists to catch exactly that, and here it caught one — on its own, in
> the committed record, with both entries visible."

> "200 hypotheses. Zero promoted. The one it briefly liked, it took back."

```
Step 8  (3:05–3:25)  LOCKED_TEST is still sealed
```
**This replaces §16's "out-of-sample IC" beat.** Screen: `config/partitions.json`, the
`LOCKED_TEST` block.

> "This is the third partition — 24 August to 10 September. The loop has never read it. The
> code refuses unless you pass an explicit override flag that loop code never sets."

> "The spec's demo was going to show an out-of-sample number here. We can't, and we shouldn't:
> nothing was promoted, so nothing earned the right to read it. And if we ran it now on
> H-0006 we'd be picking the hypothesis *because* it was the best-looking one — which is the
> selection effect this partition exists to prevent. Sealed is the correct outcome."

```
Step 9  (3:25–3:55)  The execution guard
```
Screen: the guard module, then the test suite running.

> "Five deterministic checks, in sequence, and the LLM is not involved in any of them.
> Check one is the paper-trading flag — it runs first, before anything touches the network,
> because it's the only check whose failure means real money. Check two, position cap. Check
> three, size cap — that one clips rather than refuses. Check four, price sanity. Check five,
> confirmation."

> "In this session it never ran in anger, because nothing was promoted. So here it is running
> in the tests instead — including the case where it refuses."

```
Step 10 (3:55–4:35)  The order that really was placed
```
**This replaces §16's "paper order executing" — and it changed again on 2026-09-21, when the
execution leg placed its first real order.** Screen: `apps/agent/logs/paper-live.jsonl`.

> "Here is the execution leg. Every line in this file was captured live — placed by the same
> Execution Guard and the same Agent Hub client the agent runs, against Bitget's demo
> environment."

Show the accepted row. Read it off the screen:

> `kind=venue_check  BTCUSDT sell  100 USDT`
> `exit_code=0  accepted=true  order_id=1485970832289546240`

> "A hundred USDT sell of BTC, accepted, order id returned by the venue. That's the first
> order this project ever got through."

Then show the row above it — the promoted order, refused:

> `kind=live_order  RGOOGLUSDT buy  refused at CHECK_5`
> `HTTP 400 from Bitget: papTradingService not support RWA order validation error`

> "And this is our own promoted hypothesis, refused. Every instrument we trade is an rToken —
> a tokenised share — and Bitget's demo venue does not validate RWA orders. It's not a bug in
> our code: the same guard, the same client, the same signing put the BTC order through in the
> same run. Only the symbol differs."

Then the part that matters most — say it plainly, do not bury it:

> "We didn't assume that. We tested the way out. Maybe only market orders were blocked, so we
> tried a limit order. Same refusal. Limit buy, limit sell, market — all three. Meanwhile a
> BTC limit order was accepted on the same run. So the limitation belongs to the instrument,
> not to how we send the order, and there is no workaround on our side. We're telling you
> that rather than showing you a different pair and hoping you don't ask."

> "Nothing finished promoted this session, so no order followed from a promotion. The order you
> just saw is the execution path being proved on purpose, on an instrument the venue accepts."

Then, because a viewer who watched step 3 will otherwise assume this order came out of the
model's session — **name the session it did come from**:

> "This is the deterministic session's execution leg. The model's sixty-hypothesis session
> promoted nothing, so it had no order to place. That's a real limit of that run, not a detail
> we're skipping."

**Honesty note for the camera:** do not say "our agent traded" and do not say "execution
works". Say exactly what happened: the plumbing is proven, the promoted instrument is refused
by the venue, and that is disclosed here.

```
Step 11 (4:35–5:05)  The hash chain
```
Screen: `decisions.jsonl`, then run the verifier.

```bash
cd apps/agent && npm run verify-log
```

> "Every decision is one line. Every line carries the hash of the line before it. Change any
> entry and everything after it stops verifying — you can't quietly delete a kill. 201
> entries, chain intact."

```
Step 12 (5:05–5:35)  The leaderboard, losers first
```
Screen: the leaderboard page.

> "Here's the leaderboard. Zero promoted — and the 200 kills are right here, at the same size,
> with their reasons. A system that hides its kills isn't doing science. We show the graveyard,
> because the graveyard is the finding."

**Close:**

> "Factor Prover didn't find a money-maker. It found 200 dead hypotheses and proved it can't
> cheat about which ones died. That's the claim — and it's checkable: re-run it yourself from
> the repo."

---

## Checklist status

From spec §17, with the two items that cannot be satisfied honestly:

| Item | Status |
|---|---|
| Public repository | ✅ |
| `BITGET_PAPER_TRADING=true` in production | ✅ declared in `render.yaml`, so it is reviewable config rather than a dashboard value. It was **not** set before 2026-09-14, while this row already claimed a tick — corrected. Note it does not authorise an order: `ENABLE_EXECUTION` and the Bitget credentials remain absent, and the guard's later checks still refuse |
| `partitions.json` committed | ✅ |
| `gate_policy.json` committed | ✅ |
| `decisions.jsonl` committed | ✅ 201 entries |
| `decisions-llm.jsonl` committed | ✅ 60 entries, every one `generator: groq` — the record that evidences the model-proposed beat |
| Both records re-verified in CI | ✅ `decisions.jsonl` head `956d09b1…`, `decisions-llm.jsonl` head `07fa256b…` |
| Hash chain verifies | ✅ |
| Demo video 5–6 min, 12 steps | ⬜ to record |
| Live URL accessible | ✅ |
| Defensible claim, not the weak claim | ✅ this script |
| rToken paper-trading limitation disclosed | ✅ README |
| **At least one KILL and one PROMOTE visible** | ⚠️ **one KILL and one PROMOTE are both visible — as the same hypothesis, promoted then demoted (step 7). No hypothesis finished promoted.** |
| **Null-result framing prepared** | ✅ this *is* the framing |
| **The committed deterministic session is never called an LLM session** | ✅ stated in the header table, in step 4 and in step 10 of this script |
| **The model-proposed session is shown, not just asserted** | ⬜ to record — step 3, screen B |

The last two items in §17 contradict each other for this session: the checklist asks for a
PROMOTE, and then anticipates zero promotions. The run produced zero. The checklist item is
met in substance — a PROMOTE verdict is on screen and its demotion is the story — and it is
recorded here rather than quietly ticked.

## Known number to avoid on camera

`total_hypotheses_attempted_this_session` reads **201** in the final entry while 200
hypotheses were attempted, because the field counts log entries and H-0006 is counted twice.
The BH arithmetic is unaffected — it uses the family of distinct testable hypotheses, and
`gate_detail` quotes the correct `m` per entry ("rank 1 of 6", "rank 1 of 7"). If the
dashboard shows 201, say "200 hypotheses, one decided twice" rather than reading the field
aloud. Tracked as action 19 in PROGRESS.md.
