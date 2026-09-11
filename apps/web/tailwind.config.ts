import type { Config } from 'tailwindcss';

/**
 * Tokens are named after the design spec's palette table (§3) so that a class
 * name reads as its meaning rather than as a hex value. The hex values below
 * are the spec's, unchanged.
 *
 * Two of the spec's prohibitions are enforced here rather than by discipline,
 * because a rule that only lives in a document gets broken by the next edit:
 *
 *  - `borderRadius` is REPLACED, not extended, so `rounded-lg` and friends do
 *    not exist. `none` and `full` remain: `full` because the loop-status dot is
 *    a circle, and it is the only circle in the product.
 *  - `boxShadow` is replaced with `none` only. The `.next` app has no elevation
 *    model; grouping is done with 1px rules, per spec §5.
 *
 * Focus rings do not depend on `boxShadow` here — interactive elements use
 * outline utilities (see components/Button.tsx) — so replacing the shadow scale
 * costs no accessibility.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    borderRadius: {
      none: '0px',
      full: '9999px',
    },
    boxShadow: {
      none: 'none',
    },
    extend: {
      colors: {
        paper: '#F5F3EE',
        surface: '#EDEAE3',
        ink: '#1A1A18',
        'ink-light': '#6B6B66',
        rule: '#D4D0C8',
        promoted: '#2D6A4F',
        killed: '#8B1A1A',
        retired: '#4A4A42',
        amber: '#C17D3C',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        // The spec's scale (§4), fixed so a screen cannot invent a size.
        caption: ['11px', { lineHeight: '16px' }],
        label: ['13px', { lineHeight: '20px' }],
        heading: ['14px', { lineHeight: '20px' }],
        stamp: ['28px', { lineHeight: '32px' }],
      },
    },
  },
  plugins: [],
};

export default config;
