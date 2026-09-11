/**
 * The frozen partition store.
 *
 * Every case here installs its OWN store through the test seam rather than
 * reading the committed dataset. Two reasons: the committed files are 3.5 MB and
 * whose contents are not this suite's business, and a test that reads them
 * cannot state what it is asserting about — it can only assert that whatever is
 * there round-trips.
 *
 * What IS worth asserting is the set of ways a frozen file can be wrong. That is
 * what makes the store trustworthy: it is not enough that it reads correct files
 * without complaint, it must also refuse the files that would invalidate a
 * result.
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __clearFrozenCache,
  __setFrozenManifestForTest,
  entryKind,
  frozenCoverage,
  frozenDatasetHash,
  frozenEntryFor,
  loadFrozenCandles,
  loadFrozenFunding,
  type FrozenEntry,
  type FrozenManifest,
} from '../src/data/frozen.js';
import { CANDLE_LEAD_IN_MS, MINUTE_MS } from '../src/data/freezeWindow.js';
import { partitionWindow } from '../src/config.js';
import { installFrozenFixtures, type InstalledFixtures } from './helpers/frozenStore.js';
import { candle } from './helpers/fixtures.js';

const DISCOVERY = partitionWindow('DISCOVERY');
const BASE = DISCOVERY.startMs + 60 * MINUTE_MS;

let installed: InstalledFixtures | null = null;

afterEach(() => {
  installed?.dispose();
  installed = null;
  __setFrozenManifestForTest(null);
  __clearFrozenCache();
});

/** Three legal candle rows, an hour apart, well inside DISCOVERY. */
const LEGAL_ROWS: Array<[number, number]> = [
  [BASE, 100],
  [BASE + 60 * MINUTE_MS, 101],
  [BASE + 120 * MINUTE_MS, 102],
];

describe('entryKind', () => {
  it('reads an absent kind as candles', () => {
    // Entries written before funding was frozen carry no `kind`, and those files
    // really do hold candles. This default is what keeps the older manifest
    // readable instead of silently making them unfindable.
    const legacy = { symbol: 'BTCUSDT', partition: 'DISCOVERY' } as FrozenEntry;
    expect(entryKind(legacy)).toBe('candles');
  });

  it('passes funding through unchanged', () => {
    expect(entryKind({ kind: 'funding' } as FrozenEntry)).toBe('funding');
    expect(entryKind({ kind: 'candles' } as FrozenEntry)).toBe('candles');
  });
});

describe('frozenEntryFor', () => {
  it('defaults to candles and finds the funding file only when asked for it', () => {
    // BTCUSDT/DISCOVERY legitimately exists as BOTH kinds. Without the kind in
    // the lookup, the funding file would be returned to a caller wanting candles
    // and every price in the backtest would be a funding rate.
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: LEGAL_ROWS },
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'funding',
        rows: [[BASE - 8 * 60 * MINUTE_MS, 0.00003]],
      },
    ]);

    expect(frozenEntryFor('BTCUSDT', 'DISCOVERY')?.kind).toBe('candles');
    expect(frozenEntryFor('BTCUSDT', 'DISCOVERY', 'candles')?.kind).toBe('candles');
    expect(frozenEntryFor('BTCUSDT', 'DISCOVERY', 'funding')?.kind).toBe('funding');
  });

  it('returns null for a pair that was never frozen', () => {
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: LEGAL_ROWS },
    ]);
    expect(frozenEntryFor('ETHUSDT', 'DISCOVERY')).toBeNull();
    expect(frozenEntryFor('BTCUSDT', 'VALIDATION')).toBeNull();
    expect(frozenEntryFor('BTCUSDT', 'DISCOVERY', 'funding')).toBeNull();
  });

  it('returns null when there is no store at all, rather than throwing', () => {
    // The degraded path is deliberate: the store should fall back to the live
    // endpoint loudly, not fail the session.
    __setFrozenManifestForTest(null);
    __clearFrozenCache();
    expect(frozenEntryFor('BTCUSDT', 'DISCOVERY')).toBeNull();
    expect(loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toBeNull();
  });
});

describe('loadFrozenCandles — the legal path', () => {
  it('returns the stored rows as candles with the close carried into OHLC', () => {
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: LEGAL_ROWS },
    ]);

    const loaded = loadFrozenCandles('BTCUSDT', 'DISCOVERY');
    expect(loaded).not.toBeNull();
    expect(loaded!.candles).toEqual([
      { ...candle(BASE, 100) },
      { ...candle(BASE + 60 * MINUTE_MS, 101) },
      { ...candle(BASE + 120 * MINUTE_MS, 102) },
    ]);
    expect(loaded!.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(loaded!.entry.rows).toBe(3);
  });

  it('accepts a row exactly ON each bound, because both bounds are inclusive', () => {
    // Off-by-one here is not cosmetic: the first row of a candle file sits at
    // exactly `partitionStart - leadIn`, and refusing it would reject every file
    // the freezer writes.
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: [
          [DISCOVERY.startMs - CANDLE_LEAD_IN_MS, 99],
          [DISCOVERY.endMs, 103],
        ],
      },
    ]);
    const loaded = loadFrozenCandles('BTCUSDT', 'DISCOVERY');
    expect(loaded!.candles).toHaveLength(2);
  });

  it('caches the inflated series, so a second read is the same object', () => {
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: LEGAL_ROWS },
    ]);
    const first = loadFrozenCandles('BTCUSDT', 'DISCOVERY');
    const second = loadFrozenCandles('BTCUSDT', 'DISCOVERY');
    expect(second).toBe(first);
  });
});

describe('loadFrozenCandles — a row AFTER the partition end', () => {
  it('throws, naming the row and the consequence', () => {
    // This is the failure that invalidates the protocol: held-out data sitting
    // inside a DISCOVERY-era file. It is checked before the lead-in bound so it
    // is reported as what it is.
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: [...LEGAL_ROWS, [DISCOVERY.endMs + 1, 104]],
      },
    ]);

    expect(() => loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toThrow(
      /contains 1 row\(s\) AFTER the partition end/,
    );
    expect(() => loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toThrow(/held-out data/);
  });

  it('throws for a row a whole day past the end', () => {
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: [[DISCOVERY.endMs + 24 * 60 * MINUTE_MS, 200]],
      },
    ]);
    expect(() => loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toThrow(/AFTER the partition end/);
  });

  it('applies to funding files too, not only candles', () => {
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'funding',
        rows: [[DISCOVERY.endMs + 1, 0.0001]],
      },
    ]);
    expect(() => loadFrozenFunding('BTCUSDT', 'DISCOVERY')).toThrow(/Frozen funding file/);
  });
});

describe('loadFrozenCandles — a row before the permitted lead-in', () => {
  it('throws, and says the file and the window rules disagree', () => {
    // Not a leak — older data was never held out — but it means the freezer and
    // the reader are working from different definitions of the window, which is
    // how the leak class of bug starts.
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: [[DISCOVERY.startMs - CANDLE_LEAD_IN_MS - 1, 50]],
      },
    ]);

    expect(() => loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toThrow(
      /more than 300 minute\(s\) before the partition start/,
    );
    expect(() => loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toThrow(/rebuild it with scripts\/prefetch\.ts/);
  });

  it('uses the FUNDING lead-in for funding files, not the candle one', () => {
    // The two kinds carry different lead-ins (8 hours vs 5 hours). A row 6 hours
    // before the partition start is legal for funding and illegal for candles —
    // and the check has to be reading the kind to tell them apart.
    const sixHours = 6 * 60 * MINUTE_MS;
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'funding',
        rows: [[DISCOVERY.startMs - sixHours, 0.00003]],
      },
    ]);
    expect(() => loadFrozenFunding('BTCUSDT', 'DISCOVERY')).not.toThrow();

    installed.dispose();
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: [[DISCOVERY.startMs - sixHours, 100]],
      },
    ]);
    expect(() => loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toThrow(
      /more than 300 minute\(s\) before the partition start/,
    );
  });
});

describe('loadFrozenCandles — integrity mismatches', () => {
  it('throws when the bytes on disk do not match the recorded sha256', () => {
    // An edit after freezing invalidates every result derived from the file, so
    // this fails loudly rather than returning tampered data.
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: LEGAL_ROWS,
        declaredSha256: 'sha256:' + 'a'.repeat(64),
      },
    ]);
    expect(() => loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toThrow(/hash mismatch/);
    expect(() => loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toThrow(/not comparable to the preregistration/);
  });

  it('throws when the manifest records a different row count than the file holds', () => {
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: LEGAL_ROWS,
        declaredRows: 99,
      },
    ]);
    expect(() => loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toThrow(
      /holds 3 rows but the manifest records 99/,
    );
  });

  it('checks the hash BEFORE the window, so a tampered file is reported as tampered', () => {
    // Order matters for diagnosis: a file that is both tampered with and out of
    // window should be reported as tampered, because that is the more serious
    // finding and the one that invalidates everything downstream.
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        rows: [[DISCOVERY.endMs + 1, 104]],
        declaredSha256: 'sha256:' + 'b'.repeat(64),
      },
    ]);
    expect(() => loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toThrow(/hash mismatch/);
  });
});

describe('loadFrozenCandles — a file that is not there', () => {
  it('returns null when the entry exists but the file is missing', () => {
    // A manifest pointing at a file that is not on disk is a deployment problem
    // the store cannot fix, so it degrades to the live endpoint like any other
    // miss rather than throwing inside the loop.
    const entries: FrozenEntry[] = [
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'candles',
        startMs: DISCOVERY.startMs - CANDLE_LEAD_IN_MS,
        endMs: DISCOVERY.endMs,
        rows: 3,
        sha256: 'sha256:' + 'c'.repeat(64),
        file: 'does-not-exist-anywhere.json.gz',
        fetched_at: '2026-09-11T00:00:00Z',
        source: 'test',
      },
    ];
    __setFrozenManifestForTest({
      manifest_version: 'test',
      generated_at: '2026-09-11T00:00:00Z',
      entries,
    } satisfies FrozenManifest);
    __clearFrozenCache();
    expect(loadFrozenCandles('BTCUSDT', 'DISCOVERY')).toBeNull();
  });
});

describe('loadFrozenFunding', () => {
  it('returns records in the order the file stores them, with both fields intact', () => {
    const t0 = DISCOVERY.startMs;
    installed = installFrozenFixtures([
      {
        symbol: 'BTCUSDT',
        partition: 'DISCOVERY',
        kind: 'funding',
        rows: [
          [t0 - 8 * 60 * MINUTE_MS, 0.00002],
          [t0, 0.00005],
          [t0 + 8 * 60 * MINUTE_MS, 0.00003],
        ],
      },
    ]);

    const loaded = loadFrozenFunding('BTCUSDT', 'DISCOVERY');
    expect(loaded).not.toBeNull();
    expect(loaded!.records).toEqual([
      { fundingTime: t0 - 8 * 60 * MINUTE_MS, fundingRate: 0.00002 },
      { fundingTime: t0, fundingRate: 0.00005 },
      { fundingTime: t0 + 8 * 60 * MINUTE_MS, fundingRate: 0.00003 },
    ]);
    expect(loaded!.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('returns null rather than the candle file when only candles were frozen', () => {
    // Returning the candle entry here would make a funding step function out of
    // prices — a silently wrong series that looks like a successful load.
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: LEGAL_ROWS },
    ]);
    expect(loadFrozenFunding('BTCUSDT', 'DISCOVERY')).toBeNull();
  });

  it('caches independently of the candle file for the same pair', () => {
    const t0 = DISCOVERY.startMs;
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: LEGAL_ROWS },
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'funding', rows: [[t0, 0.00007]] },
    ]);

    const candles = loadFrozenCandles('BTCUSDT', 'DISCOVERY');
    const funding = loadFrozenFunding('BTCUSDT', 'DISCOVERY');
    expect(candles!.entry.kind).toBe('candles');
    expect(funding!.entry.kind).toBe('funding');
    // Sharing one cache slot would make the second read return the first kind.
    expect(loadFrozenCandles('BTCUSDT', 'DISCOVERY')!.entry.kind).toBe('candles');
    expect(loadFrozenFunding('BTCUSDT', 'DISCOVERY')!.entry.kind).toBe('funding');
  });
});

describe('frozenDatasetHash', () => {
  function entry(over: Partial<FrozenEntry>): FrozenEntry {
    return {
      symbol: 'BTCUSDT',
      partition: 'DISCOVERY',
      startMs: DISCOVERY.startMs,
      endMs: DISCOVERY.endMs,
      rows: 1,
      sha256: 'sha256:' + '1'.repeat(64),
      file: 'x.json.gz',
      fetched_at: '2026-09-11T00:00:00Z',
      source: 'test',
      ...over,
    };
  }

  function install(entries: FrozenEntry[]): void {
    __setFrozenManifestForTest({
      manifest_version: 'test',
      generated_at: '2026-09-11T00:00:00Z',
      entries,
    });
    __clearFrozenCache();
  }

  it('is null with no store and with an empty store', () => {
    // Null is the honest value: it means no frozen dataset backed the session,
    // and the log records that rather than a placeholder hash.
    __setFrozenManifestForTest(null);
    expect(frozenDatasetHash()).toBeNull();
    install([]);
    expect(frozenDatasetHash()).toBeNull();
  });

  it('changes when any file’s sha256 changes', () => {
    install([entry({ sha256: 'sha256:' + '1'.repeat(64) })]);
    const before = frozenDatasetHash();
    install([entry({ sha256: 'sha256:' + '2'.repeat(64) })]);
    expect(frozenDatasetHash()).not.toBe(before);
  });

  it('does NOT depend on the order entries appear in the manifest', () => {
    // The kind is part of the SORT KEY for exactly this reason. Two files can
    // share a (symbol, partition) pair — BTCUSDT/DISCOVERY is both candles and
    // funding — and without the kind in the key their relative order would be
    // whatever the manifest happened to list, making the hash depend on array
    // order rather than on content.
    const a = entry({ kind: 'candles', sha256: 'sha256:' + 'a'.repeat(64) });
    const b = entry({ kind: 'funding', sha256: 'sha256:' + 'b'.repeat(64) });

    install([a, b]);
    const forward = frozenDatasetHash();
    install([b, a]);
    expect(frozenDatasetHash()).toBe(forward);

    // And the ordering is by kind, so 'candles' sorts before 'funding'.
    expect(forward).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('depends on the KIND, not only on the sha256', () => {
    // Two entries with the same symbol, partition and sha256 but different kinds
    // must hash differently. Without the kind in the canonical string both lines
    // would be identical and the two manifests would be indistinguishable.
    const sha = 'sha256:' + 'd'.repeat(64);
    install([entry({ kind: 'candles', sha256: sha }), entry({ kind: 'funding', sha256: sha })]);
    const mixed = frozenDatasetHash();

    install([entry({ kind: 'candles', sha256: sha }), entry({ kind: 'candles', sha256: sha })]);
    expect(frozenDatasetHash()).not.toBe(mixed);
  });

  it('treats an absent kind as candles, so a legacy manifest still hashes', () => {
    const sha = 'sha256:' + 'e'.repeat(64);
    const legacy = entry({ sha256: sha });
    delete (legacy as { kind?: unknown }).kind;
    install([legacy]);
    const legacyHash = frozenDatasetHash();

    install([entry({ kind: 'candles', sha256: sha })]);
    expect(frozenDatasetHash()).toBe(legacyHash);
  });

  it('is a plain sha256 over a newline-joined canonical string', () => {
    // Pinned so a change to the canonical form is a deliberate, visible edit
    // rather than a silent redefinition of every recorded dataset_sha256.
    install([entry({ kind: 'candles', sha256: 'sha256:' + 'f'.repeat(64) })]);
    const canonical = `BTCUSDT|DISCOVERY|candles|sha256:${'f'.repeat(64)}`;
    expect(frozenDatasetHash()).toBe(
      'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex'),
    );
  });
});

describe('frozenCoverage', () => {
  it('reports a complete store when every needed pair and kind is present', () => {
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: LEGAL_ROWS },
      { symbol: 'RCOINUSDT', partition: 'DISCOVERY', kind: 'candles', rows: LEGAL_ROWS },
    ]);
    const coverage = frozenCoverage({
      symbols: ['BTCUSDT', 'RCOINUSDT'],
      partitions: ['DISCOVERY'],
    });
    expect(coverage.complete).toBe(true);
    expect(coverage.missing).toEqual([]);
    expect(coverage.present).toContain('BTCUSDT|DISCOVERY|candles');
  });

  it('reports the missing FUNDING leg even when the candle leg is present', () => {
    // This is the case that turns "we have a dataset hash" into "the hash
    // describes the data behind these verdicts". A session with frozen candles
    // and live funding still writes a dataset_sha256; coverage is how the status
    // endpoint can say the provenance is partial.
    installed = installFrozenFixtures([
      { symbol: 'BTCUSDT', partition: 'DISCOVERY', kind: 'candles', rows: LEGAL_ROWS },
    ]);
    const coverage = frozenCoverage({ symbols: ['BTCUSDT'], partitions: ['DISCOVERY'] });
    expect(coverage.complete).toBe(false);
    expect(coverage.present).toEqual(['BTCUSDT|DISCOVERY|candles']);
    expect(coverage.missing).toEqual(['BTCUSDT|DISCOVERY|funding']);
  });

  it('reports every pair missing when there is no store', () => {
    __setFrozenManifestForTest(null);
    __clearFrozenCache();
    const coverage = frozenCoverage({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      partitions: ['DISCOVERY', 'VALIDATION'],
    });
    expect(coverage.complete).toBe(false);
    expect(coverage.present).toEqual([]);
    expect(coverage.missing).toHaveLength(8);
  });
});
