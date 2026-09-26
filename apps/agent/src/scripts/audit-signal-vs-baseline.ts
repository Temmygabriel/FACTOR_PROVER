/**
 * DIAGNOSTIC (not part of the protocol, writes no log).
 *
 * The v1.1 preregistration predicted that for `btc_spot_return -> BTCUSDT` the
 * signal and the engine's naive baseline are the same number, so
 * `|IC| == |baseline_IC|` by algebra. The v1.1 sweep showed that holds for only
 * some of those candidates. This script finds out which premise was wrong by
 * measuring the two series directly instead of arguing from the source.
 *
 * Usage: node --experimental-strip-types --import <tshook> diag-baseline.ts <entry-ish>
 */

import { runBacktest } from '../backtest/engine.js';
import { buildPriceSeries, fetchCandles, indexByTs } from '../backtest/data.js';
import { loadGatePolicyFile, partitionWindow } from '../config.js';
import type { FactorHypothesis } from '../types.js';

const MINUTE_MS = 60_000;

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

const CASES: Array<{ tag: string; lb: number; fwd: number; op: 'gt' | 'lt'; thr: number }> = [
  { tag: 'E-0162 lb=60  gt 0.25 fwd=30 (NOT equal in the sweep)', lb: 60, fwd: 30, op: 'gt', thr: 0.25 },
  { tag: 'E-0165 lb=30  gt 0.25 fwd=30 (equal in the sweep)', lb: 30, fwd: 30, op: 'gt', thr: 0.25 },
  { tag: 'E-0198 lb=60  lt -0.25 fwd=30 (baseline_not_beaten)', lb: 60, fwd: 30, op: 'lt', thr: -0.25 },
];

async function main(): Promise<void> {
  const policy = loadGatePolicyFile('config/gate_policy.v1.1.json').data;
  const win = partitionWindow('DISCOVERY');

  for (const c of CASES) {
    const hypothesis = {
      hypothesis_id: `H-DIAG-${c.lb}-${c.fwd}-${c.op}`,
      session_id: 'S-DIAG',
      proposed_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      signal: 'btc_spot_return',
      condition: { operator: c.op, threshold: c.thr, lookback_minutes: c.lb },
      target: 'BTCUSDT',
      direction: c.op === 'gt' ? 'positive' : 'negative',
      forward_return_minutes: c.fwd,
      experiment_family: 'momentum_to_pair',
    } as unknown as FactorHypothesis;

    const outcome = await runBacktest({ hypothesis, partition: 'DISCOVERY', policy });
    const obs = outcome.observations;

    // The engine's own target series, fetched exactly as the engine fetches it.
    const candles = await fetchCandles('BTCUSDT', win.startMs, win.endMs, {
      partition: 'DISCOVERY',
    });
    const series = buildPriceSeries('BTCUSDT', candles);
    const idx = indexByTs(series);

    let nullBaseline = 0;
    let mismatched = 0;
    let maxDiff = 0;
    const alignedBase: number[] = [];
    const compactedBase: number[] = [];

    for (const o of obs) {
      const i = idx.get(o.timestamp);
      const j = idx.get(o.timestamp - c.lb * MINUTE_MS);
      if (i === undefined || j === undefined) {
        nullBaseline++;
        continue;
      }
      const a = series.close[j]!;
      const b = series.close[i]!;
      const base = ((b - a) / a) * 100;
      compactedBase.push(base);
      alignedBase.push(base);
      const diff = Math.abs(base - o.signal_value);
      if (diff > 1e-9) mismatched++;
      if (diff > maxDiff) maxDiff = diff;
    }

    const ys = obs.map((o) => o.target_return);
    const k = Math.min(compactedBase.length, ys.length);
    const compactedIc = pearson(compactedBase.slice(0, k), ys.slice(0, k));

    console.log(`\n=== ${c.tag} ===`);
    console.log(`  observations                : ${obs.length}`);
    console.log(`  baseline NULL (t-lb missing): ${nullBaseline}`);
    console.log(`  signal != trailing return   : ${mismatched} of ${alignedBase.length} (max |diff| ${maxDiff.toExponential(3)})`);
    console.log(`  logged ic                   : ${outcome.result.ic.toFixed(6)}`);
    console.log(`  logged baseline_ic          : ${outcome.result.baseline_ic.toFixed(6)}`);
    console.log(`  recomputed compacted baseline_ic : ${compactedIc.toFixed(6)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
