import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { partitionWindow, type PartitionName } from '../../src/config.js';
import { leadInForKind, type FrozenKind } from '../../src/data/freezeWindow.js';
import {
  __clearFrozenCache,
  __setFrozenManifestForTest,
  frozenDir,
  type FrozenEntry,
  type FrozenManifest,
} from '../../src/data/frozen.js';

export interface FixtureSpec {
  symbol: string;
  partition: PartitionName;
  kind: FrozenKind;
  /** `[timestamp, value]` pairs, written exactly as given — order included. */
  rows: Array<[number, number]>;
  /** Claim a different row count than the file holds, to exercise the mismatch. */
  declaredRows?: number;
  /** Claim a different sha256 than the file hashes to, to exercise the mismatch. */
  declaredSha256?: string;
  /** Claim the file covers a different window than the partition's. */
  declaredStartMs?: number;
  declaredEndMs?: number;
}

export interface InstalledFixtures {
  dir: string;
  entries: FrozenEntry[];
  dispose: () => void;
}

function fileNameFor(spec: FixtureSpec): string {
  return spec.kind === 'funding'
    ? `${spec.symbol}__${spec.partition}.funding.json.gz`
    : `${spec.symbol}__${spec.partition}.json.gz`;
}

/**
 * Install a synthetic frozen store.
 *
 * The store resolves `entry.file` against its own `data/frozen` directory, which
 * a test must not write into. A relative hop out of that directory is what lets
 * a fixture live in the OS temp dir while the store still finds it — and the hop
 * is computed with `path.relative`, so it is correct wherever the temp dir is.
 */
export function installFrozenFixtures(specs: FixtureSpec[]): InstalledFixtures {
  const dir = mkdtempSync(join(tmpdir(), 'fp-frozen-'));

  const entries: FrozenEntry[] = specs.map((spec) => {
    const name = fileNameFor(spec);
    const bytes = gzipSync(Buffer.from(JSON.stringify(spec.rows), 'utf8'));
    writeFileSync(join(dir, name), bytes);

    const window = partitionWindow(spec.partition);
    return {
      symbol: spec.symbol,
      partition: spec.partition,
      kind: spec.kind,
      startMs: spec.declaredStartMs ?? window.startMs - leadInForKind(spec.kind),
      endMs: spec.declaredEndMs ?? window.endMs,
      rows: spec.declaredRows ?? spec.rows.length,
      sha256:
        spec.declaredSha256 ?? 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      file: relative(frozenDir(), join(dir, name)),
      fetched_at: '2026-09-11T00:00:00Z',
      source: 'test-fixture',
    };
  });

  const manifest: FrozenManifest = {
    manifest_version: 'test',
    generated_at: '2026-09-11T00:00:00Z',
    entries,
  };

  __setFrozenManifestForTest(manifest);
  __clearFrozenCache();

  return {
    dir,
    entries,
    dispose: () => {
      __setFrozenManifestForTest(null);
      __clearFrozenCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Install "no frozen store at all", so any read must fall through to the
 * network. Returns the undo, for `afterEach`.
 */
export function installNoFrozenStore(): () => void {
  __setFrozenManifestForTest(null);
  __clearFrozenCache();
  return () => {
    __setFrozenManifestForTest(null);
    __clearFrozenCache();
  };
}
