/**
 * Execution drill — replay the event → decision → execution leg over a
 * committed decision log.
 *
 * WHY THIS EXISTS. The session loop already does the whole flow: a promotion
 * builds an order intent, the Execution Guard runs its five checks, and the
 * ledger records a fill. But the ledger is in-memory and the process exits, so
 * the execution leg of the committed session left no artifact at all. The
 * decisions log has 201 entries and not one of them says what happened after a
 * promotion. This produces that missing record from the committed log, using
 * the SAME guard and the SAME intent builder the loop uses.
 *
 * WHAT IT IS, AND WHAT IT IS NOT. It is a reconstruction, and the header of the
 * output file says so. The session that produced the log ran on 2026-09-13; the
 * prices below are real Bitget 1-minute closes from that day, fetched now, not
 * values the original run retained. The guard, the policy, the thresholds and
 * the intent builder are the production ones, imported rather than copied, so
 * the drill cannot quietly demonstrate a flow that differs from the one that
 * runs.
 *
 * THE ONE CHECK THAT IS VACUOUS HERE, STATED UP FRONT. CHECK 4 compares the
 * order's entry price against a freshly fetched price. There is no live price
 * for a date six days gone, so the drill feeds the same historical close to
 * both sides and the check passes at 0.000% by construction. In a live session
 * it is nearly vacuous for a different reason — the loop prices the order and
 * the guard re-prices it milliseconds later. Either way, a passing CHECK 4 here
 * means "the two prices agreed", not "the price was sane".
 *
 * Usage:
 *   tsx src/scripts/replay-execution.ts [--log logs/decisions.jsonl]
 *                                       [--out logs/paper.jsonl]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchCandles } from '../backtest/data.js';
import { loadGatePolicy } from '../config.js';
import { ExecutionGuard, orderIntentFor } from '../execution/guard.js';

// ---------------------------------------------------------------------------
// The committed log, as this script reads it
// ---------------------------------------------------------------------------

interface LogEntry {
  entry_id: string;
  hypothesis_id: string;
  timestamp_utc: string;
  gate_decision: 'PROMOTE' | 'KILL';
  gate_reason: string | null;
  gate_detail: string | null;
  hypothesis: {
    target: string;
    direction: 'positive' | 'negative';
    forward_return_minutes: number;
  };
}

function readLog(path: string): LogEntry[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LogEntry);
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

interface SourcedPrice {
  price: number;
  candle_ts: string;
  candles_in_window: number;
}

/**
 * The last real Bitget close at or before `tsMs`.
 *
 * `fetchCandles` is called WITHOUT a partition, which is deliberate: a
 * partition would assert the window lies inside a frozen range, and the
 * promotion happened after the frozen data ends, so there is nothing to assert
 * against. Omitting it routes to the public API and reads the real market.
 *
 * Returns null rather than a nearest-available price when the window is empty,
 * because "the nearest price we could find" and "the price at the time" are
 * different facts and only one of them is an entry price.
 */
async function priceAtOrBefore(symbol: string, tsMs: number): Promise<SourcedPrice | null> {
  const candles = await fetchCandles(symbol, tsMs - 6 * 3_600_000, tsMs);
  const usable = candles.filter((c) => c.ts <= tsMs).sort((a, b) => a.ts - b.ts);
  const last = usable[usable.length - 1];
  if (!last) return null;
  return {
    price: last.close,
    candle_ts: new Date(last.ts).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    candles_in_window: usable.length,
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

interface OrderRecord {
  kind: 'order';
  entry_id: string;
  hypothesis_id: string;
  factor_id: string;
  at: string;
  symbol: string;
  side: 'buy' | 'sell';
  notional_usdt: number;
  entry_price: number;
  price_source: string;
  allowed: boolean;
  refused_at: string | null;
  refused_reason: string | null;
  detail: string;
  checks: Array<{ check: string; passed: boolean; detail: string }>;
  fill: { placed: boolean; mode: 'simulated' | 'agent_hub' };
}

interface CloseRecord {
  kind: 'close';
  entry_id: string;
  hypothesis_id: string;
  factor_id: string;
  at: string;
  reason: string;
  exit_price: number;
  price_source: string;
}

type Record_ = OrderRecord | CloseRecord;

// ---------------------------------------------------------------------------
// The drill
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const argOf = (name: string, fallback: string): string => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const logPath = argOf('--log', 'logs/decisions.jsonl');
  const outPath = argOf('--out', 'logs/paper.jsonl');

  if (!existsSync(logPath)) {
    process.stderr.write(`[drill] no decision log at ${logPath}\n`);
    return 1;
  }

  const entries = readLog(logPath);
  const policy = loadGatePolicy().data;
  const notional = policy.execution_guard.max_order_usdt;

  const records: Record_[] = [];
  const open = new Map<string, { factor_id: string; entry: LogEntry }>();
  let nextFactor = 1;
  let promotions = 0;
  let orders = 0;
  let closes = 0;

  // The row currently being replayed. The guard's price source reads this
  // rather than a fixed instant, because a close at E-0008 has to be priced at
  // E-0008's time, not at the promotion's.
  let cursorMs = 0;

  // The guard is constructed ONCE, with a position counter that reads the map
  // the drill is maintaining, so CHECK 2 sees a real book rather than a
  // constant zero. The environment is injected rather than read from
  // process.env: this is a paper drill and it says so, instead of asserting
  // that the machine it happens to run on is configured for trading.
  const guard = new ExecutionGuard({
    getOpenPositions: () => open.size,
    getPrice: async (symbol: string) => {
      const p = await priceAtOrBefore(symbol, cursorMs);
      if (!p) throw new Error(`no historical price for ${symbol}`);
      return { symbol, price: p.price, raw: String(p.price), fetched_at: p.candle_ts };
    },
    env: { BITGET_PAPER_TRADING: 'true' },
  });

  for (const entry of entries) {
    const atMs = Date.parse(entry.timestamp_utc);
    const h = entry.hypothesis;
    cursorMs = atMs;

    if (entry.gate_decision === 'PROMOTE') {
      promotions += 1;
      const factorId = `F-${String(nextFactor++).padStart(4, '0')}`;

      const sourced = await priceAtOrBefore(h.target, atMs);
      if (!sourced) {
        process.stderr.write(
          `[drill] ${entry.entry_id}: no historical price for ${h.target}; skipping\n`,
        );
        continue;
      }

      const intent = orderIntentFor({
        hypothesis_id: entry.hypothesis_id,
        factor_id: factorId,
        target: h.target,
        direction: h.direction,
        notional_usdt: notional,
        entry_price: sourced.price,
      });

      // CHECK 4 needs a price too. Same close, same reason as the header says.
      const outcome = await guard.evaluate(intent);

      records.push({
        kind: 'order',
        entry_id: entry.entry_id,
        hypothesis_id: entry.hypothesis_id,
        factor_id: factorId,
        at: entry.timestamp_utc,
        symbol: intent.symbol,
        side: intent.side,
        notional_usdt: intent.notional_usdt,
        entry_price: intent.entry_price,
        price_source:
          `bitget 1m close ${sourced.candle_ts}` +
          ` (${sourced.candles_in_window} candles in the 6h window)`,
        allowed: outcome.allowed,
        refused_at: outcome.refused_at,
        refused_reason: outcome.refused_reason,
        detail: outcome.detail,
        checks: outcome.checks.map((c) => ({
          check: c.check,
          passed: c.passed,
          detail: c.detail,
        })),
        // Mirrors loop.ts exactly: the ledger treats "the guard allowed it" as
        // "placed", because in the no-executor case that IS the fill — a
        // simulated one. `mode` keeps that from reading as a live order.
        fill: {
          placed: outcome.allowed,
          mode: outcome.hub_attempts.length > 0 ? 'agent_hub' : 'simulated',
        },
      });
      orders += 1;

      if (outcome.allowed) open.set(entry.hypothesis_id, { factor_id: factorId, entry });
      continue;
    }

    // A KILL for a hypothesis that is currently holding a position is a
    // demotion: the verdict was withdrawn, so the simulated position closes.
    // This is the H-0006 arc — promoted at E-0006, killed at E-0008 when the
    // FDR bar rose above it.
    const held = open.get(entry.hypothesis_id);
    if (!held) continue;

    const sourced = await priceAtOrBefore(h.target, atMs);
    records.push({
      kind: 'close',
      entry_id: entry.entry_id,
      hypothesis_id: entry.hypothesis_id,
      factor_id: held.factor_id,
      at: entry.timestamp_utc,
      reason:
        `the promotion was withdrawn at ${entry.entry_id} (${entry.gate_reason ?? 'no reason ' +
          'recorded'}); the simulated position closes with it`,
      exit_price: sourced?.price ?? 0,
      price_source: sourced
        ? `bitget 1m close ${sourced.candle_ts}`
        : 'no historical price available',
    });
    closes += 1;
    open.delete(entry.hypothesis_id);
  }

  const header = [
    '# Factor Prover — paper execution log',
    '#',
    '# RECONSTRUCTED, NOT CAPTURED LIVE. The session that produced',
    `# ${logPath} ran on 2026-09-13 and kept its paper ledger in memory only, so`,
    '# this file was rebuilt from that log by src/scripts/replay-execution.ts.',
    '# The Execution Guard and the order-intent builder are imported from the',
    '# production modules, not reimplemented. Prices are real Bitget 1-minute',
    '# closes for the timestamps shown, fetched at replay time.',
    '#',
    '# No order here was sent anywhere. With no Agent Hub client configured the',
    '# guard validates and reports allowed=true having sent nothing, which is',
    '# the simulated fill. CHECK 4 compares the entry price against the same',
    '# historical close, so it passes at 0.000% by construction.',
    '#',
  ].join('\n');

  writeFileSync(
    outPath,
    header + '\n' + records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );

  console.log(`[drill] read      ${logPath} (${entries.length} entries)`);
  console.log(`[drill] promotions ${promotions}`);
  console.log(`[drill] orders     ${orders}`);
  console.log(`[drill] closes     ${closes}`);
  console.log(`[drill] wrote      ${outPath}`);
  return 0;
}

process.exitCode = await main();
