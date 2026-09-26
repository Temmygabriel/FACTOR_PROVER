/**
 * AUDIT (writes no log, changes nothing).
 *
 * Reports the correctly-aligned baseline IC for E-0006 / H-0006 — the single
 * PROMOTE in the published v1.0 record — so that the record's one promotion can
 * be stated with the corrected number rather than the misaligned one.
 *
 * Usage: node --experimental-strip-types --import <tshook> audit-e0006.ts
 */

import { readFileSync } from 'node:fs';
import { runBacktest } from '../backtest/engine.js';
import { buildPriceSeries, fetchCandles, indexByTs } from '../backtest/data.js';
import { loadGatePolicy, partitionWindow } from '../config.js';
import type { FactorHypothesis } from '../types.js';

const MIN = 60_000;

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
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

async function main(): Promise<void> {
  const rows = readFileSync('logs/decisions.jsonl', 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const e6 = rows.find((r) => r.entry_id === 'E-0006') as Record<string, unknown>;
  const h = e6.hypothesis as FactorHypothesis;

  const policy = loadGatePolicy().data;
  const win = partitionWindow('DISCOVERY');
  const out = await runBacktest({ hypothesis: h, partition: 'DISCOVERY', policy });

  const candles = await fetchCandles(h.target, win.startMs, win.endMs, { partition: 'DISCOVERY' });
  const series = buildPriceSeries(h.target, candles);
  const idx = indexByTs(series);

  const ab: number[] = [];
  const ay: number[] = [];
  let nulls = 0;
  for (const o of out.observations) {
    const i = idx.get(o.timestamp);
    const j = idx.get(o.timestamp - h.condition.lookback_minutes * MIN);
    if (i === undefined || j === undefined) {
      nulls++;
      continue;
    }
    ab.push(((series.close[i]! - series.close[j]!) / series.close[j]!) * 100);
    ay.push(o.target_return);
  }

  const logged = e6.baseline_ic as number;
  const truth = pearson(ab, ay);
  console.log(`E-0006  ${String(e6.hypothesis_id)}  ${h.signal} -> ${h.target}`);
  console.log(`  observations            : ${out.observations.length}`);
  console.log(`  null baselines          : ${nulls}`);
  console.log(`  logged baseline_ic      : ${logged.toFixed(6)}`);
  console.log(`  TRUE aligned baseline_ic: ${truth.toFixed(6)}`);
  console.log(`  ic                      : ${out.result.ic.toFixed(6)}`);
  console.log(`  beats logged baseline   : ${Math.abs(out.result.ic) >= Math.abs(logged)}`);
  console.log(`  beats TRUE  baseline    : ${Math.abs(out.result.ic) >= Math.abs(truth)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
