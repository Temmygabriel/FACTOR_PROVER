/**
 * Rebuild data/frozen/manifest.json from the .gz files on disk.
 *
 * WHY THIS EXISTS. The manifest is DERIVED data: it records which files exist,
 * each file's sha256, its row count, and the window it covers. Every one of
 * those facts is recoverable exactly from the files plus config/partitions.json,
 * so a manifest can always be reconstructed without re-fetching anything.
 *
 * That matters because the manifest is load-bearing and its failure mode is
 * silent. `loadFrozenManifest()` is what makes `frozenEntryFor()` return an
 * entry; when an entry is missing the backtest does not error, it falls through
 * to fetching live data instead — so a damaged manifest produces verdicts whose
 * recorded `dataset_sha256` describes a different dataset than the one that was
 * actually read.
 *
 * It is also an INTEGRITY CHECK, which is the more common reason to run it:
 * every file's sha256 is recomputed from its bytes, every row is checked to lie
 * inside the window its kind is allowed to cover, and timestamps are checked to
 * be strictly increasing. Run it before committing the frozen dataset.
 *
 *   node --experimental-strip-types scripts/rebuild-manifest.ts
 *   node --experimental-strip-types scripts/rebuild-manifest.ts --check
 *
 * `--check` verifies and reports without writing. Exits non-zero on any
 * inconsistency, so it is usable as a CI gate.
 *
 * THE WINDOW CHECK IS KIND-AWARE, AND THE END IS THE HALF THAT MATTERS
 * -------------------------------------------------------------------
 * Both kinds may start before their partition — candles by the warm-up lead-in,
 * funding by one settlement interval — and neither may contain anything after
 * the partition end. The end bound is the one enforcing "a DISCOVERY file
 * contains only DISCOVERY"; the start bound is a sanity check that the file did
 * not overshoot its permitted lead-in. See src/data/freezeWindow.ts.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported with an explicit `.ts` specifier: this script runs under Node's
// strip-only type stripping, which does not rewrite `./x.js` to `./x.ts`. The
// module is dependency-free so it can be imported from here at all. Importing
// it — rather than restating the lead-in numbers — is what guarantees the
// verifier and the freezer agree on the window.
import { leadInForKind, type FrozenKind } from '../src/data/freezeWindow.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FROZEN_DIR = join(ROOT, 'data', 'frozen');
const MANIFEST_PATH = join(FROZEN_DIR, 'manifest.json');

const PARTITIONS = ['DISCOVERY', 'VALIDATION', 'LOCKED_TEST'] as const;
type PartitionName = (typeof PARTITIONS)[number];

interface Entry {
  symbol: string;
  partition: string;
  kind: FrozenKind;
  startMs: number;
  endMs: number;
  rows: number;
  sha256: string;
  file: string;
  fetched_at: string;
  source: string;
  [k: string]: unknown;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Parse `SYMBOL__PARTITION.json.gz` or `SYMBOL__PARTITION.funding.json.gz`.
 *
 * Returns null when the name does not fit. The symbol group is `[A-Z0-9]+`,
 * which deliberately does NOT admit `__` or `.`, so a malformed name cannot
 * half-match and be silently accepted as a different symbol.
 */
function parseFileName(
  file: string,
): { symbol: string; partition: string; kind: FrozenKind } | null {
  const m = /^([A-Z0-9]+)__([A-Z_]+?)(\.funding)?\.json\.gz$/.exec(file);
  if (!m) return null;
  return { symbol: m[1]!, partition: m[2]!, kind: m[3] ? 'funding' : 'candles' };
}

/** Stable manifest order: symbol, then partition, then kind. */
function compareEntries(a: Entry, b: Entry): number {
  if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
  if (a.partition !== b.partition) return a.partition.localeCompare(b.partition);
  return a.kind.localeCompare(b.kind);
}

/** Identity of a manifest row. Kind is part of it: two files share a pair. */
function entryKey(e: { symbol: string; partition: string; kind?: FrozenKind }): string {
  return `${e.symbol}|${e.partition}|${e.kind === 'funding' ? 'funding' : 'candles'}`;
}

/**
 * The kind a COMMITTED entry declares, tolerant of a missing or unknown value.
 *
 * A manifest written before `kind` was recorded, or hand-edited, should be
 * reported as differing rather than crashing the check — this runs over a file
 * it is specifically trying to prove is intact.
 */
function entryKindOf(e: Entry): FrozenKind {
  return e.kind === 'funding' || e.kind === 'candles' ? e.kind : 'candles';
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');

  const partitionsCfg = readJson<Record<string, { start?: string; end?: string }>>(
    join(ROOT, 'config', 'partitions.json'),
  );
  const cfgSymbols =
    (partitionsCfg as { symbols?: { reference?: string[]; targets?: string[] } }).symbols ?? {};
  const referenceSymbols = cfgSymbols.reference ?? [];
  const allSymbols = [...referenceSymbols, ...(cfgSymbols.targets ?? [])];

  // Existing entries are preserved when their sha256 still matches, so a real
  // fetch timestamp survives a rebuild instead of being replaced by a file
  // mtime that records when the file was copied rather than when it was fetched.
  const prior = new Map<string, Entry>();
  if (existsSync(MANIFEST_PATH)) {
    try {
      const parsed = readJson<{ entries?: Entry[] }>(MANIFEST_PATH);
      for (const e of parsed.entries ?? []) prior.set(entryKey(e), e);
    } catch {
      console.log('existing manifest is unreadable; rebuilding from scratch');
    }
  }

  const files = readdirSync(FROZEN_DIR)
    .filter((f) => f.endsWith('.json.gz'))
    .sort();

  console.log(`scanning ${files.length} frozen file(s) in data/frozen/\n`);

  const entries: Entry[] = [];
  const problems: string[] = [];
  let totalRows = 0;
  let candleRows = 0;
  let fundingRows = 0;

  for (const file of files) {
    const parsedName = parseFileName(file);
    if (!parsedName) {
      problems.push(`${file}: filename is not SYMBOL__PARTITION[.funding].json.gz`);
      continue;
    }
    const { symbol, partition, kind } = parsedName;

    if (!(PARTITIONS as readonly string[]).includes(partition)) {
      problems.push(`${file}: unknown partition '${partition}'`);
      continue;
    }
    const p = partitionsCfg[partition];
    if (!p?.start || !p?.end) {
      problems.push(`${file}: partition '${partition}' has no window in partitions.json`);
      continue;
    }
    const partitionStartMs = Date.parse(p.start);
    const partitionEndMs = Date.parse(p.end);
    // The lower bound this kind is allowed to reach back to. The END is not
    // adjusted for either kind: nothing after the partition end is ever legal.
    const lowerBound = partitionStartMs - leadInForKind(kind);

    const path = join(FROZEN_DIR, file);
    const bytes = readFileSync(path);
    const sha256 = 'sha256:' + createHash('sha256').update(bytes).digest('hex');

    let rows: Array<[number, number]>;
    try {
      rows = JSON.parse(gunzipSync(bytes).toString('utf8')) as Array<[number, number]>;
    } catch (err) {
      problems.push(`${file}: not valid gzipped JSON (${err instanceof Error ? err.message : err})`);
      continue;
    }

    if (!Array.isArray(rows)) {
      problems.push(`${file}: payload is not an array`);
      continue;
    }
    if (rows.length === 0) {
      problems.push(`${file}: payload is EMPTY — a frozen file must contain data`);
      continue;
    }

    // Row-shape and window checks. A row AFTER the partition end is the one
    // failure that would undermine the protocol's central claim, so it is
    // reported separately from a mere lead-in overshoot and named as a leak.
    let afterEnd = 0;
    let beforeLeadIn = 0;
    let notAscending = 0;
    let malformed = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!Array.isArray(r) || r.length < 2 || typeof r[0] !== 'number' || typeof r[1] !== 'number') {
        malformed++;
        continue;
      }
      if (r[0] > partitionEndMs) afterEnd++;
      else if (r[0] < lowerBound) beforeLeadIn++;
      if (i > 0 && Array.isArray(rows[i - 1]) && r[0] <= (rows[i - 1] as number[])[0]!) notAscending++;
    }

    if (malformed > 0) problems.push(`${file}: ${malformed} malformed row(s)`);
    if (afterEnd > 0) {
      problems.push(
        `${file}: ${afterEnd} row(s) fall AFTER the ${partition} end ${p.end} — this file ` +
          `LEAKS HELD-OUT DATA`,
      );
    }
    if (beforeLeadIn > 0) {
      problems.push(
        `${file}: ${beforeLeadIn} row(s) predate the permitted ${kind} lead-in ` +
          `(${new Date(lowerBound).toISOString()}) for ${partition}`,
      );
    }
    if (notAscending > 0) {
      problems.push(`${file}: timestamps not strictly ascending (${notAscending} place(s))`);
    }

    // Kind-specific expectations that a leak check alone would not catch.
    if (kind === 'funding') {
      if (!referenceSymbols.includes(symbol)) {
        problems.push(
          `${file}: funding is frozen only for reference symbols ` +
            `(${referenceSymbols.join(', ')}); '${symbol}' is not one`,
        );
      }
      // A funding file must carry enough settlements to cover its lead-in, or
      // the step function has no rate in force at the first grid minute.
      const span = rows[rows.length - 1]![0] - rows[0]![0];
      if (span < 24 * 60 * 60 * 1000) {
        problems.push(
          `${file}: funding spans only ${(span / 3_600_000).toFixed(1)}h; a partition needs ` +
            `far more than that to be usable`,
        );
      }
    }

    const prev = prior.get(entryKey({ symbol, partition, kind }));
    const unchanged = prev && prev.sha256 === sha256;

    entries.push({
      symbol,
      partition,
      kind,
      // Observed row bounds, not the requested window — same rule the freezer
      // writes by, so a rebuild reproduces these fields without re-deriving any
      // window logic.
      startMs: rows[0]![0],
      endMs: rows[rows.length - 1]![0],
      rows: rows.length,
      sha256,
      file,
      fetched_at:
        unchanged && typeof prev.fetched_at === 'string'
          ? prev.fetched_at
          : statSync(path).mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      source:
        unchanged && typeof prev.source === 'string'
          ? prev.source
          : kind === 'funding'
            ? 'bitget:/api/v2/mix/market/history-fund-rate'
            : 'bitget:/api/v2/spot/market/{candles,history-candles}',
    });

    totalRows += rows.length;
    if (kind === 'funding') fundingRows += rows.length;
    else candleRows += rows.length;

    const flag = unchanged ? ' ' : '*';
    console.log(
      `  ${flag} ${symbol.padEnd(11)} ${partition.padEnd(11)} ${kind.padEnd(8)} ` +
        `${String(rows.length).padStart(7)} rows  ` +
        `${(bytes.length / 1024).toFixed(0).padStart(5)} KB  ${sha256.slice(7, 19)}`,
    );
  }

  entries.sort(compareEntries);

  // Expected coverage. Candles for every symbol; funding only for the reference
  // coins, because those are the only funding series any signal reads.
  const missing: string[] = [];
  for (const part of PARTITIONS) {
    for (const s of allSymbols) {
      if (!entries.some((e) => e.symbol === s && e.partition === part && e.kind === 'candles')) {
        missing.push(`${s}__${part}`);
      }
    }
    for (const s of referenceSymbols) {
      if (!entries.some((e) => e.symbol === s && e.partition === part && e.kind === 'funding')) {
        missing.push(`${s}__${part}.funding`);
      }
    }
  }
  if (missing.length > 0) {
    problems.push(`missing ${missing.length} expected file(s): ${missing.join(', ')}`);
  }

  // --- diff against the COMMITTED manifest ---------------------------------
  //
  // Without this block, --check only establishes that the files on disk are
  // internally consistent. It says nothing about whether the committed
  // manifest.json actually DESCRIBES them, and that is the gap with teeth:
  // manifest.json is what every reader resolves a frozen file through, and it is
  // what `dataset_sha256` in every decision-log entry attests to. A drifted
  // manifest — a stale sha256, a wrong row count, an entry for a file that no
  // longer exists, or a file with no entry at all — breaks the provenance claim
  // while this script exits 0 and CI stays green.
  //
  // Demonstrated before it was fixed: editing a single row count in the
  // committed manifest still printed "all files intact" and exited 0.
  //
  // This is also the check that catches the finding-18 failure mode, where files
  // sat on disk with no manifest entry and the backtest silently fell through to
  // the live endpoint while the recorded hash described a smaller dataset.
  for (const e of entries) {
    const c = prior.get(entryKey(e));
    if (!c) {
      problems.push(
        `${e.file}: on disk but ABSENT from the committed manifest. Readers resolve ` +
          `frozen files through the manifest, so this file is invisible: the backtest ` +
          `will silently fall back to the live endpoint while dataset_sha256 describes ` +
          `a smaller dataset.`,
      );
      continue;
    }
    if (c.sha256 !== e.sha256) {
      problems.push(
        `${e.file}: sha256 differs from the committed manifest — the committed record ` +
          `does not describe these bytes (disk ${e.sha256.slice(7, 19)}, ` +
          `manifest ${String(c.sha256).slice(7, 19)})`,
      );
    }
    if (c.rows !== e.rows) {
      problems.push(
        `${e.file}: row count differs from the committed manifest ` +
          `(disk ${e.rows}, manifest ${String(c.rows)})`,
      );
    }
    if (c.startMs !== e.startMs || c.endMs !== e.endMs) {
      problems.push(
        `${e.file}: window differs from the committed manifest — expected ` +
          `${String(c.startMs)}..${String(c.endMs)}, found ${e.startMs}..${e.endMs}`,
      );
    }
    if (entryKindOf(c) !== e.kind) {
      problems.push(
        `${e.file}: kind differs from the committed manifest ` +
          `(disk ${e.kind}, manifest ${entryKindOf(c)})`,
      );
    }
  }
  for (const [key, c] of prior) {
    if (!entries.some((e) => entryKey(e) === key)) {
      problems.push(
        `${c.file ?? key}: present in the committed manifest but has NO file on disk — ` +
          `a stale entry that would make dataset_sha256 attest to data that is not there`,
      );
    }
  }

  const combined =
    'sha256:' +
    createHash('sha256')
      .update(entries.map((e) => `${e.symbol}|${e.partition}|${e.kind}|${e.sha256}`).join('\n'), 'utf8')
      .digest('hex');

  const expectedCount =
    allSymbols.length * PARTITIONS.length + referenceSymbols.length * PARTITIONS.length;
  console.log(
    `\n${entries.length} entries (expected ${expectedCount}) — ` +
      `${candleRows.toLocaleString()} candle rows + ${fundingRows.toLocaleString()} funding rows`,
  );
  console.log(`combined dataset hash: ${combined}`);

  if (problems.length > 0) {
    console.log(`\n${problems.length} PROBLEM(S):`);
    for (const pr of problems) console.log(`  - ${pr}`);
  } else {
    console.log(
      '\nall files intact: hashes recomputed, no row after any partition end, ' +
        'timestamps strictly ascending',
    );
  }

  if (checkOnly) {
    console.log('\n--check: no files written');
    if (problems.length > 0) process.exitCode = 1;
    return;
  }

  const manifest = {
    manifest_version: 'v1.0',
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    manifest_origin: 'rebuilt-from-disk',
    note:
      'Frozen series for every (symbol, partition, kind). CANDLES are 1-minute ' +
      'closes; FUNDING is 8-hourly settlements. Each file covers its partition ' +
      'plus a bounded warm-up lead-in of OLDER data and nothing after the ' +
      'partition end, so reading it cannot reach held-out data. The lead-in is ' +
      'what lets a signal warm up from the committed file instead of the ' +
      'network; see src/data/freezeWindow.ts. sha256 is of the compressed bytes ' +
      'as written. Entries are merged across runs, keyed on (symbol, partition, ' +
      'kind), so a partial --symbols or --kinds fetch never removes another ' +
      'entry from the record. This manifest was regenerated from the files on ' +
      'disk by scripts/rebuild-manifest.ts; every sha256 was recomputed from the ' +
      'file bytes and every row was checked against its partition window.',
    entries,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nwrote manifest.json with ${entries.length} entries`);

  if (problems.length > 0) process.exitCode = 1;
}

await main();
