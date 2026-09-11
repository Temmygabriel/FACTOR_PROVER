#!/usr/bin/env bash
# Local verification harness.
#
# Production builds compile src/*.ts -> dist/*.js with tsc, so the `.js`
# import specifiers in the source are correct there. But we verify locally by
# running the TypeScript directly through Node's type stripping (no local
# `npm install` / `tsc` — the dev machine is memory-constrained), and Node's
# strip-only mode does not rewrite `./x.js` to `./x.ts`.
#
# So: mirror src/ and config/ into _scratch/ with specifiers rewritten. This
# directory is disposable. Never edit files in _scratch/ — edit src/ and re-run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

rm -rf _scratch
mkdir -p _scratch
cp -r src config _scratch/

# data/ is mirrored too, because src/data/frozen.ts resolves the store relative
# to its own file (`<here>/../../data/frozen`). In the production layout that is
# apps/agent/data/frozen; from _scratch/src/data/ it would be
# _scratch/data/frozen, which does not exist — so without this the frozen store
# silently reports "no manifest" and every test runs on the live-data path
# while appearing to test the frozen one.
if [ -d data ]; then
  cp -r data _scratch/
fi

# ./foo.js  ->  ./foo.ts   (import/export specifiers only, relative paths)
find _scratch -name '*.ts' -print0 | while IFS= read -r -d '' f; do
  sed -i -E "s|(from '(\.\.?/[^']*))\.js'|\1.ts'|g" "$f"
  sed -i -E "s|(import\('(\.\.?/[^']*))\.js'\)|\1.ts')|g" "$f"
done

# Put the hand-written package stubs back.
#
# src/index.ts imports `express` and `cors`, which do not exist on this machine
# (no npm install). _stubs/ holds minimal stand-ins for exactly the surface the
# code uses — see the header of _stubs/node_modules/express/index.js for what
# that stub does and does not prove.
#
# This step exists because `rm -rf _scratch` above also deletes the stubs, since
# they live under _scratch/node_modules. Without it, every regen leaves the route
# smoke test failing with "Cannot find module 'express'" — a failure that has
# nothing to do with the code under test, which is the worst kind of red.
if [ -d _stubs/node_modules ]; then
  cp -r _stubs/node_modules _scratch/
else
  echo "note: _stubs/node_modules is missing — the route smoke test needs it" >&2
  echo "      (recreate it, or restore from a previous _scratch/node_modules)" >&2
fi

echo "scratch rebuilt -> apps/agent/_scratch"
