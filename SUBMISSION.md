# Submission — everything in one place

**Portal:** https://forms.gle/GyWZCMCPocgJdJon6
**Stated deadline:** September 27, 2026 (UTC+8)
**Internal target:** **September 23** — see "The date" below
**Track:** Agentic Trading
**Repo:** https://github.com/Temmygabriel/FACTOR_PROVER
**Dashboard:** https://factorprover.vercel.app
**API:** https://factor-prover-agent.onrender.com

---

## The date

The official handbook says **September 27**. This repo said September 21 until
2026-09-21, which was simply wrong — the string "9/21" does not appear anywhere in
the handbook.

**Aim for September 23 anyway.** The handbook contradicts itself on everything
around the deadline: voting is given as both 9/22–9/28 and 9/28–10/7, judge
review as both 9/22–9/28 and 9/22–10/7, and there is one stray line in the Best
Spread FAQ reading *"attach compliant X post at submission on 9/23"*. Aiming at
9/23 means any clarification from the organisers can only move the date later,
never past you.

Source: <https://bitget-ai.gitbook.io/bitgetai_hackathons2/base-camp-hackathon-s2-en>

---

## What the form actually asks for

| Field | Notes |
|---|---|
| **Project Description** | One long answer covering six parts: thesis; target user & product value; validation data & key metrics; progress; deliverables; optional take on AI Trading. **A GitHub repo or X thread cannot substitute for this.** |
| **Role of the LLM in Your Project** | Separate field. Which models, what they do. Qwen usage detail optional. |
| **Submission Materials Link** | One field for demo / code / video / docs / logs. |
| **X Promotional Post Link** | Must carry `#BitgetHackathon` + `@Bitget_AI`, introduce what you built, and **quote** `https://x.com/Bitget_AI/status/2100519318824055159?s=20`. |
| **Track → Sub-theme** | Agentic Trading. |
| Optional | University name; Apply for Demo Day; Apply for K3 Token Subsidy. |

**Agentic Trading track requires:**

- Runnable Demo — *required*
- Event → decision → execution flow demonstration — *required*
- Paper trading log, "actually run during competition period, recommended ≥2 weeks" — *required*
- Compliant X post link — *required*

**Invalid if:** missing the compliant X post, the project description, or
accessible materials. The handbook's own words: **"No X post = incomplete
submission."**

**Other links:**
- Qwen build-credit form: https://forms.gle/2QeJpvGB5VpipqQ68
- Official Telegram: https://t.me/+o1tYqQ_lXxllYjgy
- Event page: https://www.bitget.com/activity-hub/hackathon

---

## Status: what is done

| | |
|---|---|
| GitHub repo public | ✅ https://github.com/Temmygabriel/FACTOR_PROVER |
| Live dashboard | ✅ https://factorprover.vercel.app (HTTP 200) |
| Live API | ✅ healthy, `/api/status` answering |
| Decision log committed | ✅ `apps/agent/logs/decisions.jsonl`, 201 entries |
| Hash chain verifies | ✅ `/api/log/verify` → `ok: true`, 201 entries, head `sha256:956d09b1…` |
| Frozen datasets + partitions + gate policy committed | ✅ 33 files, hash `b0fd26a3…` |
| Execution leg has placed a real order | ✅ BTCUSDT sell accepted, order id `1485970832289546240` |

---

## Status: what is NOT done — the gap list

Ordered by how likely each is to cost marks. **Items 1 and 2 are the ones that
can actually sink the submission** — both are listed as required, and neither
exists yet.

### 1. 🔴 There is no demo video

The track requires a "Runnable Demo". There is **not a single video file** in the
repo. `docs/DEMO_SCRIPT.md` describes a 5–6 minute, 12-step run-through, but it
has never been recorded.

This is the largest remaining gap and it is not a code problem.

### 2. 🔴 There is no X post

Required, and the handbook is explicit that its absence makes the submission
incomplete. Must carry `#BitgetHackathon` + `@Bitget_AI` and quote the specified
tweet. Nothing has been posted.

### 3. 🟠 The promoted factor's own order cannot fill in demo

Structural, at the venue — see the section below. Disclosed, but see the risk
note there.

### 4. 🟠 The paper-trading log is thin

The track asks for a log "actually run during competition period, recommended
≥2 weeks". There is one live execution run (`paper-live.jsonl`). The six days the
corrected deadline bought are the honest way to close this: let the loop run and
accumulate.

### 5. 🟡 "Role of the LLM in Your Project" is not written

Needs writing from scratch. The material exists — three-tier provider-agnostic
wrapper (Groq → Gemini → deterministic enumerator), schema-constrained
hypothesis JSON, the LLM cannot write free text or change thresholds — but it has
to be assembled into an answer.

### 6. 🟡 The deployed instance runs with execution disabled

`/api/status` reports `available: false` — no Bitget credentials on Render, by
design. So a **live** visitor exercises only the refusal path. This interacts
with gap 1: the demo video has to carry the real execution evidence, because the
deployed URL will not produce any.

### 7. 🟡 No lockfile anywhere in the repo

CI, Render and Vercel all resolve fresh version ranges from `package.json`. The
*data* is frozen and hashed; the *build* is not pinned. For a project whose claim
is reproducibility, that is a real hole — and it cannot be closed locally,
because `npm install` is banned on this 8GB machine. It has to happen in CI.
Noted in `PROGRESS.md` as item 25.

---

## Why the factor's own order did not trade

**Short version: Bitget's demo environment refuses tokenised equities, and every
instrument this project trades is one.**

The verbatim refusal, from the venue:

```
HTTP 400 from Bitget: papTradingService not support RWA order validation error
```

`RGOOGLUSDT` is an rToken — a tokenised equity. `papTradingService` is Bitget's
paper-trading engine. It does not implement order validation for RWA
instruments, so the order dies before size, balance or price are ever considered.

**It is not a bug in this repo, and the control proves it.** The same code path —
same `ExecutionGuard`, same `bgc` argv builder, same signing — placed a
**BTCUSDT sell** and the venue accepted it:

```
run 35627286184   2026-09-21T16:42:55Z
exit_code=0   accepted=true   order_id=1485970832289546240
```

Same plumbing, different instrument, opposite outcome. That is what makes the
rToken refusal a statement about the venue rather than about this code. The only
difference between the two orders is the symbol.

Both rows are committed side by side at `apps/agent/logs/paper-live.jsonl`.

**Ruled out:** it is not a balance problem (the demo account's USDT sits in
`fundingAssets`, unreachable by the trading API, and `transfer_funds` returns 404
in demo — which is why the accepted order is a *sell*), and it is not a
precision problem (that was a separate, real bug, fixed in `c776fc6`).

**Still untested: a LIMIT order on an rToken.** Every attempt so far has been a
market order. If the RWA validation is skipped for limit orders, the factor could
trade after all. Cheap to test, genuinely unknown — worth one probe before
submission.

---

## The honest risk: judges may not read the explanation

This is the part worth thinking about calmly.

**The explanation is legitimate.** It is a real venue limitation, with the
verbatim error, on a code path independently proven to work by the BTCUSDT
acceptance. Any reviewer who reads it will accept it.

**But legitimate is not the same as seen.** A judge skimming a demo video who
sees "order refused" in the execution panel may score it as a broken execution
leg and never reach the explanation. The risk is not that the reasoning is weak —
it is that the reasoning is *buried*.

Three ways to manage it, in increasing order of effort:

1. **Lead with the working order, not the refusal.** The demo's execution segment
   should open with the accepted BTCUSDT order and its order id — proof the leg
   works — and *then* show the rToken refusal as a finding. Same facts, ordered
   so the viewer's first impression is correct.
2. **Frame it as the thesis.** This project's entire claim is that it reports what
   did not work as loudly as what did — "we show the losers". A venue limitation
   found, documented with a verbatim error, and disclosed in the submission is
   *on-thesis*, not off it. Say that out loud in the video rather than leaving the
   judge to infer it.
3. **Consider a non-rToken factor family.** A BTC-only momentum factor would let
   a promoted factor actually fill end to end. **Not recommended as a default:**
   it changes the factor universe, the frozen datasets and the enum, which
   touches judged artifacts six days out, and the rToken forward-return framing is
   the project's stated thesis. Only worth it if the demo video cannot be made
   convincing otherwise.

**The submission text should state the limitation in the description itself, not
only in the linked materials.** A judge who reads only the form should still come
away knowing that the execution leg is proven and that the promoted instrument is
refused by the demo venue for a documented, external reason.

---

## Pre-submission checklist

- [ ] Record the 5–6 minute demo video per `docs/DEMO_SCRIPT.md`
- [ ] Post the X promotion with `#BitgetHackathon`, `@Bitget_AI`, and the quote-tweet
- [ ] Write "Role of the LLM in Your Project"
- [ ] Write the six-part project description
- [ ] Probe whether a LIMIT order on an rToken is accepted (unknown, cheap)
- [ ] Run the loop over the remaining days to thicken the paper-trading log
- [ ] Confirm `BITGET_PAPER_TRADING=true` in the production environment
- [ ] Confirm `GET /api/log/verify` still returns `ok: true` after any new log entries
- [ ] Re-verify the live URLs the morning of submission
- [ ] **Rotate the Bitget demo API keys after the hackathon** — they were shared in chat
- [ ] Never commit `apps/agent/.env` (gitignored; verified containing no live values)
