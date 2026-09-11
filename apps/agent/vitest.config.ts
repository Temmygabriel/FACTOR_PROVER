import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Rewrite a relative `./x.js` specifier to `./x.ts` when the TypeScript source
 * is what is actually on disk.
 *
 * WHY THIS IS HERE. src/ is written for `tsc` with `moduleResolution: NodeNext`,
 * so its internal imports say `./foo.js` — correct in dist/, where the compiled
 * file really is `foo.js`. Vite usually resolves that for a TypeScript
 * importer, but letting the whole suite depend on a resolver side-effect is a
 * bad trade: if a Vite release stops doing it, every suite fails with "Failed
 * to resolve import" and the symptom points at the tests rather than at the
 * resolver. `apps/agent/_regen-scratch.sh` exists for exactly this reason on
 * the Node side; this is the Vite-side equivalent, and it is 12 lines.
 *
 * NodeNext is the right setting for this repo and does not remove the need for
 * this plugin: NodeNext *requires* the explicit `.js` in source, so the
 * mismatch between the specifier and the file on disk is permanent, not a
 * workaround for a wrong tsconfig.
 */
function jsSpecifierToTs(): Plugin {
  return {
    name: 'factor-prover:js-specifier-to-ts',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer === undefined || !source.endsWith('.js')) return null;
      if (!source.startsWith('./') && !source.startsWith('../')) return null;
      const asTs = resolve(dirname(importer), source.slice(0, -3) + '.ts');
      return existsSync(asTs) ? asTs : null;
    },
  };
}

export default defineConfig({
  plugins: [jsSpecifierToTs()],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',

    // Every suite is offline by construction: the two network-facing modules
    // (funding history, candle fetch) take their transport from global fetch,
    // which each suite replaces with a stub. Nothing here may reach Bitget.
    // restoreMocks puts the real fetch back between tests so a stub cannot leak
    // into a suite that expects the network to be untouched.
    restoreMocks: true,

    // The retry paths sleep for real (300ms/600ms backoff), and the decision
    // log writes to disk. Generous, not load-bearing.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
