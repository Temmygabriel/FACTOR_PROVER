import type { ReactNode } from 'react';

/**
 * A bordered section with a sentence-case header.
 *
 * Every section in the product is one of these, and that is the point: the
 * leaderboard's "Promoted factors (1)" and its "Killed (42)" are the SAME
 * component with the same header size, weight and colour. There is no variant
 * that renders a kills section more quietly than a promotes section, because a
 * variant is exactly where that would happen.
 *
 * Grouping is done with a 1px rule and a background step, never with a shadow or
 * a radius (spec §5, §2).
 */

export interface PanelProps {
  title: string;
  /** Supporting line, mono, right of the title. Counts, ids, timestamps. */
  meta?: ReactNode;
  /** Interactive controls, right of the meta. */
  actions?: ReactNode;
  /** `surface` for stat cards, `paper` for list and table sections. */
  fill?: 'paper' | 'surface';
  /** Drop the body padding when the body is a table that owns its own edges. */
  flush?: boolean;
  children: ReactNode;
  /** One line under the body, for a footnote or a caveat. */
  footnote?: ReactNode;
}

export function Panel({
  title,
  meta,
  actions,
  fill = 'paper',
  flush = false,
  children,
  footnote,
}: PanelProps) {
  return (
    <section
      className={`border border-rule ${fill === 'surface' ? 'bg-surface' : 'bg-paper'} ${
        footnote ? 'pb-3' : ''
      }`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-4 py-2.5">
        <h2 className="text-heading font-semibold text-ink">{title}</h2>
        <div className="flex items-baseline gap-4">
          {meta ? <div className="font-mono text-caption text-ink-light">{meta}</div> : null}
          {actions}
        </div>
      </header>
      <div className={flush ? '' : 'px-4 py-3'}>{children}</div>
      {footnote ? (
        <p className="px-4 pt-2 text-caption text-ink-light">{footnote}</p>
      ) : null}
    </section>
  );
}
