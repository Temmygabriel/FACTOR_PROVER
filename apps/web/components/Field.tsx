/**
 * Label-and-value rows, and the one place the layouts agree on how a number is
 * presented: mono, right-aligned, with the label in sentence case to its left.
 *
 * Every panel that reports a figure uses these, so a value cannot appear larger,
 * bolder or in a different tone on one screen than on another. That consistency
 * is doing real work in this product: if a killed entry's p-value were rendered
 * more quietly than a promoted one's, the interface would have editorialised
 * without anyone deciding to.
 */

import type { ReactNode } from 'react';
import { Term } from './Term';

export interface FieldRowProps {
  label: string;
  value: ReactNode;
  /** Plain-language explanation, shown on hover. */
  tip?: string;
  /** Tailwind text colour class for the value. Defaults to ink. */
  tone?: string;
  /** Use mono (default) or the sans face for prose values. */
  mono?: boolean;
}

export function FieldRow({
  label,
  value,
  tip,
  tone = 'text-ink',
  mono = true,
}: FieldRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-rule py-1.5 last:border-b-0">
      <dt className="text-label text-ink-light">
        {tip ? <Term tip={tip}>{label}</Term> : label}
      </dt>
      <dd className={`text-right text-label ${tone} ${mono ? 'font-mono' : 'font-sans'}`}>
        {value}
      </dd>
    </div>
  );
}

/** A `<dl>` with no internal rules of its own; the rows carry them. */
export function FieldList({ children }: { children: ReactNode }) {
  return <dl className="flex flex-col">{children}</dl>;
}
