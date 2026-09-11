/**
 * The deterministic enumerator — the third tier, and the replay guarantee.
 *
 * Two properties are load-bearing:
 *
 *  1. IT IS A PERMUTATION, NOT A SAMPLE. The strided walk must visit every
 *     candidate exactly once before repeating. A stride sharing a factor with the
 *     space size would visit a subset forever, silently and permanently narrowing
 *     the search while still looking busy — so the full-walk test is the one that
 *     matters most here.
 *
 *  2. CONSECUTIVE PROPOSALS MUST DIFFER. The natural nested-loop order puts the
 *     lookback innermost, so its first twenty entries are one family, one signal
 *     and one target — twenty near-identical variants of a single idea. That is
 *     the exact multiple-testing anti-pattern the rest of the system exists to
 *     catch, and it is what finding 19 measured. The stride fixes it, and the
 *     contrast is asserted directly below rather than described.
 */

import { describe, expect, it } from 'vitest';
import {
  enumerateHypothesis,
  enumerableSpace,
  enumerableSpaceNaturalOrder,
} from '../src/llm/deterministic.js';
import { validateProposal } from '../src/schema/validate.js';
import { FAMILY_SIGNALS, RTOKEN_SYMBOLS, type ProposedHypothesis } from '../src/types.js';

const SPACE = enumerableSpace();
const SIZE = SPACE.length;

const distinct = <T,>(xs: readonly T[]): number => new Set(xs).size;
const key = (h: ProposedHypothesis): string => `${h.signal}|${h.target}|${h.experiment_family}`;
const conditionKey = (h: ProposedHypothesis): string =>
  `${h.condition.operator}:${h.condition.threshold}`;

describe('the enumerable space', () => {
  it('holds 2240 candidates', () => {
    // 7 targets x (funding: 2 signals x 5 conditions x 4 windows x 4 lookbacks,
    // momentum: 2 x 5 x 3 x 4, combined: 1 x 5 x 2 x 4) = 7 x 320.
    expect(SIZE).toBe(2240);
  });

  it('breaks down per signal the way the window bounds imply', () => {
    // The per-family window caps are what make the counts differ, so this is the
    // assertion that would catch a bounds edit silently changing the space size —
    // and with it the stride's coprimality.
    const counts = new Map<string, number>();
    for (const h of SPACE) counts.set(h.signal, (counts.get(h.signal) ?? 0) + 1);
    expect(counts.get('btc_funding_rate')).toBe(560);
    expect(counts.get('eth_funding_rate')).toBe(560);
    expect(counts.get('btc_spot_return')).toBe(420);
    expect(counts.get('eth_spot_return')).toBe(420);
    expect(counts.get('btc_funding_x_spot')).toBe(280);
  });

  it('contains every target, for every permitted family/signal pair', () => {
    const pairs = new Set(SPACE.map(key));
    for (const family of Object.keys(FAMILY_SIGNALS) as Array<keyof typeof FAMILY_SIGNALS>) {
      for (const signal of FAMILY_SIGNALS[family]) {
        for (const target of RTOKEN_SYMBOLS) {
          expect(pairs.has(`${signal}|${target}|${family}`)).toBe(true);
        }
      }
    }
    expect(pairs.size).toBe(5 * RTOKEN_SYMBOLS.length);
  });

  it('emits ONLY candidates the validator accepts', () => {
    // The templates are chosen to be valid, but the validator is the single source
    // of truth. An edit to a threshold template that outran the schema would
    // otherwise emit a proposal the loop must then reject — burning an attempt and
    // a slice of the daily budget on a candidate that could never have counted.
    for (const candidate of SPACE) {
      const result = validateProposal(candidate);
      expect(result.ok, `${candidate.signal} ${JSON.stringify(candidate.condition)}`).toBe(true);
    }
  });

  it('is cached, so repeated calls do not rebuild it', () => {
    expect(enumerableSpace()).toBe(SPACE);
  });

  it('returns a COPY from enumerableSpaceNaturalOrder, not the cache itself', () => {
    // A caller that sorted or splices this in place would otherwise corrupt the
    // enumeration for the rest of the process.
    const natural = enumerableSpaceNaturalOrder();
    expect(natural).not.toBe(SPACE);
    expect(natural).toEqual(SPACE);
  });
});

describe('enumerateHypothesis walks the whole space before repeating', () => {
  it('visits all 2240 entries EXACTLY ONCE across a full walk', () => {
    // THE test for the stride. If gcd(stride, 2240) were ever > 1 the walk would
    // cycle through 2240/gcd entries and repeat forever: the fallback tier would
    // still look like it was working, and would propose the same few hypotheses
    // for the rest of the session.
    const seen = new Map<ProposedHypothesis, number>();
    for (let i = 0; i < SIZE; i++) {
      const h = enumerateHypothesis(i);
      seen.set(h, (seen.get(h) ?? 0) + 1);
    }
    expect(seen.size).toBe(SIZE);
    expect(Math.max(...seen.values())).toBe(1);
  });

  it('wraps around after a full walk', () => {
    expect(enumerateHypothesis(SIZE)).toEqual(enumerateHypothesis(0));
    expect(enumerateHypothesis(SIZE + 7)).toEqual(enumerateHypothesis(7));
  });

  it('accepts a negative index and maps it into range', () => {
    // Attempt numbers come from a session counter, and a resumed session can be
    // off by one in either direction; a negative index must not index the array
    // backwards into undefined.
    expect(enumerateHypothesis(-1)).toEqual(enumerateHypothesis(SIZE - 1));
    expect(enumerateHypothesis(-SIZE)).toEqual(enumerateHypothesis(0));
  });

  it('is stable across calls for the same index', () => {
    // The replay claim: an entry generated by this tier can be re-derived from its
    // attempt number alone, with no model in the loop.
    expect(enumerateHypothesis(1234)).toEqual(enumerateHypothesis(1234));
    expect(JSON.stringify(enumerateHypothesis(1234))).toBe(JSON.stringify(enumerateHypothesis(1234)));
  });

  it('pins attempt 0 exactly', () => {
    // A single fully specified candidate, so a change to the iteration ORDER is
    // visible as a diff rather than as a still-passing permutation test.
    expect(enumerateHypothesis(0)).toEqual({
      signal: 'btc_funding_rate',
      condition: { operator: 'gt', threshold: 0.00005, lookback_minutes: 30 },
      target: 'RCOINUSDT',
      direction: 'positive',
      forward_return_minutes: 15,
      experiment_family: 'funding_to_rtoken',
    });
  });

  it('returns the cached object rather than a copy, so callers must not mutate it', () => {
    // Worth knowing rather than asserting as a virtue: every call hands back the
    // SAME object. Nothing in the loop mutates a proposal in place — it is stamped
    // and copied before it is stored — but a future caller that did would rewrite
    // the enumeration for the whole process.
    expect(enumerateHypothesis(0)).toBe(enumerateHypothesis(0));
    expect(enumerateHypothesis(0)).toBe(SPACE[0]);
  });

  it('sets the direction from the operator, not from a separate field', () => {
    // A `gt` condition predicts a positive relationship and a `lt` one a negative
    // one. A candidate whose direction disagreed with its own condition would be
    // testing the opposite of what it says, and nothing downstream re-derives it.
    for (const h of SPACE) {
      expect(h.direction, conditionKey(h)).toBe(h.condition.operator === 'gt' ? 'positive' : 'negative');
    }
  });
});

describe('finding 19 — consecutive proposals must not be near-identical variants', () => {
  it('the NATURAL order really is the anti-pattern it was reported as', () => {
    // The control. Without this, the fix below could be asserted against a straw
    // man: the claim is specifically that the nested loops put the lookback
    // innermost, so the first twenty entries share family, signal AND target.
    const natural = enumerableSpaceNaturalOrder().slice(0, 20);
    expect(distinct(natural.map((h) => h.experiment_family))).toBe(1);
    expect(distinct(natural.map((h) => h.signal))).toBe(1);
    expect(distinct(natural.map((h) => h.target))).toBe(1);
    // Only the two innermost dimensions move, and only within one condition.
    expect(distinct(natural.map((h) => h.condition.lookback_minutes))).toBe(4);
    expect(distinct(natural.map((h) => h.forward_return_minutes))).toBe(4);
    expect(distinct(natural.map(conditionKey))).toBe(2);
  });

  it('the STRIDED walk spreads the same twenty attempts across the whole space', () => {
    // The measured fix. Twenty fallback proposals now name all three families,
    // all five signals, all seven targets and ten distinct conditions, so a
    // model-outage session produces a genuinely diverse family for BH to correct
    // over rather than twenty copies of one idea.
    const strided = Array.from({ length: 20 }, (_, i) => enumerateHypothesis(i));
    expect(distinct(strided.map((h) => h.experiment_family))).toBe(3);
    expect(distinct(strided.map((h) => h.signal))).toBe(5);
    expect(distinct(strided.map((h) => h.target))).toBe(RTOKEN_SYMBOLS.length);
    expect(distinct(strided.map(conditionKey))).toBe(10);
    expect(distinct(strided.map((h) => h.forward_return_minutes))).toBe(4);
  });

  it('does not repeat a signal+target pair within the first twenty attempts', () => {
    // The degeneracy detector counts the last five hypotheses by pair and trips at
    // four of the same. A fallback tier that tripped its own breaker on the first
    // five proposals would make a provider outage permanent.
    const strided = Array.from({ length: 20 }, (_, i) => enumerateHypothesis(i));
    const pairs = strided.map((h) => `${h.signal}|${h.target}`);
    expect(distinct(pairs)).toBe(pairs.length);
  });

  it('spreads the whole walk, not only its opening', () => {
    // A stride that happened to alternate two families would pass the test above
    // while still starving the third. This samples one attempt in ten across the
    // entire 2240-long walk and requires full coverage of the space's shape, so a
    // stride that degenerated into a short cycle would show up here.
    const sample: ProposedHypothesis[] = [];
    for (let i = 0; i < SIZE; i += 10) sample.push(enumerateHypothesis(i));
    expect(sample).toHaveLength(224);
    expect(distinct(sample.map((h) => h.experiment_family))).toBe(3);
    expect(distinct(sample.map((h) => h.signal))).toBe(5);
    expect(distinct(sample.map((h) => h.target))).toBe(RTOKEN_SYMBOLS.length);
    // Every permitted signal/target pair, which is the unit the degeneracy
    // detector counts.
    expect(distinct(sample.map((h) => `${h.signal}|${h.target}`))).toBe(
      5 * RTOKEN_SYMBOLS.length,
    );
  });
});
