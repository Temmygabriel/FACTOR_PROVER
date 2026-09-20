/**
 * Bitget Agent Hub client.
 *
 * ============================================================================
 * STATUS: the command vector is VERIFIED against the real CLI. No live
 * placement has ever been made, so that part is still NOT.
 * ============================================================================
 *
 * WHAT "VERIFIED" MEANS HERE, AND HOW. On 2026-09-17 the CLI was installed from
 * npm on a GitHub runner — `@bitget-ai/bitget-agent-cli` 3.0.0, reporting
 * `bgc (bitget-agent-cli) using bitget-agent-sdk 3.1.0` — and interrogated with
 * `--help`, `discover`, and dry-run invocations. The workflow is
 * `.github/workflows/verify-agent-hub.yml`; the run is 35264648127. The dev
 * machine has 8GB of RAM and no toolchain, which is why this happened in the
 * cloud rather than here.
 *
 * THE VECTOR THIS FILE USED TO BUILD WAS WRONG IN FOUR SEPARATE WAYS, and the
 * corrections are recorded at `buildArgv` rather than quietly applied, because
 * "we guessed and then fixed it" is the useful part of the record. The largest
 * one is the grammar: v3 replaced `bgc <module> <tool>` with
 * `bgc <tool> --action <name>`, so the `order place` this file emitted was
 * rejected outright with
 *
 *   Error: unexpected extra arguments [place]. The v3 grammar is
 *   `bgc <tool> --action <name> --<param> <value>` (it replaced
 *   `bgc <module> <tool>`). Run `bgc discover`.
 *
 * WHAT REMAINS UNVERIFIED, STATED NARROWLY. No order has been placed, in paper
 * or otherwise, because the project holds no Bitget demo credentials. Every
 * confirmation above was obtained with `--dry-run`, which the CLI answers BEFORE
 * authentication — the dry-run probes returned a full `wouldSend` preview with
 * `authorized: false` and no credentials in the environment at all. So what is
 * proven is that the REQUEST is well-formed and that the CLI accepts every flag
 * this file passes. What is NOT proven is that the demo environment accepts
 * these symbols, or what a real placement returns. `unverified` in
 * `describeCapability` reports exactly that and nothing wider — it is not a
 * blanket disclaimer over the parts that were checked.
 *
 * Agent Hub is a CLI (`bgc`) taking `--paper-trading` (routes to the Demo
 * environment, and per its own help "needs demo credentials"), `--dry-run`,
 * `--read-only`, and `--confirm`. Note `--read-only` is documented as mutually
 * exclusive with `--paper-trading`, so those two can never be combined.
 *
 * THREE INDEPENDENT SWITCHES must all be on before an order can leave this
 * process. They are deliberately not collapsed into one:
 *
 *   1. BITGET_PAPER_TRADING === "true"   (enforced upstream by Execution Guard
 *                                          CHECK 1, and re-checked here because
 *                                          this is the module that builds the
 *                                          command line)
 *   2. ENABLE_EXECUTION === "true"       (off by default, per build spec §12)
 *   3. a `bgc` binary that actually exists
 *
 * A misconfiguration that satisfied one switch but not the others fails closed.
 * That redundancy is the point: this is the only module in the project capable
 * of causing an order, so it is the one place where duplicated safety checks
 * are worth their weight.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { OrderIntent } from './guard.js';

const execFileAsync = promisify(execFile);

export interface AgentHubConfig {
  /** ENABLE_EXECUTION === "true". Off unless explicitly turned on. */
  enabled: boolean;
  /** BITGET_PAPER_TRADING === "true". Re-checked because this builds the cmdline. */
  paperTrading: boolean;
  /** BGC_CLI_PATH, or "bgc" from PATH. */
  cliPath: string;
  /** Adds --dry-run: the CLI validates without placing. */
  dryRun: boolean;
  /** Timeout for a single CLI invocation. */
  timeoutMs: number;
  /**
   * BGC_CATEGORY. `order --action place` requires a `category` and the CLI
   * enumerates five: SPOT, MARGIN, USDT-FUTURES, COIN-FUTURES, USDC-FUTURES.
   *
   * Defaults to SPOT, and that default is measured rather than assumed. The
   * traded targets are the tokenised-equity rTokens in `RTOKEN_SYMBOLS`
   * (RCOINUSDT, RNVDAUSDT, …), and the CLI was asked directly which category
   * they live in:
   *
   *   market --action tickers --category SPOT --symbol RCOINUSDT
   *     → lastPrice 172.31
   *   market --action tickers --category USDT-FUTURES --symbol RCOINUSDT
   *     → HTTP 400: Trading pair RCOINUSDT does not exist
   *
   * `market` is a public endpoint, so that answer needed no credential.
   */
  category: string;
}

function envOrNull(name: string, env: Record<string, string | undefined>): string | null {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function loadAgentHubConfig(
  env: Record<string, string | undefined> = process.env,
): AgentHubConfig {
  return {
    enabled: (envOrNull('ENABLE_EXECUTION', env) ?? 'false').toLowerCase() === 'true',
    paperTrading: env['BITGET_PAPER_TRADING'] === 'true',
    cliPath: envOrNull('BGC_CLI_PATH', env) ?? 'bgc',
    dryRun: (envOrNull('BGC_DRY_RUN', env) ?? 'false').toLowerCase() === 'true',
    timeoutMs: Number(envOrNull('BGC_TIMEOUT_MS', env) ?? 30_000),
    category: envOrNull('BGC_CATEGORY', env) ?? 'SPOT',
  };
}

/**
 * Extra arguments placed after the fixed vector, split on whitespace.
 *
 * Exists so the command can be corrected against the real CLI without a code
 * change or a redeploy. Not a general-purpose injection point: the fixed
 * arguments — including `--paper-trading` and the confirm flag — are always
 * present and cannot be removed from here.
 */
function extraArgs(env: Record<string, string | undefined>): string[] {
  const raw = envOrNull('BGC_ORDER_ARGS', env);
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// Capability reporting
// ---------------------------------------------------------------------------

/**
 * Resolve a command name against PATH, the way a shell would.
 *
 * WHY THIS EXISTS. The previous version asked `existsSync("bgc")`, which is
 * false for every bare name, because a bare name is not a path — so the probe
 * reported "CLI not found" no matter what was installed, and the one branch
 * that would have looked it up on PATH was unreachable. A capability report
 * whose answer is a constant is worse than no report: it looks like a
 * measurement.
 *
 * Synchronous and environment-driven rather than a `which` subprocess, so it
 * stays pure enough to call from a status route and testable without a shell.
 */
function resolveOnPath(
  name: string,
  env: Record<string, string | undefined>,
): string | null {
  // An explicit path is not a lookup. It exists or it does not.
  if (name.includes('/') || name.includes('\\')) {
    return existsSync(name) ? name : null;
  }
  const pathValue = env['PATH'] ?? env['Path'] ?? env['path'];
  if (typeof pathValue !== 'string' || pathValue === '') return null;

  // Windows resolves a bare name against PATHEXT; POSIX does not, and a POSIX
  // executable may be an extensionless script. `""` first covers that and the
  // already-suffixed case.
  const suffixes =
    process.platform === 'win32'
      ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')].filter(Boolean)
      : [''];

  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface HubCapability {
  available: boolean;
  /** Machine-generated. Printed at session start so the gap is visible early. */
  detail: string;
  /** True when the integration is the documented-but-unverified one. */
  unverified: boolean;
}

/**
 * Whether an order has ever been observed leaving this code.
 *
 * Not a configuration flag, because it is not a configuration question — it is
 * a fact about what has been done, and the answer is that nothing has. The
 * REQUEST this module builds IS verified against the real CLI (4 separate
 * errors found and corrected; see the module header). What is missing is the
 * RESPONSE to a real order, which needs demo credentials this project does not
 * hold.
 *
 * It becomes false when someone runs one placement and records it. At that
 * point it should be replaced by a citation of that record rather than flipped,
 * because "we did it once" is only worth what the record of it is worth.
 */
const LIVE_PLACEMENT_OBSERVED = false;

/**
 * Probe whether paper execution is actually possible here.
 *
 * Reports rather than throws: a missing executor should degrade the session to
 * "research only, orders validated but not sent", not stop it. The one thing it
 * must never do is claim capability it does not have.
 */
export function describeCapability(
  cfg: AgentHubConfig = loadAgentHubConfig(),
  env: Record<string, string | undefined> = process.env,
): HubCapability {
  const detailParts: string[] = [];

  if (!cfg.paperTrading) {
    detailParts.push('BITGET_PAPER_TRADING is not "true" — Execution Guard CHECK 1 refuses every order');
  }
  if (!cfg.enabled) {
    detailParts.push('ENABLE_EXECUTION is not "true" (default) — orders are validated but never sent');
  }

  /*
   * The names are the CLI's own, copied from `bgc --help`:
   *
   *   Auth (environment variables):
   *     BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_PASSPHRASE
   *
   * This check previously read BITGET_API_SECRET and BITGET_API_PASSPHRASE —
   * two variables no version of the CLI reads. So the deployed banner told a
   * reader to set names that could not have satisfied it, and would have gone
   * on saying so after they were set correctly. The banner a person reads to
   * decide whether the product works is the last place a plausible guess
   * belongs.
   */
  const missingCreds = ['BITGET_API_KEY', 'BITGET_SECRET_KEY', 'BITGET_PASSPHRASE'].filter(
    (name) => {
      const v = env[name];
      return typeof v !== 'string' || v === '';
    },
  );
  if (missingCreds.length > 0) {
    detailParts.push(`Bitget credentials incomplete (${missingCreds.join(', ')} missing)`);
  }

  /*
   * A resolved CLI is part of `available`, not a footnote to it. All three
   * switches have to be on, and "a bgc binary that actually exists" is one of
   * them per the module header — so a report that says execution is available
   * while also saying the binary is missing would be contradicting itself on
   * one line.
   */
  const resolvedCli = resolveOnPath(cfg.cliPath, env);
  const available =
    cfg.paperTrading && cfg.enabled && missingCreds.length === 0 && resolvedCli !== null;

  if (resolvedCli !== null) {
    detailParts.push(`CLI found at ${resolvedCli}`);
  } else {
    detailParts.push(`no "${cfg.cliPath}" on PATH and none at that path as a file`);
  }
  if (cfg.dryRun) detailParts.push('BGC_DRY_RUN is on — the CLI will validate without placing');
  detailParts.push(`orders would be sent as category ${cfg.category}`);

  const verified =
    'The request vector IS verified against the real CLI (@bitget-ai/bitget-agent-cli 3.0.0, ' +
    'bitget-agent-sdk 3.1.0): every flag this module passes was accepted in dry-run, which the ' +
    'CLI answers before authentication. What is NOT verified is a live placement — no order has ' +
    'been placed, in paper or otherwise, because no demo credentials exist here.';

  return {
    available,
    unverified: !LIVE_PLACEMENT_OBSERVED,
    detail:
      (available
        ? 'paper execution appears CONFIGURED'
        : 'paper execution is DISABLED — orders will be validated but not sent') +
      (detailParts.length ? `: ${detailParts.join('; ')}` : '') +
      '. ' +
      verified,
  };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class ExecutionDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionDisabledError';
  }
}

export interface BgcOrderResult {
  confirmationRequired: boolean;
  accepted: boolean;
  orderId: string | null;
  detail: string;
  /** Raw stdout/stderr, kept so an unexpected CLI shape is diagnosable. */
  raw: { stdout: string; stderr: string; exitCode: number };
}

export class BgcAgentHubClient {
  private readonly cfg: AgentHubConfig;
  private readonly env: Record<string, string | undefined>;

  constructor(
    cfg: AgentHubConfig = loadAgentHubConfig(),
    env: Record<string, string | undefined> = process.env,
  ) {
    this.cfg = cfg;
    this.env = env;
  }

  /**
   * Order size in the unit the CLI wants for this side.
   *
   * THE CONVERSION IS NOT COSMETIC. `qty` does not mean one thing:
   *
   *   - market BUY  → qty is QUOTE coin, so it IS the USDT notional. Identity.
   *   - market SELL → qty is BASE coin, so the notional has to be divided by
   *                   the price to get a quantity of the asset.
   *
   * Verified from `bgc discover --tool order --action place`, whose `qty`
   * description reads: "For market buy orders, the unit is quote coin. For limit
   * and market sell orders, the unit is base coin."
   *
   * The old builder sent `--notional-usdt`, a flag that does not exist, so this
   * question could not arise. Now that the flag is real it can, and sending a
   * USDT figure as a SELL quantity would size the order at `notional × price`
   * — larger than the guard's `max_order_usdt` by exactly the price, which for
   * RCOINUSDT at ~172 USDT means a 100 USDT order becoming a ~17,200 USDT one.
   * The guard would have approved the notional it was shown. So this refuses
   * rather than guesses when the price it needs is not usable.
   *
   * The string form is not incidental: the CLI types `qty` as a string, and a
   * JS number reaching it as `1e-7` for a small quantity would be a parse error
   * at best. It is formatted to a fixed 8 decimals — the base-coin precision
   * Bitget uses — rather than left to `String(n)`.
   */
  private qtyFor(order: OrderIntent): string {
    if (order.side === 'buy') return order.notional_usdt.toFixed(8);

    // A sell needs a price to convert notional into base coin.
    const price = order.entry_price;
    if (!Number.isFinite(price) || price <= 0) {
      throw new ExecutionDisabledError(
        `refusing to size a SELL of ${order.symbol}: qty must be in base coin, which needs a ` +
          `positive price to derive from a USDT notional, and entry_price is ${price}. ` +
          `Execution Guard CHECK 4 is supposed to have refused this order already.`,
      );
    }
    return (order.notional_usdt / price).toFixed(8);
  }

  /**
   * Build the argv for one order.
   *
   * CORRECTED AGAINST THE REAL CLI on 2026-09-17. Four things were wrong:
   *
   *   1. `order place` → `order --action place`. v3 replaced `bgc <module>
   *      <tool>`; the old shape is rejected with "unexpected extra arguments
   *      [place]". This was not a wrong flag, it was a wrong grammar, and it
   *      failed before any argument was looked at.
   *   2. `--notional-usdt` → `--qty`. No such flag exists. `qty` is also typed
   *      as a string, and its unit depends on the side (see `qtyFor`).
   *   3. `--category` and `--orderType` were MISSING. `bgc discover` lists both
   *      as required for `place`, alongside symbol, qty and side. An order
   *      without them would have been refused by the API, not just the parser.
   *   4. `--json` → removed. It is not a flag; JSON is the CLI's default output
   *      and `--pretty` is the modifier. The old builder appended a flag that
   *      does not exist to every single order.
   *
   * `--paper-trading` and `--dry-run` were correct as spelled, which is worth
   * recording too: the failure was not uniform, so "it was all wrong" would be
   * as misleading as "it was fine".
   *
   * `--confirm` IS kept, and it is NOT the CLI's two-phase contract. Discovery
   * reports `requiresConfirm: false` for `place`, and the dry-run probes
   * returned no `confirmationRequired` — so the CLI places on the first call and
   * would never ask. The two-phase confirm this project relies on is Execution
   * Guard CHECK 5, which is ours, not the CLI's. Passing `--confirm` is
   * harmless (verified: the flag is accepted on `place`) and it keeps the
   * command line self-describing, but no safety property here depends on it,
   * and nothing should be written that implies otherwise.
   *
   * The confirm flag is applied LAST and is never omitted: an unconfirmed call
   * must be visibly unconfirmed on the command line, so that a log of the argv
   * shows which phase it was.
   */
  private buildArgv(order: OrderIntent, opts: { confirm: boolean }): string[] {
    const argv = [
      'order',
      '--action', 'place',
      '--category', this.cfg.category,
      '--symbol', order.symbol,
      '--side', order.side,
      '--orderType', 'market',
      '--qty', this.qtyFor(order),
      // Fixed and non-removable, whatever BGC_ORDER_ARGS says.
      '--paper-trading',
    ];
    if (this.cfg.dryRun) argv.push('--dry-run');
    if (opts.confirm) argv.push('--confirm');
    argv.push(...extraArgs(this.env));
    return argv;
  }

  async placeOrder(
    order: OrderIntent,
    opts: { confirm: boolean },
  ): Promise<BgcOrderResult> {
    // Re-check both switches here. Execution Guard already checked the paper
    // flag, but this is the module that builds the command line, and a safety
    // check that matters is worth having at the point of the dangerous act as
    // well as at the boundary.
    if (this.env['BITGET_PAPER_TRADING'] !== 'true') {
      throw new ExecutionDisabledError(
        'refusing to invoke Agent Hub: BITGET_PAPER_TRADING is not exactly "true"',
      );
    }
    if (!this.cfg.enabled) {
      throw new ExecutionDisabledError(
        'refusing to invoke Agent Hub: ENABLE_EXECUTION is not "true". This is the default; ' +
          'set it to "true" deliberately to allow paper orders.',
      );
    }

    const argv = this.buildArgv(order, opts);

    try {
      const { stdout, stderr } = await execFileAsync(this.cfg.cliPath, argv, {
        timeout: this.cfg.timeoutMs,
        env: this.env as NodeJS.ProcessEnv,
        maxBuffer: 1024 * 1024,
      });
      return this.parseResult(stdout, stderr, 0, opts);
    } catch (err) {
      // A non-zero exit is not necessarily a failure to place — the CLI may use
      // exit codes to signal "confirmation required". Parse whatever came back
      // before concluding anything.
      const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string };
      if (typeof e.stdout === 'string') {
        return this.parseResult(e.stdout, e.stderr ?? '', Number(e.code ?? 1), opts);
      }
      return {
        confirmationRequired: false,
        accepted: false,
        orderId: null,
        detail:
          `could not run "${this.cfg.cliPath}": ${e.message ?? String(err)}. ` +
          `If the CLI is not installed this is the expected outcome; the order was NOT placed.`,
        raw: { stdout: '', stderr: e.stderr ?? '', exitCode: Number(e.code ?? -1) },
      };
    }
  }

  /**
   * Interpret CLI output.
   *
   * Deliberately conservative: an output shape this code does not recognise is
   * reported as NOT accepted. The alternative — treating unrecognised output as
   * success — would mean a CLI change silently turns every parse failure into a
   * claimed order.
   *
   * TWO ENVELOPES WERE ACTUALLY OBSERVED on 2026-09-17, and the previous
   * version of this function recognised neither. It looked for a flat
   * `success`/`accepted`/`status`/`orderId`, and it read `parsed['data']` as an
   * order id — which in the real envelope is an OBJECT, so it would have
   * failed the `typeof === 'string'` test every time. Both shapes below are
   * copied from real output, not from documentation:
   *
   *   error   {"ok":false,"error":{"type":"BitgetApiError","code":"400",
   *            "message":"Trading pair RCOINUSDT does not exist",...}}
   *           — exit 1
   *
   *   dry-run {"endpoint":"POST /api/v3/trade/place-order","requestTime":"…",
   *            "data":{"dryRun":true,"operationId":"placeOrder",
   *            "riskLevel":"write","wouldSend":{…}}}
   *           — exit 0
   */
  private parseResult(
    stdout: string,
    stderr: string,
    exitCode: number,
    opts: { confirm: boolean },
  ): BgcOrderResult {
    const raw = { stdout, stderr, exitCode };

    /*
     * WHICH STREAM CARRIES THE ENVELOPE — measured, not assumed.
     *
     * This function used to read stdout ONLY, and on 2026-09-20 a real placement
     * attempt showed why that is wrong. On a REFUSAL the CLI writes its JSON
     * envelope to STDERR and leaves stdout empty. So the error branch below
     * could never fire for a real refusal: every one of them fell into the
     * "returned no output" branch instead, which discarded the structured error
     * — `type`, `code`, `message` — and kept a 300-character suffix of it. The
     * run that found this is 35527828818 and the verbatim bodies are in
     * logs/paper-live.jsonl, including both refusals quoted in full.
     *
     * stderr is consulted only when stdout is EMPTY, so a success envelope is
     * still read from stdout, and a CLI that writes progress chatter to stderr
     * beside a good stdout cannot have that chatter mistaken for the result.
     *
     * This is the second thing about this module that only a real placement
     * could have taught. The first was the grammar; see `buildArgv`.
     */
    const trimmed = stdout.trim() !== '' ? stdout.trim() : stderr.trim();

    if (trimmed === '') {
      return {
        confirmationRequired: false,
        accepted: false,
        orderId: null,
        detail: `the CLI returned no output on either stream (exit ${exitCode})`,
        raw,
      };
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start !== -1 && end > start) {
        parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }

    if (!parsed) {
      return {
        confirmationRequired: false,
        accepted: false,
        orderId: null,
        detail:
          `could not parse the CLI output as JSON (exit ${exitCode}): ${trimmed.slice(0, 300)}. ` +
          `Treating as NOT placed.`,
        raw,
      };
    }

    // ---- Envelope 1: the CLI's error ---------------------------------------
    // Checked FIRST, before any success field. An error body that happened to
    // carry a truthy field elsewhere must not be able to read as a placement.
    //
    // `!== null` as well as `!== undefined`, because a body carrying an explicit
    // `"error": null` is a body with NO error, and testing only for `undefined`
    // would refuse every such response.
    if (parsed['ok'] === false || (parsed['error'] !== undefined && parsed['error'] !== null)) {
      const err = parsed['error'];
      const message =
        err !== null && typeof err === 'object' && typeof (err as Record<string, unknown>)['message'] === 'string'
          ? String((err as Record<string, unknown>)['message'])
          : typeof err === 'string'
            ? err
            : 'the CLI reported an error with no message';
      return {
        confirmationRequired: false,
        accepted: false,
        orderId: null,
        detail: `the CLI refused the order (exit ${exitCode}): ${message}`,
        raw,
      };
    }

    const dataRaw = parsed['data'];
    const data =
      dataRaw !== null && typeof dataRaw === 'object' && !Array.isArray(dataRaw)
        ? (dataRaw as Record<string, unknown>)
        : null;

    // ---- Envelope 2: a dry run ---------------------------------------------
    // A dry run returns a SUCCESS-SHAPED body for an order that was never sent.
    // Reading that as accepted would make BGC_DRY_RUN — a setting whose entire
    // purpose is to not place orders — look like working execution in every log
    // and on every screen. It is a preview, and it is reported as one.
    if (data !== null && data['dryRun'] === true) {
      return {
        confirmationRequired: false,
        accepted: false,
        orderId: null,
        detail:
          `DRY RUN — the CLI validated the order and sent nothing (exit ${exitCode}). ` +
          `wouldSend: ${JSON.stringify(data['wouldSend'] ?? null)}`,
        raw,
      };
    }

    const confirmationRequired =
      parsed['confirmationRequired'] === true ||
      parsed['confirmation_required'] === true ||
      parsed['status'] === 'confirmation_required';

    /*
     * A REAL PLACEMENT, which has NEVER BEEN OBSERVED — see
     * LIVE_PLACEMENT_OBSERVED above. Only the two envelopes above have been
     * seen from this CLI, so where a live placement puts its order id is not
     * known. This looks in the place the dry-run body implies one would appear
     * (`data.orderId`, beside `data.dryRun`) and at the top level, and claims
     * nothing if it finds neither. Being wrong in this direction costs a
     * promotion its execution record; being wrong in the other direction
     * records an order that was never placed.
     */
    const orderIdCandidates = [data?.['orderId'], data?.['orderIdStr'], parsed['orderId']];
    const orderId =
      orderIdCandidates.find((v): v is string => typeof v === 'string' && v !== '') ?? null;

    const accepted =
      parsed['success'] === true ||
      parsed['accepted'] === true ||
      parsed['status'] === 'filled' ||
      parsed['status'] === 'placed' ||
      (orderId !== null && !confirmationRequired);

    return {
      confirmationRequired,
      accepted,
      orderId,
      detail:
        `cli exit ${exitCode}, confirm=${opts.confirm}, ` +
        `confirmationRequired=${confirmationRequired}, accepted=${accepted}` +
        (typeof parsed['message'] === 'string' ? `; ${parsed['message']}` : ''),
      raw,
    };
  }
}
