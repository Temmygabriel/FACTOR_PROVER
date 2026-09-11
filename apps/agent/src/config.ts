/**
 * Config loading and the read-only enforcement that makes the protocol work.
 *
 * partitions.json and gate_policy.json are preregistered artifacts. They are
 * written once, committed to the repository, and hashed at load. If either file
 * changes mid-session the recorded hashes stop matching, which is the signal
 * that a session's results are no longer comparable to its preregistration.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertLeadInBounded } from './data/freezeWindow.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo config dir. Resolves from dist/ or src/ alike. */
function configDir(): string {
  // dist/config.js -> ../config ; src/config.ts -> ../config
  return join(HERE, '..', 'config');
}

export interface Partition {
  start: string;
  end: string;
  trading_days: number;
  share: number;
  access: string;
}

export interface PartitionsConfig {
  partitions_version: string;
  locked_at: string;
  DISCOVERY: Partition;
  VALIDATION: Partition;
  LOCKED_TEST: Partition;
  data_limits: {
    max_candles_per_request: number;
    funding_interval_hours: number;
  };
  symbols: { reference: string[]; targets: string[] };
  [k: string]: unknown;
}

export interface GatePolicy {
  policy_version: string;
  locked_at: string;
  fdr_level: number;
  min_ic: number;
  min_t_stat: number;
  min_obs: number;
  require_baseline_beat: boolean;
  sampling: 'non_overlapping' | 'overlapping';
  families_enabled: string[];
  circuit_breaker: {
    max_hypotheses_per_day: number;
    max_promotes_per_day: number;
    max_paper_orders_per_day: number;
    duplicate_signal_target_window: number;
    duplicate_signal_target_threshold: number;
    max_log_entries_in_context: number;
    max_backtest_duration_ms: number;
    max_consecutive_llm_failures: number;
  };
  execution_guard: {
    max_open_positions: number;
    max_order_usdt: number;
    price_sanity_band_pct: number;
    require_paper_trading_flag: boolean;
    require_confirm: boolean;
  };
  [k: string]: unknown;
}

/** Read a file as raw bytes so the hash reflects exactly what is committed. */
function readRaw(path: string): { text: string; sha256: string } {
  const buf = readFileSync(path);
  return {
    text: buf.toString('utf8'),
    sha256: 'sha256:' + createHash('sha256').update(buf).digest('hex'),
  };
}

export interface LoadedConfig<T> {
  data: T;
  /** sha256 of the exact committed bytes. Recorded per session. */
  sha256: string;
  path: string;
}

let partitionsCache: LoadedConfig<PartitionsConfig> | null = null;
let policyCache: LoadedConfig<GatePolicy> | null = null;

export function loadPartitions(): LoadedConfig<PartitionsConfig> {
  if (partitionsCache) return partitionsCache;
  const path = join(configDir(), 'partitions.json');
  const { text, sha256 } = readRaw(path);
  partitionsCache = { data: JSON.parse(text) as PartitionsConfig, sha256, path };
  return partitionsCache;
}

export function loadGatePolicy(): LoadedConfig<GatePolicy> {
  if (policyCache) return policyCache;
  const path = join(configDir(), 'gate_policy.json');
  const { text, sha256 } = readRaw(path);
  policyCache = { data: JSON.parse(text) as GatePolicy, sha256, path };
  return policyCache;
}

/** Test seam — lets unit tests swap in a policy without touching disk. */
export function __setPolicyForTest(cfg: LoadedConfig<GatePolicy> | null): void {
  policyCache = cfg;
}

export function __setPartitionsForTest(cfg: LoadedConfig<PartitionsConfig> | null): void {
  partitionsCache = cfg;
}

// ---------------------------------------------------------------------------
// Partition enforcement
// ---------------------------------------------------------------------------

export type PartitionName = 'DISCOVERY' | 'VALIDATION' | 'LOCKED_TEST';

export class PartitionViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartitionViolation';
  }
}

export interface Window {
  startMs: number;
  endMs: number;
}

export function partitionWindow(name: PartitionName): Window {
  const p = loadPartitions().data[name];
  return { startMs: Date.parse(p.start), endMs: Date.parse(p.end) };
}

/**
 * Assert a requested window lies entirely inside the named partition.
 *
 * This is the mechanism behind Rule 1. The backtest engine calls it with
 * DISCOVERY; the gate calls it with VALIDATION. LOCKED_TEST is never requested
 * by the loop at all.
 *
 * THE BOUNDS ARE NOT SYMMETRIC, AND THAT IS DELIBERATE.
 *
 * `endMs` is absolute: a window that reaches past the partition end is always
 * refused, with no way to ask for an exception. Held-out data lives at the END
 * of a partition's timeline, so the end is the bound that carries the protocol.
 *
 * `startMs` may be preceded by up to `leadInMs` of WARM-UP. A signal evaluated
 * at the partition's first minutes needs prices from just before it — a
 * 240-minute spot return looks back 241 minutes, a funding step function needs
 * the settlement in force at that minute. Refusing those reads outright would
 * push them onto the live network, and then the committed dataset would attest
 * to numbers it did not produce.
 *
 * Relaxing the START is safe because data OLDER than a partition has never been
 * held out: DISCOVERY is the earliest window there is, and VALIDATION's lead-in
 * reaches only into DISCOVERY, which has already been seen. Callers pass the
 * lead-in their frozen file actually carries (`leadInForKind`); the ceiling in
 * freezeWindow.ts stops the parameter becoming a general exemption.
 */
export function assertWithinPartition(name: PartitionName, window: Window, leadInMs = 0): void {
  assertLeadInBounded(leadInMs, `assertWithinPartition(${name})`);
  const p = partitionWindow(name);
  if (window.endMs > p.endMs || window.startMs < p.startMs - leadInMs) {
    throw new PartitionViolation(
      `Window ${new Date(window.startMs).toISOString()} .. ${new Date(window.endMs).toISOString()} ` +
        `falls outside the ${name} partition ` +
        `(${new Date(p.startMs).toISOString()} .. ${new Date(p.endMs).toISOString()}` +
        (leadInMs > 0 ? `, plus a ${leadInMs / 60_000}-minute warm-up lead-in` : '') +
        `). ` +
        (window.endMs > p.endMs
          ? `The partition END is absolute and is never relaxed. `
          : `The lead-in is capped and does not extend this far back. `) +
        `Partitions are frozen; this request is refused.`,
    );
  }
}

/**
 * Guard for LOCKED_TEST. The loop must never be able to reach held-out data,
 * so any call that would read it has to pass an explicit, deliberate flag.
 */
export function assertLockedTestAccessAllowed(reason: string, allow: boolean): void {
  if (!allow) {
    throw new PartitionViolation(
      `Refused access to LOCKED_TEST (${reason}). This partition is inaccessible to the ` +
        `loop and may be read only once, manually, for the final out-of-sample demo pass.`,
    );
  }
}
