'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react';

/**
 * One button. Square, 1px border, no shadow, no radius, no colour change on
 * hover beyond the border and the ink.
 *
 * The disabled state is grey ink rather than a faded fill, so a control that
 * cannot be pressed still reads as text a person can read — the pre-flight
 * checklist's disabled [Start loop] has to be legible to be a checklist.
 *
 * `destructive` exists for the circuit-breaker reset only. It is not red: red is
 * spent on the KILLED verdict and the circuit-break state, and a third use would
 * make the first two less certain. It takes the heavier border instead.
 */

type Variant = 'default' | 'primary' | 'destructive';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const VARIANT: Record<Variant, string> = {
  default: 'border-rule text-ink hover:border-ink',
  primary: 'border-ink bg-ink text-paper hover:bg-[#000000]',
  destructive: 'border-ink text-ink hover:bg-surface',
};

export function Button({ variant = 'default', className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`inline-flex items-center border px-3 py-1.5 text-label ${VARIANT[variant]} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:border-rule disabled:text-ink-light disabled:hover:border-rule ${className}`}
      {...rest}
    />
  );
}

/**
 * A single-line text input, styled to match. Used only where a value must be
 * attributable to a person — the circuit-breaker reset's `requested_by`.
 */
export function TextInput({
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`border border-rule bg-paper px-2 py-1 text-label text-ink placeholder:text-ink-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${className}`}
      {...rest}
    />
  );
}
