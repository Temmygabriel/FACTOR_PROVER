/**
 * AUDIT of the v1.0 record (writes no log, changes nothing).
 *
 * The same misalignment found in `engine.ts:334-338` applies to every entry the
 * engine has ever produced, including the 201 published v1.0 entries and the one
 * PROMOTE among them. rToken coverage is far sparser than BTCUSDT's (2-8% on
 * weekends), so a missing `t - lookback` candle is MORE likely here, not less.
 *
 * This re-runs every computable v1.0 entry and reports whether the logged
 * `baseline_ic` matches the correctly-aligned one, and whether the promoted
 * entry H-0006 would still have beaten its baseline.
 *
 * Usage: node --experimental-strip-types --import <tshook> audit-v1-baseline.ts
 */

import { readFileSync } from 'node:fs';
import { runBacktest } from '../backtest/engine.js';
import { buildPriceSeries, fetchCandles, indexByTs } from '../backtest/data.js';
import { loadGatePolicy, partitionWindow } from '../config.js';
import type { FactorHypothesis } from '../types.js';
import type { PriceSeries } from '../backtest/data.js';

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
  const policy = loadGatePolicy().data;
  const win = partitionWindow('DISCOVERY');
  const rows = readFileSync('logs/decisions.jsonl', 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as {
      entry_id: string;
      hypothesis_id: string;
      hypothesis?: FactorHypothesis;
      ic: number;
      baseline_ic: number;
      n_obs: number;
      gate_decision: string;
      gate_reason: string;
    });

  // One target series per symbol, built exactly as the engine builds it.
  const seriesCache = new Map<string, { series: PriceSeries; idx: Map<number, number> }>();
  async function seriesFor(symbol: string) {
    const hit = seriesCache.get(symbol);
    if (hit) return hit;
    const candles = await fetchCandles(symbol, win.startMs, win.endMs, { partition: 'DISCOVERY' });
    const series = buildPriceSeries(symbol, candles);
    const built = { series, idx: indexByTs(series) };
    seriesCache.set(symbol, built);
    return built;
  }

  let degenerate = 0;
  let withNull = 0;
  let flips = 0;
  const flipRows: string[] = [];

  for (const row of rows) {
    if (!row.hypothesis || row.n_obs < policy.min_obs) {
      degenerate++;
      continue;
    }
    const h = row.hypothesis;
    const outcome = await runBacktest({ hypothesis: h, partition: 'DISCOVERY', policy });
    const obs = outcome.observations;
    const lb = h.condition.lookback_minutes;
    const { series, idx } = await seriesFor(h.target);

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
      alignedBase.push(((series.close[i]! - series.close[j]!) / series.close[j]!) * 100);
      alignedY.push(o.target_return);
    }
    if (nulls > 0) withNull++;

    const trueBase = pearson(alignedBase, alignedY);
    const beatLogged = Math.abs(row.ic) >= Math.abs(row.baseline_ic);
    const beatTrue = Math.abs(row.ic) >= Math.abs(trueBase);
    if (beatLogged !== beatTrue) {
      flips++;
      flipRows.push(
        `  ${row.entry_id} ${row.hypothesis_id} ${row.gate_decision}` +
          `  ${h.signal} -> ${h.target} @${lb}m fwd${h.forward_return_minutes}\n` +
          `      nulls ${nulls}  n ${row.n_obs}  |IC| ${Math.abs(row.ic).toFixed(5)}\n` +
          `      logged baseline ${row.baseline_ic.toFixed(5)} -> beat=${beatLogged}` +
          `   |  TRUE ${trueBase.toFixed(5)} -> beat=${beatTrue}`,
      );
    }
  }

  console.log(`v1.0 entries                    : ${rows.length}`);
  console.log(`  degenerate (excluded)         : ${degenerate}`);
  console.log(`  computable                    : ${rows.length - degenerate}`);
  console.log(`  with >=1 null baseline        : ${withNull}`);
  console.log(`BASELINE-CHECK FLIPS            : ${flips}`);
  const promotes = flipRows.filter((r) => r.includes('PROMOTE'));
  console.log(`flips among PROMOTE entries     : ${promotes.length}`);
  if (promotes.length) for (const p of promotes) console.log(p);
  console.log('');
  console.log('all flipped entries:');
  for (const r of flipRows) console.log(r);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
