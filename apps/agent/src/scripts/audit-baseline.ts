/**
 * AUDIT (writes no log, changes nothing).
 *
 * `engine.ts:334-338` builds `baselineSignals` by SKIPPING observations whose
 * trailing return is null, then pairs `baselineSignals.slice(0,k)` with
 * `ys.slice(0,k)` — where `ys` is the FULL observation list. One null therefore
 * shifts every later baseline value one position early: the baseline correlation
 * is computed against the wrong forward returns.
 *
 * This script re-runs every hypothesis in the v1.1 record and asks the only
 * question that matters for the integrity of the record: DID THE BUG CHANGE ANY
 * VERDICT? It reports the miss rate, and lists every entry whose baseline check
 * flips.
 *
 * Usage: node --experimental-strip-types --import <tshook> audit-baseline.ts
 */

import { readFileSync } from 'node:fs';
import { runBacktest } from '../backtest/engine.js';
import { buildPriceSeries, fetchCandles, indexByTs } from '../backtest/data.js';
import { loadGatePolicyFile, partitionWindow } from '../config.js';
import type { FactorHypothesis } from '../types.js';

const MINUTE_MS = 60_000;

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
  const policy = loadGatePolicyFile('config/gate_policy.v1.1.json').data;
  const win = partitionWindow('DISCOVERY');
  const rows = readFileSync('logs/v1.1.jsonl', 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { entry_id: string; hypothesis: FactorHypothesis; ic: number; baseline_ic: number; n_obs: number; gate_reason: string });

  // The target series is the same for every hypothesis here, so fetch it once.
  const candles = await fetchCandles('BTCUSDT', win.startMs, win.endMs, { partition: 'DISCOVERY' });
  const series = buildPriceSeries('BTCUSDT', candles);
  const idx = indexByTs(series);

  let withNull = 0;
  let worstShift = 0;
  let flips = 0;
  let degenerate = 0;
  const flipRows: string[] = [];
  const nullHistogram = new Map<number, number>();

  for (const row of rows) {
    // Below min_obs the engine returns early with emptyResult(): ic and
    // baseline_ic are both 0 because nothing was computed. Comparing two
    // uncomputed zeros says nothing about the bug, so these are counted
    // separately rather than reported as flips.
    if (row.n_obs < policy.min_obs) {
      degenerate++;
      continue;
    }

    const h = row.hypothesis;
    const outcome = await runBacktest({ hypothesis: h, partition: 'DISCOVERY', policy });
    const obs = outcome.observations;
    const lb = h.condition.lookback_minutes;

    const alignedBase: number[] = [];
    const alignedY: number[] = [];
    let nulls = 0;

    for (const o of obs) {
      const i = idx.get(o.timestamp);
      const j = idx.get(o.timestamp - lb * MINUTE_MS);
      if (i === undefined || j === undefined) {
        nulls++;
        continue;
      }
      const a = series.close[j]!;
      const b = series.close[i]!;
      alignedBase.push(((b - a) / a) * 100);
      alignedY.push(o.target_return);
    }

    if (nulls > 0) {
      withNull++;
      nullHistogram.set(nulls, (nullHistogram.get(nulls) ?? 0) + 1);
      if (nulls > worstShift) worstShift = nulls;
    }

    const trueBase = pearson(alignedBase, alignedY);
    const loggedBase = row.baseline_ic;

    // The preregistered check: does the hypothesis's |IC| beat |baseline_IC|?
    const beatLogged = Math.abs(row.ic) >= Math.abs(loggedBase);
    const beatTrue = Math.abs(row.ic) >= Math.abs(trueBase);

    if (beatLogged !== beatTrue) {
      flips++;
      flipRows.push(
        `  ${row.entry_id}  ${h.signal} ${h.condition.operator} ${h.condition.threshold} @${lb}m -> ${h.forward_return_minutes}m\n` +
          `      nulls ${nulls}  n ${row.n_obs}  |IC| ${Math.abs(row.ic).toFixed(5)}\n` +
          `      logged baseline ${loggedBase.toFixed(5)} -> beat=${beatLogged}   (reason: ${row.gate_reason})\n` +
          `      TRUE   baseline ${trueBase.toFixed(5)} -> beat=${beatTrue}`,
      );
    }
  }

  console.log(`entries audited                    : ${rows.length}`);
  console.log(`  degenerate (n < min_obs, excluded): ${degenerate}`);
  console.log(`  computable entries               : ${rows.length - degenerate}`);
  console.log(`entries with >=1 null baseline     : ${withNull}`);
  console.log(`largest null count in any entry    : ${worstShift}`);
  console.log(`null-count histogram               : ${JSON.stringify([...nullHistogram.entries()].sort((a, b) => a[0] - b[0]))}`);
  console.log(`BASELINE-CHECK VERDICT FLIPS       : ${flips}`);
  if (flipRows.length) {
    console.log('\nflipped entries:');
    for (const r of flipRows) console.log(r);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
