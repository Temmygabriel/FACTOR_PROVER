# CHECK 5 — what the confirmation deviation actually is

**Status:** measured, on the real CLI, with no credentials and nothing sent.
**Date:** 2026-09-27
**Reproduce:** `.github/workflows/probe-check5-confirmation.yml` on `main`.

This document corrects an earlier claim of mine. The claim was that the Bitget
Agent Hub CLI has no two-phase confirmation contract, that it "places on the
first call and would never ask", and that CHECK 5's confirm leg therefore could
not be satisfied without a newer CLI.

**The first half of that is false.** The CLI does have a two-phase confirm
contract, it is live, and I have now observed it. What is true is narrower and
more useful.

---

## 1. The measurement

The probe walks the whole discovery surface (`discover` → domains → per-domain
tools → per-tool input schema), then puts the question to the CLI in its own
terms via `discover --search confirm`, then calls each confirm-gated action on
its **real path** — no `--dry-run`, which turns out to matter (see §4).

`order --action cancelAll --category SPOT`, no `--confirm`, no credentials:

```json
{"endpoint":"POST /api/v3/trade/cancel-symbol-order",
 "requestTime":"2026-09-26T18:23:46.240Z",
 "data":{
   "confirmationRequired":true,
   "operationId":"cancelAllOrders",
   "riskLevel":"high",
   "message":"\"cancelAllOrders\" is destructive or irreversible and was not executed.",
   "hint":"Re-call with confirm: true to proceed, or dryRun: true to preview the request."}}
```

That is the two-phase contract, stated in the CLI's own words. Phase 1 refuses
and says so; the hint names phase 2. It is exactly the envelope
`guard.ts:395-416` waits for.

## 2. Why `place` is different — the venue's own taxonomy

The gate is scoped, and the scope comes from the CLI's own `riskLevel` field
rather than from prose. Taken from the replies:

| operation | `riskLevel` | confirm-gated |
|---|---|---|
| `placeOrder` | `write` | **no** |
| `cancelAllOrders` | `high` | yes |
| `closeAllPositions` | `high` | yes |

The tool schemas agree. For `order` the `confirm` parameter is documented as
*"Required to execute cancelAll (destructive)"* — the qualifier names
`cancelAll`, not `place`. For `position` it is *"Required to execute
close/closeAll (destructive)"*. Every other write tool carries the general form:
*"Required to execute destructive (high-risk) writes; without it such a call
returns `{ confirmationRequired: true }`."*

This is coherent rather than arbitrary. Placing an order is **reversible** — it
can be cancelled. `cancelAll` wipes the book, `closeAll` exits every position,
`withdrawal` moves funds out irreversibly. The gate exists for the irreversible
class, and placement is not in it.

## 3. `--confirm` is inert for `place`

`place` called with and without `--confirm` returns byte-identical output once
the random `requestTime` and `clientOid` are stripped:

```json
{"endpoint":"POST /api/v3/trade/place-order",
 "data":{"dryRun":true,"operationId":"placeOrder","method":"POST",
         "path":"/api/v3/trade/place-order","riskLevel":"write",
         "wouldSend":{"category":"SPOT","symbol":"BTCUSDT","side":"sell",
                      "orderType":"market","qty":"0.001"}}}
```

So no flag combination makes the CLI ask for confirmation on a placement. The
flag is accepted, and it does nothing.

## 4. The contaminated result, recorded on purpose

An earlier run of this probe called `cancelAll` without `--confirm` **under
`--dry-run`** and reported that no action returned `confirmationRequired`. That
result was **contaminated and was briefly cited before being caught.**

`--dry-run` returns the preview **before** the confirm gate is evaluated. The
CLI says so itself, in the hint above: `dryRun: true` is offered as an
*alternative* to confirming. So a dry run returning no envelope was never
evidence that no gate exists — it was a test that could not see the thing it
was testing for.

This is recorded rather than quietly re-run because the failure mode is the
interesting part: the probe produced a sentence that read exactly like a
finding, and it was the sentence I already expected. The only thing that caught
it was asking whether the probe had teeth — the first version collected **0
bytes of tool surface** and reported "no matches" over nothing.

## 5. A real defect this found: the envelope is nested, the parser is not

The CLI sends `confirmationRequired` **nested under `data`** (see §1).

`agentHub.ts:773-776` reads it at the **top level**:

```ts
const confirmationRequired =
  parsed['confirmationRequired'] === true ||
  parsed['confirmation_required'] === true ||
  parsed['status'] === 'confirmation_required';
```

`parsed` is the whole object (line 703-708) and `data` is `parsed['data']`
(line 750-754). Nothing anywhere reads `data['confirmationRequired']`.

**So the parser cannot see the envelope it was written to detect.** If a
confirm-gated call ever reached it, `guard.ts:407` would take the
`!confirmationRequired && !accepted` branch and refuse with *"Agent Hub neither
accepted nor asked for confirmation on the initial call"* — a refusal that is
correct in outcome and **wrong in its stated reason**, and which would be
written into the evidence log.

It is **latent, not live**: `place` is not confirm-gated, so this envelope never
reaches the placement path. It matters because it means CHECK 5's phase 1 has
never actually been exercisable — the guard could not have performed the
two-phase flow even in the case it was written for.

The fix is one line and additive — read the envelope from `data` as well as the
top level — and it is **deliberately not applied here.** It changes what a live
execution path does: today the guard refuses; after the fix it would re-issue
with `confirm: true` and, if the confirmed call were accepted, place. That is
the intended spec behaviour, but it is a behaviour change on an execution path
on submission day, and the path is unreachable, so there is no urgency that
would justify the risk. It belongs with a re-run of the guard tests, not with a
deadline.

## 6. Answer: what would be required for the two-phase confirm to occur

For a **placement**, with the current CLI: nothing can make it occur.

1. **Flag change — impossible.** `--confirm` is already accepted and already
   emitted by this client. It is inert for `place` (§3).
2. **CLI change — needs Bitget.** They would have to move `placeOrder` into the
   high-risk class. Their stated criterion is "destructive or irreversible", and
   placement is neither, so this is a deliberate product decision rather than a
   gap, and it is not ours to make.
3. **Client-side second phase — available but should be labelled as ours.** The
   client half is already implemented correctly. If a genuine two-phase gate on
   placement is wanted, the project would have to supply the second phase
   itself, and must not describe it as Bitget's contract.

## 7. What this means for the submission

Nothing about the v1.0 or v1.1 results changes: no order depends on this, and
the deployed instance has zero promotions, so no placement was ever attempted.

The honest statement is that **Execution Guard CHECK 5 is implemented as the
spec describes and passes, but its confirm leg cannot fire against this venue,
because the venue classifies placement as non-destructive.** `guard.ts:455-476`
already records exactly that — a single-phase acceptance is logged as a
**deviation**, not as a normal pass, with the order id and the fact that the
two-phase flow did not occur. Nothing is being hidden, and the deviation is
visible in the record rather than smoothed over.
