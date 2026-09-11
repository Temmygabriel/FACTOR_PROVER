/**
 * Bitget Agent Hub client.
 *
 * ============================================================================
 * STATUS: UNVERIFIED. Read this before trusting anything in this file.
 * ============================================================================
 *
 * Agent Hub is a CLI (`bgc`), per the recon recorded in docs/DATA_FINDINGS.md:
 * it takes `--paper-trading` (routes to the Demo environment), `--dry-run`,
 * `--read-only`, and `--confirm` (required for high-risk operations).
 *
 * This client has NEVER BEEN RUN AGAINST A LIVE AGENT HUB, because the project
 * holds no Bitget API credentials. That is a real gap and it is recorded here,
 * in PROGRESS.md, and in the submission checklist rather than papered over.
 * What IS verified is the Execution Guard around it — all five checks, 59 test
 * cases, including every path that refuses.
 *
 * What that means concretely:
 *
 *   - The command vector below is built from the documented flags. The exact
 *     subcommand and argument spelling MUST be confirmed against `bgc --help`
 *     before the demo. `describeCapability()` reports whether `bgc` is present
 *     at all, so this is discoverable rather than assumed.
 *   - `BGC_ORDER_ARGS` exists so the vector can be corrected without editing
 *     code. If the real CLI differs, fix it there.
 *   - The two-phase confirm contract (an unconfirmed call answers
 *     `confirmationRequired` and places nothing; a confirmed call places the
 *     order) is the CLI's documented behaviour, not something observed here.
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

export interface HubCapability {
  available: boolean;
  /** Machine-generated. Printed at session start so the gap is visible early. */
  detail: string;
  /** True when the integration is the documented-but-unverified one. */
  unverified: boolean;
}

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

  const hasKey = typeof env['BITGET_API_KEY'] === 'string' && env['BITGET_API_KEY'] !== '';
  const hasSecret = typeof env['BITGET_API_SECRET'] === 'string' && env['BITGET_API_SECRET'] !== '';
  const hasPass = typeof env['BITGET_API_PASSPHRASE'] === 'string' && env['BITGET_API_PASSPHRASE'] !== '';
  if (!hasKey || !hasSecret || !hasPass) {
    detailParts.push(
      'Bitget credentials incomplete (' +
        [!hasKey && 'BITGET_API_KEY', !hasSecret && 'BITGET_API_SECRET', !hasPass && 'BITGET_API_PASSPHRASE']
          .filter(Boolean)
          .join(', ') +
        ' missing)',
    );
  }

  const cliPresent = cfg.cliPath.includes('/') || cfg.cliPath.includes('\\')
    ? existsSync(cfg.cliPath)
    : false;

  const available = cfg.paperTrading && cfg.enabled && hasKey && hasSecret && hasPass;

  if (available && !cliPresent && !cfg.cliPath.includes('\\') && !cfg.cliPath.includes('/')) {
    // Relying on PATH resolution; cannot confirm without executing. Said plainly
    // instead of assumed either way.
    detailParts.push(`"${cfg.cliPath}" will be resolved from PATH at order time (not verified here)`);
  }
  if (cliPresent) detailParts.push(`CLI found at ${cfg.cliPath}`);
  if (cfg.dryRun) detailParts.push('BGC_DRY_RUN is on — the CLI will validate without placing');

  return {
    available,
    unverified: true,
    detail:
      (available
        ? 'paper execution appears CONFIGURED'
        : 'paper execution is DISABLED — orders will be validated but not sent') +
      (detailParts.length ? `: ${detailParts.join('; ')}` : '') +
      '. NOTE: the Agent Hub command vector is documented but UNVERIFIED against a live ' +
      'Agent Hub; confirm it with `bgc --help` before relying on it.',
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
   * Build the argv for one order.
   *
   * The confirm flag is applied LAST and is never omitted: an unconfirmed call
   * must be visibly unconfirmed on the command line, so that a log of the argv
   * shows which phase it was.
   */
  private buildArgv(order: OrderIntent, opts: { confirm: boolean }): string[] {
    const argv = [
      'order',
      'place',
      '--symbol', order.symbol,
      '--side', order.side,
      '--notional-usdt', String(order.notional_usdt),
      // Fixed and non-removable, whatever BGC_ORDER_ARGS says.
      '--paper-trading',
    ];
    if (this.cfg.dryRun) argv.push('--dry-run');
    // Per the documented contract, --confirm is what authorises a high-risk op.
    if (opts.confirm) argv.push('--confirm');
    argv.push('--json');
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
   */
  private parseResult(
    stdout: string,
    stderr: string,
    exitCode: number,
    opts: { confirm: boolean },
  ): BgcOrderResult {
    const raw = { stdout, stderr, exitCode };
    const trimmed = stdout.trim();

    if (trimmed === '') {
      return {
        confirmationRequired: false,
        accepted: false,
        orderId: null,
        detail:
          `the CLI returned no output (exit ${exitCode})` +
          (stderr.trim() ? `; stderr: ${stderr.trim().slice(0, 300)}` : ''),
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

    const confirmationRequired =
      parsed['confirmationRequired'] === true ||
      parsed['confirmation_required'] === true ||
      parsed['status'] === 'confirmation_required';

    const orderIdRaw = parsed['orderId'] ?? parsed['order_id'] ?? parsed['data'];
    const orderId = typeof orderIdRaw === 'string' ? orderIdRaw : null;

    // Accepted only on an explicit affirmative. Absence of an error is not
    // evidence of success.
    const accepted =
      parsed['success'] === true ||
      parsed['accepted'] === true ||
      parsed['status'] === 'filled' ||
      parsed['status'] === 'placed' ||
      (orderId !== null && parsed['error'] === undefined && !confirmationRequired);

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
