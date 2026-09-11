/**
 * A technical term with a plain-language explanation attached.
 *
 * The spec's dual vocabulary (§6) puts a plain sentence behind every stat
 * column. That sentence is rendered in two places, deliberately:
 *
 *  - here, as a `title`, so hovering a header gives the definition immediately;
 *  - and as a visible glossary under the tables, because a tooltip is invisible
 *    in a screenshot, in a video frame, and to a reader who does not hover. The
 *    explanation is a judging feature, so it cannot live only in a hover state.
 *
 * The dotted underline is a hint that something is attached; it is not
 * decoration. Keyboard users get the same text through the glossary.
 */

import type { ReactNode } from 'react';

export function Term({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <span
      title={tip}
      className="cursor-help underline decoration-dotted decoration-rule underline-offset-4"
    >
      {children}
    </span>
  );
}

/**
 * The always-visible half of the dual vocabulary. Sentence case, plain
 * sentences, no jargon in the definition itself.
 */
export function Glossary({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2">
      {items.map(([term, meaning]) => (
        <div key={term}>
          <dt className="text-label text-ink">{term}</dt>
          <dd className="text-caption text-ink-light">{meaning}</dd>
        </div>
      ))}
    </dl>
  );
}
