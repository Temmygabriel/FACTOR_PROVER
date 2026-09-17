/**
 * The Agent Hub command vector — the only code in this project that can cause an
 * order, and the only module in it that was, until 2026-09-17, built entirely
 * from documented flags that had never been checked against the real CLI.
 *
 * WHY THIS FILE EXISTS NOW. The vector was wrong in four separate ways and had
 * been since it was written, because nothing could contradict it: the machine
 * that wrote it has 8GB of RAM and no toolchain, `bgc` is an npm package rather
 * than a prebuilt binary, and the project holds no Bitget credentials. So the
 * commands below were never run, and every one of them failed the first time
 * they were. A test that pins the corrected spelling is what stops the next
 * edit from drifting back to the plausible version.
 *
 * WHAT THE FIXTURES ARE. The stdout strings in `the CLI's real envelopes` are
 * copied verbatim from GitHub Actions run 35264648127, which installed
 * `@bitget-ai/bitget-agent-cli` 3.0.0 on a Linux runner and invoked it. They are
 * not paraphrases and not from documentation; two of them are error messages
 * that exist precisely because something was wrong.
 *
 * Nothing here spawns a process. `buildArgv` is reached through a subclass that
 * exposes the private method, and `parseResult` is exercised through the public
 * result shape — so a test that would have run `bgc` cannot.
 */

import { describe, expect, it } from 'vitest';
import {
  BgcAgentHubClient,
  describeCapability,
  loadAgentHubConfig,
  type BgcOrderResult,
} from '../src/execution/agentHub.js';
import type { OrderIntent } from '../src/execution/guard.js';

const ORDER: OrderIntent = {
  symbol: 'RCOINUSDT',
  side: 'buy',
  notional_usdt: 50,
  entry_price: 100,
  factor_id: 'F-001',
  hypothesis_id: 'H-0001',
};

/**
 * Reaches the private builders without spawning anything.
 *
 * A subclass rather than a cast to a bare `any`, so that a rename or a signature
 * change in the real class breaks this at the point of use rather than silently
 * calling something that is no longer there.
 */
type Internals = {
  buildArgv(order: OrderIntent, opts: { confirm: boolean }): string[];
  parseResult(
    stdout: string,
    stderr: string,
    exitCode: number,
    opts: { confirm: boolean },
  ): BgcOrderResult;
};

class ArgvOnly extends BgcAgentHubClient {
  argv(order: OrderIntent, confirm: boolean): string[] {
    const self = this as unknown as Internals;
    return self.buildArgv.call(this, order, { confirm });
  }

  parse(stdout: string, exitCode: number, confirm = false): BgcOrderResult {
    const self = this as unknown as Internals;
    return self.parseResult.call(this, stdout, '', exitCode, { confirm });
  }
}

function client(env: Record<string, string | undefined> = {}) {
  return new ArgvOnly(loadAgentHubConfig(env), env);
}

/**
 * The argument after `flag`, or null. Asserting on pairs rather than on the
 * whole vector keeps a failure readable: "expected --qty, got undefined" says
 * what broke, where a whole-array mismatch does not.
 */
function valueOf(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

describe('the grammar is v3 — `bgc <tool> --action <name>`, not `bgc <tool> <name>`', () => {
  it('spells place as an --action, not as a positional argument', () => {
    const argv = client().argv(ORDER, false);
    expect(argv[0]).toBe('order');
    expect(argv[1]).toBe('--action');
    expect(argv[2]).toBe('place');
  });

  it('carries place as the VALUE of --action, never as a bare argument', () => {
    // The exact failure the real CLI reported:
    //   Error: unexpected extra arguments [place]. The v3 grammar is
    //   `bgc <tool> --action <name> --<param> <value>`
    // So the token 'place' must appear exactly once, and must be preceded by
    // --action. Filtering for "arguments that do not start with a dash" would
    // not test this: flag VALUES do not start with a dash either, so 'place',
    // 'SPOT' and the symbol all look positional to such a filter.
    const argv = client().argv(ORDER, false);
    expect(argv.filter((a) => a === 'place')).toHaveLength(1);
    expect(argv[argv.indexOf('place') - 1]).toBe('--action');
  });

  it('passes the parameters the CLI lists as REQUIRED for place', () => {
    // `bgc discover --tool order --action place` names five required params:
    // category, symbol, qty, side, orderType. Two of them — category and
    // orderType — were absent from the vector entirely.
    const argv = client().argv(ORDER, false);
    for (const flag of ['--category', '--symbol', '--side', '--qty', '--orderType']) {
      expect(valueOf(argv, flag), `${flag} missing from ${argv.join(' ')}`).not.toBeNull();
    }
  });

  it('sends the symbol and side it was given', () => {
    const argv = client().argv(ORDER, false);
    expect(valueOf(argv, '--symbol')).toBe('RCOINUSDT');
    expect(valueOf(argv, '--side')).toBe('buy');
  });

  it('defaults the category to SPOT, which is where the rTokens actually are', () => {
    // Measured, not assumed: `market --action tickers --category SPOT --symbol
    // RCOINUSDT` returned a price, and the same call against USDT-FUTURES
    // returned "Trading pair RCOINUSDT does not exist".
    expect(valueOf(client().argv(ORDER, false), '--category')).toBe('SPOT');
  });

  it('takes the category from the environment when one is set', () => {
    const argv = client({ BGC_CATEGORY: 'MARGIN' }).argv(ORDER, false);
    expect(valueOf(argv, '--category')).toBe('MARGIN');
  });
});

describe('the flags that did not exist', () => {
  it('never emits --notional-usdt', () => {
    // Not a flag the CLI has. Its `qty` description is the only size parameter,
    // and it is typed as a string.
    expect(client().argv(ORDER, false)).not.toContain('--notional-usdt');
  });

  it('never emits --json', () => {
    // JSON is the CLI's default output; `--pretty` is the modifier. The old
    // builder appended this to every single order.
    expect(client().argv(ORDER, false)).not.toContain('--json');
  });

  it('keeps --paper-trading and --dry-run, which were spelled correctly', () => {
    // The failure was not uniform, and saying "it was all wrong" would be as
    // misleading as saying it was fine.
    const argv = client({ BGC_DRY_RUN: 'true' }).argv(ORDER, false);
    expect(argv).toContain('--paper-trading');
    expect(argv).toContain('--dry-run');
  });
});

describe('the size parameter, whose unit depends on the side', () => {
  it('sends the notional directly for a market BUY, where qty is quote coin', () => {
    const argv = client().argv(ORDER, false);
    expect(valueOf(argv, '--qty')).toBe('50.00000000');
  });

  it('divides by the price for a market SELL, where qty is base coin', () => {
    // Sending the USDT figure here would size the order at notional × price:
    // a 50 USDT order becoming 5,000 USDT of an asset trading at 100 — and the
    // guard would have approved the 50 it was shown.
    const argv = client().argv({ ...ORDER, side: 'sell' }, false);
    expect(valueOf(argv, '--qty')).toBe('0.50000000');
  });

  it('is a decimal string, never exponent notation', () => {
    // The CLI types qty as a string, and this is where a division produces a
    // small number: 0.00001 USDT at a price of 100 is 1e-7 of the asset, and
    // String(1e-7) is the literal text "1e-7", which the CLI cannot parse as a
    // quantity. `toFixed(8)` is what keeps it a decimal.
    const argv = client().argv(
      { ...ORDER, side: 'sell', notional_usdt: 0.00001, entry_price: 100 },
      false,
    );
    const qty = valueOf(argv, '--qty');
    expect(qty).not.toContain('e');
    expect(qty).toBe('0.00000010');
  });

  it('refuses a SELL it cannot size rather than sending a wrong-sized one', () => {
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => client().argv({ ...ORDER, side: 'sell', entry_price: price }, false)).toThrow(
        /refusing to size a SELL/,
      );
    }
  });
});

describe('the confirm flag', () => {
  it('is absent on the unconfirmed phase and present on the confirmed one', () => {
    // So that the argv in a log says which phase it was, without reference to
    // anything else. This is the project's own two-phase contract, not the
    // CLI's — see the next test.
    expect(client().argv(ORDER, false)).not.toContain('--confirm');
    expect(client().argv(ORDER, true)).toContain('--confirm');
  });

  it('is recorded as NOT being the CLI\'s two-phase contract', () => {
    // `bgc discover --tool order --action place` reports requiresConfirm:false
    // for place, and the dry-run probes returned no confirmationRequired. So
    // the CLI places on the first call and would never ask. Passing --confirm
    // is tolerated (verified) but no safety property depends on it, and the
    // comment in buildArgv says so. If that comment is ever deleted, this test
    // is the thing that still records the finding.
    const dryRun = client().parse(
      JSON.stringify({
        endpoint: 'POST /api/v3/trade/place-order',
        data: { dryRun: true, operationId: 'placeOrder', wouldSend: { symbol: 'RCOINUSDT' } },
      }),
      0,
    );
    expect(dryRun.confirmationRequired).toBe(false);
  });
});

describe("the CLI's real envelopes, copied from run 35264648127", () => {
  it('reads the error envelope as a refusal, not as a placement', () => {
    // Verbatim stdout from `market --action tickers --category USDT-FUTURES
    // --symbol RCOINUSDT`, exit 1. The old parser looked for a flat `success`
    // or `status` field, found neither, and reported the generic "could not
    // parse" — losing the one sentence that says what was wrong.
    const stdout = JSON.stringify({
      ok: false,
      error: {
        type: 'BitgetApiError',
        code: '400',
        category: 'unknown',
        message: 'HTTP 400 from Bitget: Trading pair RCOINUSDT does not exist',
        suggestion: 'Retry later or verify endpoint parameters.',
        retryable: false,
        endpoint: 'GET /api/v3/market/tickers',
      },
      timestamp: '2026-09-17T19:24:09.140Z',
    });
    const result = client().parse(stdout, 1);
    expect(result.accepted).toBe(false);
    expect(result.orderId).toBeNull();
    expect(result.detail).toContain('Trading pair RCOINUSDT does not exist');
  });

  it('reads a dry run as a PREVIEW, not as an accepted order', () => {
    // This is the one that matters most. A dry run returns a success-shaped
    // body — exit 0, no error — for an order that was never sent. Reading it as
    // accepted would make BGC_DRY_RUN, a setting whose whole purpose is to not
    // place orders, look like working execution in every log and on every
    // screen.
    const stdout = JSON.stringify({
      endpoint: 'POST /api/v3/trade/place-order',
      requestTime: '2026-09-17T19:24:09.227Z',
      data: {
        dryRun: true,
        operationId: 'placeOrder',
        method: 'POST',
        path: '/api/v3/trade/place-order',
        riskLevel: 'write',
        wouldSend: {
          category: 'SPOT',
          symbol: 'RCOINUSDT',
          side: 'buy',
          orderType: 'market',
          qty: '10',
          clientOid: 'bd765d87-f650-493b-85d8-6bf9e2203f43',
        },
      },
    });
    const result = client().parse(stdout, 0);
    expect(result.accepted).toBe(false);
    expect(result.orderId).toBeNull();
    expect(result.detail).toContain('DRY RUN');
    expect(result.detail).toContain('RCOINUSDT');
  });

  it('does not read data.orderId out of an envelope whose data is an object', () => {
    // The old code did `parsed['data']` as a candidate for the order id. In the
    // real envelope `data` is an object, so it could never have been a string
    // and the branch was dead — but a `data` that HAPPENED to be a string would
    // have been reported as an order id with no evidence behind it.
    const result = client().parse(
      JSON.stringify({ endpoint: 'POST /x', data: { dryRun: true, wouldSend: {} } }),
      0,
    );
    expect(result.orderId).toBeNull();
  });

  it('falls back to NOT accepted on output it does not recognise', () => {
    // The property the module rests on: an unrecognised shape is never a
    // claimed order. A CLI change must not be able to turn every parse failure
    // into a placement.
    const result = client().parse(JSON.stringify({ somethingNew: 'entirely' }), 0);
    expect(result.accepted).toBe(false);
    expect(result.orderId).toBeNull();
  });
});

describe('the capability banner', () => {
  const FULL_CREDS = {
    BITGET_API_KEY: 'k',
    BITGET_SECRET_KEY: 's',
    BITGET_PASSPHRASE: 'p',
  };

  it('names the credential variables the CLI actually reads', () => {
    // `bgc --help` prints: "Auth (environment variables): BITGET_API_KEY,
    // BITGET_SECRET_KEY, BITGET_PASSPHRASE". The banner used to name
    // BITGET_API_SECRET and BITGET_API_PASSPHRASE, which no version of the CLI
    // reads — so it told a reader to set two names that could not have
    // satisfied it, and would have gone on saying so after they were set.
    const cap = describeCapability(loadAgentHubConfig({}), {});
    expect(cap.detail).toContain('BITGET_SECRET_KEY');
    expect(cap.detail).toContain('BITGET_PASSPHRASE');
    expect(cap.detail).not.toContain('BITGET_API_SECRET');
    expect(cap.detail).not.toContain('BITGET_API_PASSPHRASE');
  });

  it('does not call execution available without a CLI it can find', () => {
    // All three switches have to be on, and "a bgc binary that actually exists"
    // is one of them. A report saying execution is available while also saying
    // the binary is missing would contradict itself on one line.
    const env = { ...FULL_CREDS, BITGET_PAPER_TRADING: 'true', ENABLE_EXECUTION: 'true' };
    const cap = describeCapability(loadAgentHubConfig(env), env);
    expect(cap.available).toBe(false);
    expect(cap.detail).toContain('no "bgc" on PATH');
  });

  it('finds a CLI at an explicit path, and says where', () => {
    // The old probe asked existsSync("bgc"), which is false for every bare
    // name, so it reported "not found" whatever was installed.
    const env = {
      ...FULL_CREDS,
      BITGET_PAPER_TRADING: 'true',
      ENABLE_EXECUTION: 'true',
      BGC_CLI_PATH: process.execPath,
    };
    const cap = describeCapability(loadAgentHubConfig(env), env);
    expect(cap.available).toBe(true);
    expect(cap.detail).toContain('CLI found at');
  });

  it('separates the verified request from the unverified placement', () => {
    // The banner must not carry a blanket disclaimer over the parts that were
    // checked, nor claim a placement that never happened. Both halves are
    // asserted, because either one alone would let the other drift.
    const cap = describeCapability(loadAgentHubConfig({}), {});
    expect(cap.detail).toContain('IS verified');
    expect(cap.detail).toContain('3.0.0');
    expect(cap.detail).toContain('NOT verified');
    expect(cap.unverified).toBe(true);
  });
});
