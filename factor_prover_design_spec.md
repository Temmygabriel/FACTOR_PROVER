# Factor Prover — Design Specification

**Product:** Factor Prover  
**Track:** Agentic Trading — Factor mining agent  
**Interface:** Web application (Next.js, Vercel deployment)  
**Coding assistant:** DeepSeek Flash V4 inside Claude Code  
**Framework:** Next.js 14, Tailwind CSS, no component library  

---

## 1. Design Concept

### The Material Reference: The Assay Office

Factor Prover does exactly what an assay office does: samples arrive, they are
tested under a controlled protocol, and they are stamped with a result.
CERTIFIED or REJECTED. The sample does not argue with the stamp.

This is the one material reference for this product. Every visual decision flows
from it. An assay office is not a dashboard. It is not a trading terminal.
It is not a startup app. It is a place where evidence is weighed and verdicts
are issued. It has the aesthetic of serious institutional process: precise,
legible, slightly austere, with weight given to the verdict stamp above all else.

The interface should feel like a piece of research infrastructure — the kind of
tool a quantitative researcher uses alone, late, with no interest in decoration.

### The Hero Moment

A hypothesis card arrives. The backtest numbers populate line by line.
The gate runs. Then a stamp appears — large, weighted, unmistakable — either:

```
  ┌─────────────────┐        ┌─────────────────┐
  │                 │        │                 │
  │    PROMOTED     │   or   │     KILLED      │
  │                 │        │                 │
  │  IC  0.071      │        │  p > BH(0.023)  │
  │  t   2.41  ✓   │        │  raw p  0.031   │
  │  obs 214   ✓   │        │  obs    214     │
  │                 │        │                 │
  └─────────────────┘        └─────────────────┘
```

The stamp is the hero. Not a green number. Not a chart. A verdict.

A KILLED stamp is as visually weighted as a PROMOTED stamp. There is no visual
hierarchy that makes kills look like failures of the product. A kill is a result.
The interface communicates this through equal visual treatment.

This moment should be reachable within 90 seconds of a judge opening the app —
either via the live loop or via the demo replay.

---

## 2. Self-Check Against Generic Defaults

Before finalising any element, check it against these five defaults.
Each is explicitly rejected here:

**Rounded SaaS cards with drop shadows:**
Rejected. Cards in this interface use a 1px border in a mid-tone ink color,
zero border-radius, zero box-shadow. The assay office aesthetic is rectilinear
and precise. Rounded corners belong to consumer apps.

**Dark mode + neon accent (purple/green/cyan on black):**
Rejected. This interface uses a light ground — off-white paper — with dark ink.
The only accent is a single muted amber used exclusively for active/loop-running
states. No neon. No glow. No gradient washes.

**Cream/serif/terracotta editorial combination:**
Rejected. The typeface pairing here is utilitarian and technical — a grotesque
for interface labels and a tabular-figures mono for all numeric data. No serif.
No terracotta.

**Decorative monospace as aesthetic device:**
Rejected. Monospace is used only where it serves a functional purpose:
hash strings, raw JSON values, and numeric data that must column-align.
It is never used for headlines, labels, or copy.

**ALL-CAPS eyebrow labels:**
Rejected, with one exception. The verdict stamps (PROMOTED / KILLED / RETIRED)
are all-caps because they are stamps — physical analogues — and that typographic
weight is load-bearing, not decorative. Every other label in the interface is
sentence case.

---

## 3. Color Palette

```
NAME              HEX       ROLE
─────────────────────────────────────────────────────────────────
Paper             #F5F3EE   Page background. Warm off-white,
                            not bright white. Feels like stock.

Ink               #1A1A18   Primary text. Near-black with
                            slight warm cast. Not pure black.

Ink-light         #6B6B66   Secondary text, labels, metadata.
                            Subdued but readable.

Rule              #D4D0C8   Borders, dividers, table rules.
                            Recedes — structure without noise.

Promoted          #2D6A4F   PROMOTED stamp, active factor
                            indicators. Deep institutional green.
                            Not lime. Not neon. Forest.

Killed            #8B1A1A   KILLED stamp only. Deep red.
                            Exactly as weighted as Promoted.
                            Not orange. Not bright red.

Retired           #4A4A42   RETIRED stamp. Neutral dark grey.
                            A factor that lived and decayed.

Amber             #C17D3C   Active loop indicator, currently
                            running backtest. The only warm
                            accent. Used sparingly.

Data-positive     #2D6A4F   Positive IC, positive paper P&L.
                            Same as Promoted — intentional.

Data-negative     #8B1A1A   Negative IC, negative paper P&L.
                            Same as Killed — intentional.

Surface           #EDEAE3   Card backgrounds, sidebar fill.
                            One step darker than Paper.
```

No gradients. No opacity washes. No box shadows.
Color is used to carry meaning, not decoration.

---

## 4. Typography

**Primary typeface: Inter**
Used for all interface labels, body copy, navigation, and non-numeric content.
Inter is chosen for its legibility at small sizes, its neutral personality, and
its tabular number variant. It does not call attention to itself.

```
Display / Stamp text:    Inter Bold, 24–32px, tracked slightly wide (0.02em)
                         Used only for: PROMOTED / KILLED / RETIRED stamps
                         and the product wordmark

Section headers:         Inter SemiBold, 14px, sentence case
                         Used for: screen titles, panel headers

Body / Label:            Inter Regular, 13px, sentence case
                         Used for: metadata, descriptions, copy

Small / Caption:         Inter Regular, 11px, Ink-light color
                         Used for: timestamps, IDs, secondary metadata
```

**Numeric typeface: IBM Plex Mono**
Used exclusively for: all numeric data (IC, t-stat, p-values, hash strings,
raw JSON). This is a functional choice, not an aesthetic one. Numbers must
column-align. Hash strings must be machine-readable at a glance.

```
Numeric data:            IBM Plex Mono Regular, 13px
                         Color: Ink for neutral, Promoted/Killed for directional
Hash strings:            IBM Plex Mono Regular, 11px, Ink-light
                         Truncated to first 12 chars + "..." in list views
                         Full string on factor detail view
```

Type scale is tight. This is a data-dense research tool, not a marketing page.
No decorative spacing. No oversized display type except the verdict stamp.

---

## 5. Layout Principles

**Grid:** 12-column, 24px gutter, 32px page margin.
Content max-width: 1280px. Left-aligned throughout.

**Information hierarchy is spatial, not decorative.**
Most important information (verdict stamp, current IC, loop status) is
top-left. Supporting data (metadata, hash, timestamps) is bottom-right
or secondary column. The eye moves left-to-right, top-to-bottom, and
finds the most important thing first every time.

**Tables over cards for list views.**
The factor leaderboard and decision log are tables — not card grids.
Tables communicate that this is data with structure. Cards communicate
that this is content to browse. This is a research tool.

**Borders over backgrounds for grouping.**
Sections are separated by 1px Rule-color borders, not background color
changes or shadow-lifted cards.

**Motion is a single event per screen.**
The verdict stamp animates in exactly once: a brief scale-up from 0.85
to 1.0 over 180ms, no bounce, no easing theatrics. This is the only
non-user-triggered animation in the product. Everything else responds
only to user action (click, hover). No scroll animations. No stagger
effects. No fade-and-slide-up on sections.

---

## 6. Screen-by-Screen Specification

---

### Screen 1: Live Loop View (Default Route `/`)

**Purpose:** Show the loop running. One hypothesis at a time, in sequence,
with the verdict stamp as the focal point. A judge landing here should
understand what is happening within 20 seconds without reading anything.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  FACTOR PROVER                         ● LOOP ACTIVE    [Pause] │
│  nav: Loop  Leaderboard  Log                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  SESSION S-2026-09-10-001                                       │
│  43 attempted  ·  1 promoted  ·  42 killed  ·  0 retired       │
│                                                                 │
├──────────────────────────────────┬──────────────────────────────┤
│  CURRENT HYPOTHESIS              │  SESSION STATS               │
│                                  │                              │
│  H-043                           │  FDR level        0.10      │
│  btc_funding_rate → RCOINUSDT    │  BH threshold     0.023     │
│  condition: spike > 0.05%        │  Hypotheses run   43        │
│  forward window: 4h              │  Est. false disc. 4.3       │
│  family: funding_to_rtoken       │                              │
│                                  │  Discovery window            │
│  ── BACKTEST RUNNING ──────────  │  Jun 15 – Aug 20, 2026      │
│                                  │                              │
│  IC          0.041               │  Gate policy   v1.0         │
│  t-stat      1.87                │  Locked        Sep 10       │
│  p-value     0.031               │                              │
│  n_obs       214                 │                              │
│  baseline IC 0.019  beat ✓       │                              │
│                                  │                              │
│  ── GATE ──────────────────────  │                              │
│                                  │                              │
│  ┌──────────────────────────┐    │                              │
│  │         KILLED           │    │                              │
│  │                          │    │                              │
│  │  p 0.031 > BH 0.023      │    │                              │
│  │  did not survive FDR     │    │                              │
│  │  correction at 43 tests  │    │                              │
│  └──────────────────────────┘    │                              │
│                                  │                              │
├──────────────────────────────────┴──────────────────────────────┤
│  RECENT DECISIONS                                               │
│                                                                 │
│  H-042  btc_oi → RCOIN       4h   KILLED    p > BH  2 min ago  │
│  H-041  btc_spot → RSPY      2h   KILLED    n<100   4 min ago  │
│  H-040  btc_funding → RNVDA  4h   PROMOTED  IC 0.071 9 min ago │
│  H-039  eth_oi → RAAPL       1h   KILLED    p > BH  12 min ago │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key copy:** The verdict stamp is the largest element on the screen.
The session counter line ("43 attempted · 1 promoted · 42 killed") is
the second thing the eye lands on. Both are visible without scrolling.

**Interaction:**
- [Pause] button pauses the loop. Changes to [Resume] when paused.
- Recent decision rows are clickable — navigate to factor detail view.
- The current hypothesis panel updates in real time via SSE stream.
- The amber dot next to "LOOP ACTIVE" pulses slowly (2s cycle, CSS only)
  while the backtest is running. Stops when the verdict is issued.
  This is the only ambient animation.

**Demo note:** This is the screen the demo opens on. Steps 3–6 of the
12-step demo all happen here (hypothesis proposal → backtest → KILL stamp).

---

### Screen 2: Factor Leaderboard (`/leaderboard`)

**Purpose:** Show every promoted factor alongside every killed factor.
The kills must be present and visible. A leaderboard that only shows
winners is not a research record.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  FACTOR PROVER                         ● LOOP ACTIVE    [Pause] │
│  nav: Loop  Leaderboard  Log                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  FACTOR LEADERBOARD                                             │
│  Session S-2026-09-10-001  ·  43 hypotheses  ·  Sep 10, 2026   │
│                                                                 │
│  Promoted factors (1)                                           │
│  ──────────────────────────────────────────────────────────── │
│  ID      Signal             Target   Window  IC     t    obs   │
│  H-040   btc_funding_rate   RCOIN    4h      0.071  2.41 187   │
│          Paper P&L: +2.3 USDT  ·  Status: ACTIVE               │
│                                                                 │
│  Killed (42)                                [Show all / Top 10] │
│  ──────────────────────────────────────────────────────────── │
│  ID      Signal             Target   Window  IC     Reason     │
│  H-043   btc_funding_rate   RCOIN    4h      0.041  p > BH    │
│  H-042   btc_oi             RCOIN    4h      0.031  p > BH    │
│  H-041   btc_spot           RSPY     2h      —      n < 100   │
│  H-039   eth_oi             RAAPL    1h      0.018  p > BH    │
│  H-038   btc_funding_x_spot RAMZN    8h      0.009  p > BH    │
│  ...                                                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Column labels and dual vocabulary:**

The leaderboard shows technical column headers. A plain-language
tooltip appears on hover for every stat column.

```
Column header:  IC
Tooltip:        "How consistently this signal predicted direction.
                 0 = no relationship. Above 0.04 is meaningful here."

Column header:  t
Tooltip:        "Statistical confidence. Above 2.0 means the result
                 is unlikely to be random chance."

Column header:  obs
Tooltip:        "Number of valid data points used in the test.
                 Below 100 = not enough evidence to test."

Kill reason values with tooltips:
  "p > BH"   → "Did not survive multiple-testing correction
                 across all hypotheses attempted this session"
  "n < 100"  → "Too few data points to test reliably"
  "no base"  → "Did not outperform a naive prior-period return signal"
  "schema"   → "Hypothesis did not conform to required structure"
```

**Key copy:** "Killed (42)" is written at the same visual weight as
"Promoted factors (1)". Not greyed out. Not collapsed by default.
Both sections are immediately visible on load.

**Demo note:** Used at Step 12. Scroll to show kills below the promoted
factor. Say: "We show the losers. A system that hides its kills is
not doing science."

---

### Screen 3: Decision Log (`/log`)

**Purpose:** The full timestamped research record. Every hypothesis,
every gate decision, every hash. This is the tamper-evidence screen.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  FACTOR PROVER                         ● LOOP ACTIVE    [Pause] │
│  nav: Loop  Leaderboard  Log                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  DECISION LOG                                   [Verify chain]  │
│  Session S-2026-09-10-001  ·  43 entries                       │
│  Chain integrity: ✓ VALID  (verified Sep 10, 14:47 UTC)        │
│                                                                 │
│  ──────────────────────────────────────────────────────────── │
│  E-0043   14:32:07 UTC                              KILLED      │
│  H-043 · btc_funding_rate → RCOINUSDT · 4h                     │
│  IC 0.041 · t 1.87 · p 0.031 · BH threshold 0.023 · obs 214   │
│  prev: a3f9c2...   this: d4e2b1...                             │
│                                                                 │
│  E-0042   14:27:03 UTC                              KILLED      │
│  H-042 · btc_open_interest → RCOINUSDT · 4h                    │
│  IC 0.031 · t 1.44 · p 0.074 · BH threshold 0.021 · obs 198   │
│  prev: 9c2a11...   this: a3f9c2...                             │
│                                                                 │
│  E-0040   14:09:21 UTC                            PROMOTED      │
│  H-040 · btc_funding_rate → RCOINUSDT · 4h                     │
│  IC 0.071 · t 2.41 · p 0.008 · BH threshold 0.018 · obs 187   │
│  prev: 7b1e44...   this: 9c2a11...                             │
│                                                                 │
│  ...                                        [Load older]        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**[Verify chain] button:** Calls `GET /api/log/verify`. Returns either
"✓ VALID — all 43 hashes verified" or the first broken entry ID.
Result displays inline below the chain integrity line. No modal.

**Verdict in log:** Each entry shows the verdict as a small inline tag
in its verdict color. Same color system as the main stamp.
No icons. Color + text only.

**Hash display:** Truncated to 8 characters in list view.
Full hash on factor detail view. Both `prev` and `this` hashes shown
per entry so the chain is visually readable without documentation.

**Demo note:** Used at Step 11. Show the hash chain. Click [Verify chain].
Say: "Every decision is here. Every kill. Every hash. The log cannot be
edited without breaking the chain."

---

### Screen 4: Factor Detail View (`/factors/[id]`)

**Purpose:** The complete record for one factor. Everything the gate
saw, everything it decided, and the full hash chain entry.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  FACTOR PROVER                                                  │
│  ← Back to leaderboard                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  H-040                                               PROMOTED   │
│  btc_funding_rate → RCOINUSDT  ·  4h forward window            │
│  Proposed Sep 10, 2026, 14:09 UTC  ·  Family: funding_to_rtoken│
│                                                                 │
│  ── Backtest results (DISCOVERY partition) ─────────────────── │
│                                                                 │
│  IC               0.071    (baseline: 0.019)   beat ✓          │
│  t-statistic      2.41                                          │
│  p-value          0.008                                         │
│  n observations   187                                           │
│  Discovery window Jun 15 – Aug 20, 2026                        │
│                                                                 │
│  ── Gate evaluation (VALIDATION partition) ─────────────────── │
│                                                                 │
│  BH-corrected threshold at 40 tests:   0.018                   │
│  Raw p-value:                          0.008    PASS ✓         │
│  IC floor (0.04):                      0.071    PASS ✓         │
│  t-stat floor (2.0):                   2.41     PASS ✓         │
│  Baseline beat:                        yes      PASS ✓         │
│  Gate decision:                        PROMOTE                  │
│                                                                 │
│  ── Out-of-sample (LOCKED_TEST partition) ──────────────────── │
│                                                                 │
│  IC (held-out):   0.038   (in-sample was 0.071)                │
│  Decay:           46% reduction — expected, disclosed           │
│                                                                 │
│  ── Paper execution ────────────────────────────────────────── │
│                                                                 │
│  Paper order placed: Sep 10, 14:11 UTC                         │
│  Symbol: RCOINUSDT  ·  Side: SELL  ·  Size: 50 USDT paper      │
│  Entry: 182.40  ·  Current: 181.90  ·  Paper P&L: +2.3 USDT   │
│  Guard checks: all 5 passed  ·  --paper-trading: confirmed      │
│                                                                 │
│  ── Hash chain entry ───────────────────────────────────────── │
│                                                                 │
│  Entry ID:   E-0040                                            │
│  Prev hash:  7b1e4432a9c2d18f3b0e91c4a72d8f56e3b1092a4c7d8e9  │
│  This hash:  9c2a117b3e4f8d21a0b9c3d6e7f1a428c5b093d2e4f7a1b  │
│  Timestamp:  2026-09-10T14:09:21Z                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key copy:** The out-of-sample IC decay is disclosed prominently and
framed honestly: "46% reduction — expected, disclosed." This is not
buried. It is the second most important number after the in-sample IC.

**Demo note:** Used at Step 8. Navigate here from leaderboard.
Show the out-of-sample number openly. Do not apologise for it.

---

### Screen 5: Empty State (Loop not yet started)

**Purpose:** Tell the builder exactly what to do to start.
No illustration. No mood copy. Just a pre-flight checklist and one button.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  FACTOR PROVER                                    [Start loop]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                                                                 │
│  No session running.                                            │
│                                                                 │
│  Pre-flight checks:                                             │
│  · Data partitions set: Jun 15 – Sep 9, 2026      ✓            │
│  · Gate policy locked: v1.0, Sep 10               ✓            │
│  · Paper trading confirmed                        ✓            │
│  · Bitget API connected                           ✓            │
│                                                                 │
│  [Start loop]                                                   │
│                                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

[Start loop] is disabled (greyed, unclickable) until all four checks
show ✓. Each check reflects real system state — not decoration.

---

### Screen 6: Error State

**API failure — shown as a paused loop with an inline message:**

```
┌─────────────────────────────────────────────────────────────────┐
│  FACTOR PROVER                         ○ LOOP PAUSED            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Bitget API unavailable                                         │
│                                                                 │
│  Candle data request for RCOINUSDT failed (HTTP 503).          │
│  Retry 3 of 3 exhausted. Loop paused.                          │
│                                                                 │
│  No hypothesis was tested. No log entry was written.            │
│  Last valid entry: E-0043.                                      │
│                                                                 │
│  [Retry now]   The loop retries automatically in 60s.           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Malformed LLM output — shown inline in decision log as AUTO-KILLED:**

```
  E-0044   14:35:02 UTC                          AUTO-KILLED
  H-044 · schema validation failed
  reason: signal "btc_news_sentiment" not in allowed signal enum
  no backtest run · no gate evaluation · log entry written
```

Auto-kills appear in the log at equal visual weight to gate kills.
They are part of the research record, not system errors.

---

### Screen 7: Safety Gate Visualization

**Not a separate screen.** A panel that expands within the Live Loop
View whenever a PROMOTED hypothesis triggers a paper order.
Shown at Step 9 of the demo.

**Layout (expansion within Screen 1, below the verdict stamp):**

```
  ── Execution Guard ──────────────────────────────────────────────

  1  Paper trading flag       BITGET_PAPER_TRADING=true    ✓
  2  Position cap             2 open of 3 max              ✓
  3  Size cap                 50 USDT of 100 USDT max      ✓
  4  Price sanity             entry 182.40 · live 182.38   ✓
                              delta 0.01% within 2% band
  5  Confirm gate             confirmationRequired issued   ✓
                              re-issued with confirmation

  All 5 checks passed.
  Paper order submitted to Bitget Agent Hub.
  Order ID: PAPER-20260910-001

  [View on Bitget demo]
```

Each check resolves sequentially with a 200ms pause between them.
This is the one place where sequential animation is used — it serves
the functional purpose of showing the checks run in order.
Each check shows ✓ or ✗ as it resolves. If a check fails, the
sequence stops there and shows the specific failure reason inline.

---

## 7. Navigation

```
Top bar (fixed, full width, 48px height):

┌─────────────────────────────────────────────────────────────────┐
│  FACTOR PROVER     Loop    Leaderboard    Log         [Status]  │
└─────────────────────────────────────────────────────────────────┘

[Status] chip variants:
  ● LOOP ACTIVE     — Amber dot (#C17D3C), "Loop active" text
  ○ LOOP PAUSED     — Rule-color dot, "Loop paused" in Ink-light
  ✗ CIRCUIT BREAK   — Killed-red dot, "Circuit break" in Killed red

Wordmark: Inter Bold, 13px, tracked wide (0.08em), Ink color.
Nav items: Inter Regular, 13px, Ink-light when inactive, Ink when active.
Active nav item has a 2px Ink underline — no background highlight.

No hamburger. No sidebar on desktop. Three items, always visible.
Mobile: same three items below the wordmark, full width.
```

---

## 8. The Verdict Stamp Component

This is the most important component in the product. Build it first.
Everything else is secondary to getting this right.

```typescript
// VerdictStamp.tsx

interface VerdictStampProps {
  verdict: "PROMOTED" | "KILLED" | "RETIRED" | "AUTO-KILLED";
  reason?: string;        // secondary line inside stamp
  stats?: {               // optional stat lines inside stamp
    ic?: number;
    t_stat?: number;
    obs?: number;
    bh_threshold?: number;
    raw_p?: number;
  };
  size: "large" | "small";
  animate: boolean;       // true on first render only
}

// LARGE stamp (Live Loop View, Factor Detail View):
//   width: 100% of the hypothesis panel column
//   padding: 20px 24px
//   border: 2px solid [verdict color]
//   border-radius: 0
//   background: [verdict color] at 6% opacity (use Tailwind /6)
//   verdict text: verdict color, Inter Bold, 28px, letter-spacing 0.04em
//   reason text: verdict color, Inter Regular, 13px, mt-2
//   stat lines: IBM Plex Mono Regular, 13px, verdict color

// SMALL stamp (Decision Log rows, Leaderboard rows):
//   display: inline-flex
//   padding: 2px 8px
//   border: 1px solid [verdict color]
//   border-radius: 0
//   background: transparent
//   text: verdict color, Inter SemiBold, 11px

// ANIMATION (large stamp, animate=true only):
//   initial:  transform: scale(0.85), opacity: 0
//   final:    transform: scale(1.0),  opacity: 1
//   duration: 180ms
//   easing:   ease-out
//   no bounce, no spring, no overshoot

// COLOR MAP:
//   PROMOTED:    border/text #2D6A4F  bg #2D6A4F/6
//   KILLED:      border/text #8B1A1A  bg #8B1A1A/6
//   RETIRED:     border/text #4A4A42  bg #4A4A42/6
//   AUTO-KILLED: border/text #8B1A1A  bg #8B1A1A/6  (same as KILLED)
```

**Critical rule:** PROMOTED and KILLED stamps must be visually identical
in size, weight, border thickness, and padding. The only difference is
color. Neither is larger, bolder, or more prominent than the other.
They are both verdicts. The interface does not editorialize.

---

## 9. Copy Guidelines

### Product tagline
```
Factor Prover tests cross-asset hypotheses against Bitget market data
and issues a verdict on each one. It shows every kill.
```
No marketing language. No profitability claims. No superlatives.

### Verdict label copy

```
PROMOTED    — the factor cleared the preregistered statistical gate
KILLED      — the factor did not survive multiple-testing correction
RETIRED     — the factor was promoted but its edge has decayed
AUTO-KILLED — the hypothesis did not conform to the required schema
```

Never use: "rejected", "failed", "bad signal", "unsuccessful".
These imply the product failed. KILLED is a verb. The gate killed it.
That is a result.

### Null result framing

If zero factors are promoted at the time of submission, this copy
appears on the leaderboard in place of the promoted section:

```
No factors promoted in this session.

[N] hypotheses tested. [N] did not survive the Benjamini-Hochberg
correction applied across all [N] tests at FDR level 0.10.

This is a result. A factor miner that promotes everything is broken.
The gate is working.
```

This copy must be written, styled, and ready before the demo.
It is not a fallback. It is an honest statement judges will respect.

### Error message — Bitget API unavailable
```
Bitget API unavailable.
[Endpoint] returned [HTTP status]. Retry [n] of 3 exhausted.
Loop paused. No data was used. No log entry was written.
```
Never: "Something went wrong." Always: what failed and what was not affected.

### Safety gate label
```
Execution Guard
```
Not "Safety Layer", "Risk Manager", "Guard Rails", or "Circuit Breaker".
Execution Guard — two words, functional, describes what it does.
Circuit Breaker is a separate system (loop-level) and is labeled separately.

### Loop status copy
```
Loop active       (not "Running" — the loop is active, not the UI)
Loop paused       (not "Stopped" — it can resume without reset)
Circuit break     (not "Error" — a circuit break is a designed state)
```

### Demo mode banner
```
REPLAY — Session S-2026-09-10-001
```
Shown as a persistent banner at the top of every screen during replay.
Full width. Amber background (#C17D3C at 10% opacity). Never hidden.
The demo is honest that it is a replay.

---

## 10. Responsive Behaviour

**Desktop (≥1024px):** Full two-column layout on the Live Loop View.
All tables fully visible. Full navigation bar.

**Tablet (768–1023px):** Single column. Session stats panel moves below
the hypothesis panel. Tables scroll horizontally.

**Mobile (<768px):** Not optimised. Show this message:

```
Factor Prover is built for desktop.
Open on a laptop or desktop browser for the full experience.
```

Do not compromise the desktop experience to support mobile.
The hackathon demo is recorded on desktop.

---

## 11. Implementation Notes for DeepSeek

### Build order

Build in this exact order. Do not start the next item until the current
one works correctly.

```
1.  VerdictStamp component — both sizes, all four verdict states,
    animation on large stamp. Get this exactly right before anything else.

2.  Live Loop View shell — static layout, no SSE. Just the structure
    and a hardcoded hypothesis card with a KILLED stamp.

3.  Factor Leaderboard — static data, table layout, both sections
    (promoted + killed), dual-vocabulary tooltips.

4.  Decision Log — static data, hash display (truncated),
    [Verify chain] button (calls API, shows result inline).

5.  Factor Detail View — all sections including the out-of-sample
    panel and full hash display.

6.  Empty state and error states — pre-flight checklist, API error
    inline message, auto-kill log entry.

7.  Safety Gate visualization panel — sequential animation for the
    5-step check sequence. Expansion within the Live Loop View.

8.  SSE integration — wire the live loop view to the backend stream.
    Replace static hardcoded data with real events.

9.  Demo replay mode — controlled playback of a prerecorded session
    at builder-controlled speed. Replay banner persistent.

10. Responsive adjustments — desktop to tablet only.
    Mobile message only.
```

### Tailwind classes to use consistently

```
Page background:    bg-[#F5F3EE]
Surface/card bg:    bg-[#EDEAE3]
Primary text:       text-[#1A1A18]
Secondary text:     text-[#6B6B66]
Borders/rules:      border-[#D4D0C8]

Promoted color:     text-[#2D6A4F]  border-[#2D6A4F]  bg-[#2D6A4F]/6
Killed color:       text-[#8B1A1A]  border-[#8B1A1A]  bg-[#8B1A1A]/6
Retired color:      text-[#4A4A42]  border-[#4A4A42]  bg-[#4A4A42]/6
Amber/active:       text-[#C17D3C]  bg-[#C17D3C]/10

Mono font:          font-mono  (IBM Plex Mono via next/font)
Border radius:      rounded-none  (apply globally, override nothing)
Box shadow:         shadow-none   (no shadows anywhere)
```

### Do not use

```
rounded-*         — zero border-radius on every element
shadow-*          — no box shadows anywhere
bg-gradient-*     — no gradients anywhere
animate-pulse     — only the amber loop-active dot uses a pulse,
                    implemented as a custom CSS keyframe, not Tailwind
uppercase         — only inside VerdictStamp and the nav wordmark
text-center       — all content is left-aligned
```

### Font loading (next/font)

```typescript
import { Inter } from 'next/font/google';
import { IBM_Plex_Mono } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

const ibmPlexMono = IBM_Plex_Mono({
  weight: ['400'],
  subsets: ['latin'],
  variable: '--font-mono',
});
```

Apply `font-[--font-inter]` globally and `font-[--font-mono]` on all
numeric data elements, hash strings, and raw JSON displays.
