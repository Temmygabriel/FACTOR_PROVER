# Design system

This file is the source of truth for the `apps/web` interface. It exists because the
reconfiguration brief asked for one (§21), and because a rule that lives only in a
document gets broken by the next edit — so wherever possible the rule below is
enforced in `tailwind.config.ts` or `app/globals.css` rather than left to discipline.

It describes what the code does today, not what it should aspire to. If this file and
the code disagree, the code is what a reader sees; fix whichever is wrong.

---

## 1. The one rule everything else serves

The product's claim is that its record can be checked rather than believed. So the
interface has one job above all others: **never make a number look more certain than it
is.** Every convention below is downstream of that. Where a choice was available
between a design that looks stronger and one that is harder to misread, the harder-to-
misread one was taken, and the reasoning is recorded here so it is not undone later by
someone who only sees the uglier option.

---

## 2. Colour

Colour carries **meaning**, never decoration. There is no accent colour for its own
sake. If a colour appears on the screen, it is saying something, and a reader can learn
the vocabulary in about ten seconds.

| Token | Hex | Means | Where |
|---|---|---|---|
| `paper` | `#F5F3EE` | The page. | `body` |
| `surface` | `#EDEAE3` | A region set apart from the page — a panel, a strip. Never a hover state. | Panels |
| `ink` | `#1A1A18` | Primary text and rules that must be seen. | Body copy |
| `ink-light` | `#6B6B66` | Secondary text, labels, units, timestamps. | Captions |
| `rule` | `#D4D0C8` | Every divider. Grouping is done with 1px lines. | Borders |
| `promoted` | `#2D6A4F` | A hypothesis that cleared every preregistered check. | Verdict only |
| `killed` | `#8B1A1A` | A hypothesis that did not. | Verdict only |
| `retired` | `#4A4A42` | Withdrawn without being refuted. | Verdict only |
| `amber` | `#C17D3C` | Work in progress, and only that — the active pipeline stage, the running dot. | Live state |

Two rules that are not obvious and should not be "tidied":

**PROMOTED and KILLED carry identical weight.** Same size, same treatment, no icon that
celebrates one. Kills outnumber promotions 200 to 1 in the real record; a design that
made the promotion visually louder would be styling the data into a misleading shape.
`lib/verdict.ts` (`VERDICT_TONE`) is where this lives.

**Links are underlined, never coloured.** Colour in this product means a verdict or the
sign of a number. A third meaning would dilute both.

---

## 3. Type

Two families, loaded through `next/font/google` (self-hosted at build, so no
render-blocking CDN request and no late-swap layout shift):

- **Inter** — interface. Variable, so 400–700 are all available.
- **IBM Plex Mono** — anything numeric, hash-like or machine-readable. Loaded at 400 and
  500 only; **500 is the key-metric weight** and nothing heavier exists, because mono at
  600+ stops reading as a measurement and starts reading as a code block.

Every mono element gets `font-variant-numeric: tabular-nums` (`.font-mono` in
`globals.css`), so digits align in a column instead of shimmying.

The scale is fixed. A screen cannot invent a size.

| Class | Size / line-height | Use |
|---|---|---|
| `text-caption` | 11 / 16 | Labels, units, footnotes, the API host |
| `text-label` | 13 / 20 | Body default, table cells |
| `text-heading` | 14 / 20 | Panel titles |
| `text-body` | 14 / 21 | Body copy in prose contexts |
| `text-body-lg` | 17 / 26 | The one explanatory paragraph under the hero |
| `text-h3` | 16 / 21 | Sub-headings |
| `text-h2` | 22 / 26 | Section headings, the verdict stamp's neighbours |
| `text-h1` | 32 / 37 | Page titles |
| `text-stamp` | 28 / 32 | The verdict stamp (pre-existing; kept) |
| `text-metric` | 24 / 24 | Key numbers on a verdict line, mono |
| `text-hero` | 52 / 55 | The homepage headline |
| `text-hero-lg` | 60 / 61 | The same, at `lg` and above |

`hero` and `hero-lg` are the only sizes this large, and **a screen carries at most one
hero-scale block** (brief §25). The cap is the point: a page on which everything shouts
has no hierarchy at all.

The four sizes marked pre-existing (`caption`, `label`, `heading`, `stamp`) are used
across roughly two dozen components. They were **not renamed** during the
reconfiguration — a rename would have been a very large diff that changed no pixel.

---

## 4. Spacing and layout

A 4px rhythm. Tailwind's default spacing scale is untouched, so `p-4` is 16px and `gap-6`
is 24px.

- Content column: `max-w-[1280px]`, `px-8` at desktop.
- Prose is capped at **`max-w-[80ch]`**. Line length matters more than the column width;
  a paragraph running the full 1280px is unreadable regardless of how good the grid is.
- A panel is `border border-rule bg-paper` (or `bg-surface` when it must separate from
  the page). Grouping is 1px rules, never shadow.
- **No elevation model.** `boxShadow` is replaced with `none` in the config, so
  `shadow-md` and friends do not exist. This is enforced, not requested.
- Layout stacks responsively at `md` (768px). There is no separate mobile product,
  and no mobile gate: the shell renders one layout at every width. What actually
  stacks is the nav bar (which wraps to two lines below `md`), every `grid-cols-1`
  container, the pipeline's connectors, and the frame's gutters (`px-4` below `md`,
  `px-8` above). See §10 for the one table that does not.

---

## 5. Borders and radius

`borderRadius` is **replaced**, not extended, in `tailwind.config.ts`. Only two values
exist:

- `rounded-none` (0px) — **everything**: panels, cards, inputs, the verdict stamp, buttons
  at rest.
- `rounded-sm` (4px) — **interactive controls only**. A filled button with hard corners
  reads as a label; a reader who cannot tell a button from a heading has lost the only
  control on the page. This is the entire justification for the token, and it is the
  only radius that may be applied to something a person clicks.
- `rounded-full` — the loop-status dot. It is the only circle in the product.

`rounded-md` and `rounded-lg` do not exist. This is deliberate; do not add them.

---

## 6. Icons

`lucide-react`, 1px stroke, `size={16}` inline with text and `size={20}` when standing
alone. Colour is inherited — an icon is never the only thing carrying a meaning, and it
is never the only thing carrying colour.

The mapping, as actually used in the components:

| Meaning | Icon | Where |
|---|---|---|
| Propose (pipeline stage 1) | `Lightbulb` | `ProcessPipeline` |
| Measure (stage 2) | `Database` | `ProcessPipeline`, `TrustSection` |
| Test (stage 3) | `FlaskConical` | `ProcessPipeline` |
| Gate (stage 4) | `ShieldCheck` | `ProcessPipeline` |
| Verdict (stage 5) | `Gavel` | `ProcessPipeline` |
| Fixed rules | `LockKeyhole` | `TrustSection` |
| Tamper-evident record | `FileCheck` | `TrustSection` |
| Forward / continue | `ArrowRight` | `ProductHero`, `ProcessPipeline` |

Not yet used but reserved, and to be checked before the first import: `Link2` for a
chain link, `ChevronDown` for a disclosure, `ExternalLink`, `Play`, `Square`, `Check`,
`X`, `Minus`.

### Verified, not assumed

Every name above was checked against `dist/lucide-react.d.ts` in the installed
version (**1.47.0**), not against memory or the brief. That check earned its keep
immediately: the brief's §40 specifies `FileCheck2` for the tamper-evident record, and
**`FileCheck2` does not exist in 1.47.0.** The `*2` numbered variants were removed in
lucide's 1.0 rename. Importing it fails the build, so the brief's icon is implemented as
`FileCheck`.

The same rename removed the old suffixed family (`CheckCircle` → `CircleCheck`,
`AlertTriangle` → `TriangleAlert`, `LineChart` → `ChartLine`). Anything in that family
must be checked the same way.

**How to check a name**, without installing anything:

```bash
curl -s https://unpkg.com/lucide-react@1.47.0/dist/lucide-react.d.ts -o /tmp/lucide.d.ts
grep -nE "^declare const IconName:" /tmp/lucide.d.ts
```

A hit on `declare const …: LucideIcon` means the export exists. A miss means the build
will fail. Note that v1.47.0 ships **one bundled entry point** — `dist/esm/lucide-react.mjs`
— and has no per-icon module paths, so `lucide-react/icons/gavel` does not resolve.
Always import from the package root.

`Minus` is the marker for "not applicable / no evidence", and it matters that one
exists: `lib/verdict.ts` (`hasGateEvidence()`) returns false for `AUTO-KILLED` and
`CIRCUIT BREAK`, and those rows must render an absent marker rather than a `0`. A zero
in a metrics column reads as a measured result. It is not one.

---

## 7. Motion

Two animations, and no more (brief §30.1 — one primary animation per screen):

- **`.stamp-in`** — the verdict stamp arriving. 180ms, `scale(0.94) → 1`, ease-out, no
  bounce. Once per verdict.
- **`.loop-pulse`** — the amber dot beside the running indicator. 2s, opacity only. The
  only ambient animation, and it stops when the element unmounts.

Nothing ambient was added during the reconfiguration. `stamp-in` was softened from
`scale(0.85)` to `scale(0.94)`: it is the largest element on the test screen, and at
0.85 its arrival read as the page jumping rather than as a mark being pressed on.

`prefers-reduced-motion: reduce` sets animation and transition durations to `0.01ms`
globally (`*`, not a list of class names). Durations are shortened rather than set to
`none` so that `transitionend` listeners still fire — a component waiting on one to
reveal content would otherwise hang forever for exactly the users the rule protects.
`scroll-behavior` is included; a smooth scroll is motion too.

---

## 8. Accessibility

- **Focus is visible, always.** Interactive elements use `outline` utilities, not
  `boxShadow` — which is why replacing the shadow scale cost no accessibility.
- **Colour is never the only signal.** A verdict is a word plus a colour; a check is a
  word plus an icon.
- **Contrast.** `ink` on `paper` is ~15:1. `ink-light` on `paper` is ~5.3:1, which clears
  AA for body text; it is not used below `text-caption`. `promoted` and `killed` are used
  at `text-heading` or larger, where the AA large-text threshold applies with margin.
- **Numbers are never an image**, and every metric has its unit adjacent as text.
- No information is carried by motion, hover, or position alone.

---

## 9. What this system deliberately does not have

Recorded so that their absence reads as a decision rather than an oversight:

- No dark mode. The palette has one mode and it is declared twice in `globals.css`
  (`:root` and `html`) specifically to stop a dark-mode browser inverting a field into a
  dark control on a paper page.
- No elevation, no shadows, no cards floating over other cards.
- No accent colour, no gradients, no illustration.
- No toast notifications. State that matters is rendered where the state is.
- No animation library. Two keyframes in one file.
- No component library. The components are in `components/` and are readable in one
  sitting.

---

## 10. Known limitations

Recorded because the alternative is a reader discovering them and concluding the
design was careless rather than constrained.

**The verdict stamp's check table does not reflow.** It is a four-column grid
(`8.5rem  5rem  1fr  4.5rem`, `VerdictStamp.tsx`) whose minimum width is about
324px — wider than a panel's content box on a 360px phone. It scrolls inside its
own box (`overflow-x-auto`) rather than pushing the page sideways, which is the
lesser failure but is still a failure. It is **not** fixed here because the same
grid is the load-bearing comparison on the Results and Evidence screens, and
turning it into stacked cards would separate each value from the bar it is being
compared against — the one relationship the table exists to show. On the live
test screen it now sits behind the "Technical evidence" disclosure, so it is off
the default phone view there.

**There is no dark mode**, deliberately (§9), so a reader on a dark-mode device
gets a light page. `:root` and `html` both declare the palette to stop a browser
inverting form controls into dark boxes on a paper page.

