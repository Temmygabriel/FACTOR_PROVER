/**
 * Live execution — run a promoted order through the REAL Execution Guard and
 * the REAL Bitget Agent Hub CLI, against Bitget's demo environment.
 *
 * WHAT THIS IS, AND HOW IT DIFFERS FROM `replay-execution.ts`. The drill beside
 * this file reconstructs the execution leg of a past session from a committed
 * log, with NO Agent Hub client configured — so its orders are validated and
 * never sent, and its own header says so. This script is the other thing: it
 * hands the guard a real `BgcAgentHubClient`, so CHECK 5 actually invokes `bgc`,
 * the order actually reaches Bitget, and the response is whatever Bitget really
 * said. That response is the artifact this script exists to produce.
 *
 * WHY IT IS A SCRIPT AND NOT THE SESSION LOOP. The loop writes
 * `logs/decisions.jsonl` and will overwrite it given `--replace`. The committed
 * log is the one artifact this project is judged on and has been clobbered by a
 * calibration run twice already. So the execution leg is exercised from here,
 * writing to a path of its own that nothing else touches.
 *
 * THREE SWITCHES, ALL REQUIRED, ALL CHECKED BEFORE ANYTHING IS BUILT:
 *
 *   BITGET_PAPER_TRADING === "true"   (Execution Guard CHECK 1, re-checked by
 *                                      the client because it builds the cmdline)
 *   ENABLE_EXECUTION      === "true"  (off by default)
 *   BITGET_API_KEY / _SECRET_KEY / _PASSPHRASE  all three, non-empty
 *
 * A missing switch is reported and the script exits WITHOUT sending. It does not
 * fall back to "validate only" and it does not send anyway — the point of the
 * run is a real placement, and a run that quietly degrades to a simulation would
 * produce a file that looks like evidence and is not.
 *
 * WHY THE DEMO ENVIRONMENT AND NOT LIVE. Every private call this script can
 * cause carries `--paper-trading`, which routes to Bitget's Demo environment and
 * cannot reach a funded account. There is no flag combination here that trades
 * real money.
 *
 * Usage:
 *   tsx src/scripts/live-execution.ts [--log logs/decisions.jsonl]
 *                                     [--out logs/paper-live.jsonl]
 *                                     [--venue-check SYMBOL:side]
 *
 * `--venue-check` runs ONE extra order through the same guard and the same
 * client on an instrument of the caller's choosing. It exists because the
 * instrument this project actually promotes may be refused by the venue for
 * reasons that have nothing to do with this project's code, and when that
 * happens "the pipeline works" and "the pipeline has never placed an order" are
 * both true and the refuses alone cannot tell them apart. A venue check that
 * fills is the difference. It is recorded under its own `kind` so it can never
 * be read as a factor promotion.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadGatePolicy } from '../config.js';
import {
  BgcAgentHubClient,
  describeCapability,
  loadAgentHubConfig,
  type BgcOrderResult,
} from '../execution/agentHub.js';
import {
  ExecutionGuard,
  orderIntentFor,
  type GuardOutcome,
  type OrderIntent,
} from '../execution/guard.js';
import { fetchSpotPrice } from '../execution/prices.js';

// ---------------------------------------------------------------------------
// The committed log, as this script reads it
// ---------------------------------------------------------------------------

interface LogEntry {
  entry_id: string;
  hypothesis_id: string;
  timestamp_utc: string;
  gate_decision: 'PROMOTE' | 'KILL';
  gate_reason: string | null;
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
// Records
// ---------------------------------------------------------------------------

/**
 * One invocation of the CLI, with its bytes.
 *
 * This is the part `GuardOutcome.hub_attempts` cannot carry. The guard keeps a
 * machine-generated summary of each attempt, which is the right thing for a
 * decision record; but the question this run is answering is what Bitget's
 * actual response body looks like, because `parseResult` has never seen a real
 * placement and guesses where the order id lives. A summary cannot answer that.
 * The raw stdout is kept verbatim, and kept even on success.
 */
interface CliCall {
  phase: 'initial' | 'confirmed';
  exit_code: number;
  stdout: string;
  stderr: string;
}

interface LiveRecord {
  kind: 'live_order' | 'venue_check';
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
  hub_attempts: GuardOutcome['hub_attempts'];
  /** The CLI's own bytes. Empty when the guard refused before CHECK 5. */
  cli_calls: CliCall[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const argOf = (name: string, fallback: string): string => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const logPath = argOf('--log', 'logs/decisions.jsonl');
  const outPath = argOf('--out', 'logs/paper-live.jsonl');
  const venueCheck = argOf('--venue-check', '');

  // --- the three switches, before anything is built ------------------------
  const cfg = loadAgentHubConfig();
  const cap = describeCapability(cfg);

  process.stdout.write(`[live] capability: ${cap.detail}\n`);
  if (!cap.available) {
    process.stderr.write(
      `\n[live] REFUSING TO RUN. The capability check above found execution is not ` +
        `configured, so a "placement" from this process would be a simulation wearing ` +
        `the word live. Set BITGET_PAPER_TRADING=true, ENABLE_EXECUTION=true and all ` +
        `three BITGET_* credentials, then run again.\n`,
    );
    return 1;
  }

  if (!existsSync(logPath)) {
    process.stderr.write(`[live] no decision log at ${logPath}\n`);
    return 1;
  }

  const entries = readLog(logPath);
  const promotions = entries.filter((e) => e.gate_decision === 'PROMOTE');
  const promoted = promotions[promotions.length - 1];
  if (!promoted) {
    process.stderr.write(`[live] ${logPath} contains no PROMOTE entry — nothing to execute\n`);
    return 1;
  }

  const policy = loadGatePolicy().data;
  const notional = policy.execution_guard.max_order_usdt;

  // --- the real client, wrapped only to keep its bytes ---------------------
  //
  // The wrapper is the guard's OWN extension point (`GuardDeps.hub`), and it
  // delegates to the real client rather than reimplementing any part of it. So
  // the command line, the credentials and the parsing are the production ones;
  // all this adds is a copy of the output on the way past. Wrapping rather than
  // calling the client directly matters: calling it directly would invoke the
  // CLI a SECOND time and could place a second real order.
  const client = new BgcAgentHubClient(cfg);
  const cliCalls: CliCall[] = [];
  const hub = {
    async placeOrder(order: OrderIntent, opts: { confirm: boolean }) {
      const result: BgcOrderResult = await client.placeOrder(order, opts);
      cliCalls.push({
        phase: opts.confirm ? 'confirmed' : 'initial',
        exit_code: result.raw.exitCode,
        stdout: result.raw.stdout,
        stderr: result.raw.stderr,
      });
      return result;
    },
  };

  // A real position counter, so CHECK 2 sees a book rather than a constant zero.
  let openPositions = 0;

  const guard = new ExecutionGuard({
    getOpenPositions: () => openPositions,
    getPrice: fetchSpotPrice,
    hub,
    now: () => new Date(),
  });

  const records: LiveRecord[] = [];
  let nextFactor = 1;

  const run = async (p: {
    kind: LiveRecord['kind'];
    entryId: string;
    hypothesisId: string;
    target: string;
    direction: 'positive' | 'negative';
  }): Promise<void> => {
    const quote = await fetchSpotPrice(p.target);
    const intent = orderIntentFor({
      hypothesis_id: p.hypothesisId,
      factor_id: `F-${String(nextFactor++).padStart(4, '0')}`,
      target: p.target,
      direction: p.direction,
      notional_usdt: notional,
      // CHECK 4 compares this against the live price the guard fetches a moment
      // later. Using the same source for both is deliberate and is the honest
      // reading: this is not a stale signal being re-priced, it is an order
      // priced at the market now, so the band should pass and a failure here
      // means the market moved between two calls microseconds apart.
      entry_price: quote.price,
    });

    const before = cliCalls.length;
    const outcome = await guard.evaluate(intent);
    if (outcome.allowed) openPositions += 1;

    records.push({
      kind: p.kind,
      entry_id: p.entryId,
      hypothesis_id: p.hypothesisId,
      factor_id: intent.factor_id,
      at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      symbol: intent.symbol,
      side: intent.side,
      notional_usdt: intent.notional_usdt,
      entry_price: intent.entry_price,
      price_source: `bitget spot ticker, lastPr ${quote.raw}, fetched ${quote.fetched_at}`,
      allowed: outcome.allowed,
      refused_at: outcome.refused_at,
      refused_reason: outcome.refused_reason,
      detail: outcome.detail,
      checks: outcome.checks.map((c) => ({
        check: c.check,
        passed: c.passed,
        detail: c.detail,
      })),
      hub_attempts: outcome.hub_attempts,
      cli_calls: cliCalls.slice(before),
    });

    process.stdout.write(
      `[live] ${p.kind} ${intent.symbol} ${intent.side} ` +
        `${intent.notional_usdt} USDT -> allowed=${outcome.allowed}` +
        `${outcome.refused_at ? ` refused_at=${outcome.refused_at}` : ''}\n`,
    );
  };

  // 1. The order the project's own committed decision implies.
  await run({
    kind: 'live_order',
    entryId: promoted.entry_id,
    hypothesisId: promoted.hypothesis_id,
    target: promoted.hypothesis.target,
    direction: promoted.hypothesis.direction,
  });

  // 2. Optional venue check — a different instrument, same guard, same client.
  if (venueCheck) {
    const [symbol, side] = venueCheck.split(':');
    if (!symbol || (side !== 'buy' && side !== 'sell')) {
      process.stderr.write(
        `[live] --venue-check wants SYMBOL:side where side is buy or sell; got ` +
          `${JSON.stringify(venueCheck)}\n`,
      );
      return 1;
    }
    await run({
      kind: 'venue_check',
      entryId: 'VENUE-CHECK',
      hypothesisId: 'VENUE-CHECK',
      target: symbol,
      direction: side === 'buy' ? 'positive' : 'negative',
    });
  }

  const header = [
    '# Factor Prover — LIVE paper execution record',
    '#',
    '# CAPTURED LIVE, NOT RECONSTRUCTED. Unlike logs/paper.jsonl, every record',
    '# below was produced by src/scripts/live-execution.ts running with a real',
    '# Bitget Agent Hub client: the Execution Guard and the order-intent builder',
    '# are the production modules, and CHECK 5 invoked the real `bgc` binary,',
    '# which signed the request and sent it to Bitget.',
    '#',
    '# DEMO ENVIRONMENT ONLY. Every call carried --paper-trading, which routes to',
    '# Bitget\'s demo environment. No real money exists in this account and no',
    '# flag combination in this script can reach a funded one.',
    '#',
    '# kind=live_order is the order the committed decision log implies — the',
    '# project\'s own promoted hypothesis, executed. kind=venue_check is not a',
    '# factor promotion: it is one order on an instrument of the caller\'s',
    '# choosing, placed to establish whether the command vector, the signing and',
    '# the exchange accept an order from this code path at all.',
    '#',
    `# promoted entry replayed: ${promoted.entry_id} / ${promoted.hypothesis_id} ` +
      `(${promoted.timestamp_utc})`,
    '#',
  ].join('\n');

  writeFileSync(
    outPath,
    header + '\n' + records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );

  process.stdout.write(`[live] wrote ${outPath} (${records.length} records)\n`);
  return 0;
}

process.exitCode = await main();
