# Try it

For someone who has never seen this project and has five minutes.

You do not need to read the README first. You do not need an account, a wallet, a key, or
any money. Nothing here can place a trade.

---

## What you are checking

Not "did they find a profitable strategy". They almost certainly did not, and the project
says so on its own front page.

You are checking one claim: **this thing tests trading hypotheses honestly, and reports the
failures as results.**

That is a claim you can verify in about five minutes, and the steps below do it in an order
where each one makes the next one cheaper to believe.

---

## Step 1 — Open it

| | |
|---|---|
| The dashboard | https://factorprover.vercel.app |
| The API behind it | https://factor-prover-agent.onrender.com |

**If the page looks empty or the status says "waking the backend", wait up to a minute and
reload.** The API runs on a free host that sleeps after about fifteen minutes of no traffic.
The first visitor after a quiet spell pays a 30–60 second cold start. That is the free tier,
not a fault, and the interface says which state it is in rather than showing you a spinner
and no explanation.

---

## Step 2 — Read the black band at the top

Before the navigation, on every page, there is a dark strip. It says:

> Factor Prover runs trading hypotheses through a strict scientific test.
> **Most fail. That's the point.**

and on the right, three counters.

**Those counters are the current session, not the whole project — so on your first visit they
read zero, and that is correct.** The live service is a fresh process that has not tested
anything yet. They start moving the moment you press Start in the next step, and they reset
if the service restarts.

The project's actual record is the committed log, and you will meet it in
[Step 5](#step-5--read-the-committed-record). The split is deliberate: the strip reports what
*this process* has done, the log page reports what has been *recorded and kept*. Two numbers
from two sources would eventually disagree, so the interface never mixes them.

If the counters show an em-dash instead of a figure, the backend is still asleep and the page
has not heard from it yet.

**Why the strip is the first thing you see.** A page of two hundred failures looks like a
broken product. It is the opposite: a test that passes everything is not testing anything.
The strip states the ratio before you can misread it, and gives you the reason in the same
breath.

---

## Step 3 — Start a session and watch it work

On the front page, find the **Start** button and press it.

A hypothesis will appear, then a verdict. Each one takes a few seconds.

**What is actually happening.** The agent proposes a structured trading hypothesis — a
signal, a threshold, a direction, a target, a timeframe — backtests it against a frozen
slice of real Bitget market data, and puts it through five fixed statistical checks. Most do
not survive.

**What is not happening.** No money. No order. No exchange account. Not on your press, and
not on any other press.

Two honest notes:

- The live session is served by a free instance with **no persistent disk**. If the service
  restarts, that session's counters reset and the session is gone. The durable record is the
  committed log, which is a different thing and is not affected.
- Starting a session spends the project's free LLM quota. It is not billed to you, but it is
  a finite thing — if you press Start five times you will use it five times.

---

## Step 4 — Read one verdict

Every verdict is rendered as a stamp. A kill and a promotion are drawn at the same size, in
the same type, with the same five rows of evidence.

The five rows are the whole test. Each shows **what was measured**, **what the bar was**, and
**whether it cleared**:

| check | what it asks |
|---|---|
| observations | was there enough data for the test to mean anything |
| information coefficient | is the relationship stronger than the floor |
| t-statistic | is it distinguishable from luck |
| baseline | did it beat a naive strategy |
| multiple testing | did it survive the correction for how many things were tried |

The last one is the one most projects skip. If you test 200 ideas, one of them will look
brilliant by chance. The gate applies a Benjamini–Hochberg correction and raises the bar
accordingly, so a p-value that would pass on its own does not pass here.

**Open "What does this mean?"** on any stamp. It shows the raw signed figures behind the
plain-English sentence — the same row, unrounded, so you are not asked to take the summary
on trust.

---

## Step 5 — Read the committed record

Go to **Log** in the navigation.

This is the project's actual output: every hypothesis it has tested, in order, one row each.
At the time of writing that is **201 entries — 200 killed, 1 promoted** — and the single
promotion is drawn at exactly the same size and weight as the kills around it.

Three things to look at while you are here:

- **The header** states the count and what the file guarantees: *each entry hashes the one
  before it, so altering or removing a line breaks every hash after it.*
- **The banner at the top** is the chain check running. It says it is verifying before it
  says it passed, and claims nothing until it answers.
- **The `Verify chain` button** re-runs that check on demand. Press it. You are not being
  asked to trust a status light; you are being handed the tool.

Every row carries its hypothesis, its numbers, its verdict, and the two hashes that tie it to
its neighbours. Nothing is summarised away.

## Step 6 — Check the rules were written before the results

This is the strongest check available, and it takes one command.

A test is meaningless if you get to choose the pass mark after seeing the score. So the
thresholds are committed to the repository, and the commit dates prove the order:

```bash
git log -1 --date=short --format="%h  %ad  %s" -- apps/agent/config/gate_policy.json
git log -1 --date=short --format="%h  %ad  %s" -- apps/agent/logs/decisions.jsonl
```

The policy is dated **2026-09-11**, in the initial commit. The first recorded session is
dated **2026-09-13**.

**The bars were fixed two days before any result existed**, in the same public history you
are reading. You do not have to believe a sentence in a README; the date is in the object
you already have.

If you want the actual numbers, read
[`apps/agent/config/gate_policy.json`](../apps/agent/config/gate_policy.json). It is short
and it is not code.

---

## Step 7 — Prove the record has not been edited

Every entry in the log carries the hash of the entry before it. Changing any entry breaks
every entry after it, which is detectable without trusting whoever wrote the file.

```bash
git clone https://github.com/Temmygabriel/FACTOR_PROVER
cd FACTOR_PROVER
npm install
npm run verify-log --workspace apps/agent
```

You should get `PASS` and a count of entries.

**Do not take the PASS on faith — make it fail.** Copy the log somewhere, change one word in
one line, and verify the copy:

```bash
cp apps/agent/logs/decisions.jsonl /tmp/tampered.jsonl
sed -i '1s/KILL/HOLD/' /tmp/tampered.jsonl
npx tsx apps/agent/src/log/verify.ts --file /tmp/tampered.jsonl
```

That must fail, at line 1, and it should look like this:

```
FAIL — 1 problem(s) found.

  line 1  E-0001  hash_mismatch
      entry_hash is sha256:daff8ed2... but this entry's own fields hash to
      sha256:a3f21fb0... — a field was edited
```

Note what it does *not* say. It does not complain about the file's size or its formatting —
it recomputes each entry's digest from that entry's own fields and compares. That is the
difference between a checksum and a chain: the verifier would also pass if you rewrote the
whole file with different line endings and changed nothing else, because the claim is about
the entries, not about the bytes.

A verifier that cannot fail is not a verifier. This is the step that proves the tool has
teeth rather than agreeing with itself.

---

## Step 8 — Confirm it cannot place an order

There are five checks between a promoted factor and an order. The first one refuses
everything unless the environment says `BITGET_PAPER_TRADING=true` exactly, and no exchange
credentials are configured on the live service at all.

You can see this without reading any code. Open the API's status endpoint:

```
https://factor-prover-agent.onrender.com/api/status
```

The `execution` field reports its own state and says plainly what is and is not possible.
The project would rather show you a limitation than let you assume a capability.

Even if an order were authorised, this runs against a **paper** account. There is no real
money anywhere in this project.

---

## Step 9 — Run the whole thing yourself

You do not have to trust the committed log, because you can produce your own.

On GitHub: **Actions → Demo run → Run workflow**.

That runs the same session loop the live server runs, against the same frozen dataset, on
GitHub's computers. It needs no secrets, no keys, no accounts, and nothing is billed to
anyone. When it finishes it commits its log, which you can then read and verify yourself.

By default it uses the deterministic enumerator, so your run is reproducible: run it twice
and you get the same log. That is deliberate — it is what makes the reproducibility claim
checkable instead of merely stated.

---

## The one-paragraph version

A dark strip tells you most hypotheses fail. You can press a button and watch one fail. You
can open the stamp and read the arithmetic. You can check, from the commit dates, that the
pass marks were fixed before the results existed. You can break the log and watch the
verifier catch it. And you can reproduce the whole session on your own machine or on
GitHub's.

The project claims a falsifiable protocol, not a profitable signal. Everything above is
there so you can falsify it.
