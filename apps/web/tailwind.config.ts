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
      // One token, added deliberately and no more.
      //
      // The reconfiguration brief (§27) permits a 4px radius on INTERACTIVE
      // CONTROLS only. The reason is affordance rather than fashion: a filled
      // button with hard 0px corners reads as a label, and a reader who cannot
      // tell a button from a heading has lost the only control on the page.
      //
      // Cards and panels stay square — `sm` is not applied to them anywhere. The
      // scale is still REPLACED rather than extended, so `rounded-md` and
      // `rounded-lg` continue not to exist and cannot creep back in.
      sm: '4px',
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

        // The reconfiguration brief's scale (§25). ADDED, never renamed: the
        // four sizes above are used across two dozen components, and renaming
        // them would be a very large diff that changes no pixel.
        //
        // `hero` is the only size this large and §25 caps a screen at ONE
        // hero-scale block — the cap is the point, because a page where
        // everything shouts has no hierarchy at all.
        //
        // `metric` is mono and exists so the numbers on a verdict line align as
        // a column rather than as a sentence.
        body: ['14px', { lineHeight: '21px' }],
        'body-lg': ['17px', { lineHeight: '26px' }],
        h3: ['16px', { lineHeight: '21px' }],
        h2: ['22px', { lineHeight: '26px' }],
        h1: ['32px', { lineHeight: '37px' }],
        hero: ['52px', { lineHeight: '55px' }],
        'hero-lg': ['60px', { lineHeight: '61px' }],
        metric: ['24px', { lineHeight: '24px' }],
      },
    },
  },
  plugins: [],
};

export default config;
