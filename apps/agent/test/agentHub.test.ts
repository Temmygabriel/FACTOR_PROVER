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
import type { SpotPrecision } from '../src/execution/prices.js';

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
  buildArgv(order: OrderIntent, opts: { confirm: boolean }, precision: SpotPrecision): string[];
  parseResult(
    stdout: string,
    stderr: string,
    exitCode: number,
    opts: { confirm: boolean },
  ): BgcOrderResult;
};

/**
 * Instrument precisions, MEASURED from the live venue rather than invented.
 *
 * Read from `GET https://api.bitget.com/api/v2/spot/public/symbols?symbol=…` on
 * 2026-09-20, which is the same public endpoint `fetchSpotPrecision` calls:
 *
 *   RGOOGLUSDT  quantityPrecision 4   quotePrecision 6
 *   BTCUSDT     quantityPrecision 6   quotePrecision 8
 *
 * The two numbers differ, and they differ in OPPOSITE directions between the
 * two instruments — which is the whole reason `qty` cannot be formatted with a
 * constant. `RGOOGL` is the default here because the project's own targets are
 * rTokens and this is a real rToken's real precision.
 */
const RGOOGL: SpotPrecision = {
  symbol: 'RGOOGLUSDT',
  quantityPrecision: 4,
  quotePrecision: 6,
  pricePrecision: 2,
  minTradeUsdt: 10,
  fetched_at: '2026-09-20T17:00:00Z',
};

const BTC: SpotPrecision = {
  symbol: 'BTCUSDT',
  quantityPrecision: 6,
  quotePrecision: 8,
  pricePrecision: 2,
  minTradeUsdt: 1,
  fetched_at: '2026-09-20T17:00:00Z',
};

class ArgvOnly extends BgcAgentHubClient {
  argv(order: OrderIntent, confirm: boolean, precision: SpotPrecision = RGOOGL): string[] {
    const self = this as unknown as Internals;
    return self.buildArgv.call(this, order, { confirm }, precision);
  }

  parse(stdout: string, exitCode: number, confirm = false, stderr = ''): BgcOrderResult {
    const self = this as unknown as Internals;
    return self.parseResult.call(this, stdout, stderr, exitCode, { confirm });
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
    // Formatted to the instrument's quotePrecision — 6 for RGOOGLUSDT. This
    // read '50.00000000' while the code hardcoded `toFixed(8)`; the value was
    // right in MAGNITUDE and wrong in SCALE, and the venue checks the scale.
    const argv = client().argv(ORDER, false);
    expect(valueOf(argv, '--qty')).toBe('50.000000');
  });

  it('divides by the price for a market SELL, where qty is base coin', () => {
    // Sending the USDT figure here would size the order at notional × price:
    // a 50 USDT order becoming 5,000 USDT of an asset trading at 100 — and the
    // guard would have approved the 50 it was shown.
    const argv = client().argv({ ...ORDER, side: 'sell' }, false);
    expect(valueOf(argv, '--qty')).toBe('0.5000');
  });

  it('is a decimal string, never exponent notation', () => {
    // The CLI types qty as a string, and this is where a division produces a
    // small number: 0.00001 USDT at a price of 100 is 1e-7 of the asset, and
    // String(1e-7) is the literal text "1e-7", which the CLI cannot parse as a
    // quantity. `toFixed` is what keeps it a decimal.
    //
    // Eight decimals is stated explicitly here because it is the only precision
    // at which a 1e-7 quantity is expressible at all. At RGOOGLUSDT's real
    // precision of 4 this quantity truncates to zero and is refused — which is
    // the subject of the truncation tests below, not of this one.
    const eightDp: SpotPrecision = { ...RGOOGL, quantityPrecision: 8 };
    const argv = client().argv(
      { ...ORDER, side: 'sell', notional_usdt: 0.00001, entry_price: 100 },
      false,
      eightDp,
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

describe('the PRECISION of qty, which is per instrument and per side', () => {
  // This whole block exists because of one real refusal. Run 35527828818 sent a
  // fundable BTCUSDT sell on the correct side and Bitget answered:
  //
  //   HTTP 400 from Bitget: Parameter verification exception
  //   size checkBDScale error value=0.00123304 checkScale=6
  //
  // The quantity was right and carried 8 decimals; the instrument allows 6. A
  // `toFixed(8)` constant had been in the code with a comment asserting 8 was
  // "the base-coin precision Bitget uses". It never was.

  it("formats a SELL to the instrument's quantityPrecision, not to a constant", () => {
    const argv = client().argv(
      { ...ORDER, symbol: 'BTCUSDT', side: 'sell', notional_usdt: 100, entry_price: 81_000 },
      false,
      BTC,
    );
    // 100 / 81000 = 0.001234567… and BTCUSDT allows 6 decimals.
    expect(valueOf(argv, '--qty')).toBe('0.001234');
  });

  it("formats a BUY to the instrument's quotePrecision, which is the other number", () => {
    const argv = client().argv(
      { ...ORDER, symbol: 'BTCUSDT', side: 'buy', notional_usdt: 50 },
      false,
      BTC,
    );
    // quotePrecision is 8 where quantityPrecision is 6, so the same instrument
    // wants a different scale depending on which way the order goes.
    expect(valueOf(argv, '--qty')).toBe('50.00000000');
  });

  it('rounds DOWN, so the order sent is never LARGER than the one the guard approved', () => {
    // The notional here was approved at CHECK 3. Rounding to nearest would give
    // 0.001235 — more base coin than the notional allows. Truncation gives
    // 0.001234, and truncation can only ever send less.
    const argv = client().argv(
      { ...ORDER, symbol: 'BTCUSDT', side: 'sell', notional_usdt: 0.0012349, entry_price: 1 },
      false,
      BTC,
    );
    expect(valueOf(argv, '--qty')).toBe('0.001234');
  });

  it("refuses an order whose quantity truncates to zero at the venue's precision", () => {
    // Silently sending this would put a zero quantity on the wire and produce a
    // refusal the log could not explain. 1e-7 truncates to 0 at 4 decimals.
    expect(() =>
      client().argv(
        { ...ORDER, side: 'sell', notional_usdt: 0.00001, entry_price: 100 },
        false,
        RGOOGL,
      ),
    ).toThrow(/truncates to 0/);
  });

  it('uses no single constant for both instruments', () => {
    // The regression guard. If someone reinstates a fixed number of decimals,
    // these two calls agree and this fails.
    const rTokenSell = valueOf(
      client().argv({ ...ORDER, side: 'sell', notional_usdt: 100, entry_price: 81_000 }, false, RGOOGL),
      '--qty',
    );
    const btcSell = valueOf(
      client().argv(
        { ...ORDER, symbol: 'BTCUSDT', side: 'sell', notional_usdt: 100, entry_price: 81_000 },
        false,
        BTC,
      ),
      '--qty',
    );
    expect(rTokenSell).not.toBe(btcSell);
    expect(rTokenSell?.split('.')[1]).toHaveLength(4);
    expect(btcSell?.split('.')[1]).toHaveLength(6);
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

describe('the refusal envelope, which arrives on STDERR', () => {
  // The third thing a real placement taught this module, on 2026-09-20.
  //
  // Every fixture in the block above puts its body on stdout, because that is
  // where the two envelopes seen on 2026-09-17 came from. When orders were
  // finally SENT for real (run 35527828818), both refusals came back with EMPTY
  // stdout, exit 1, and the JSON envelope on stderr. `parseResult` read stdout
  // only, so its error branch was unreachable for a real refusal and every one
  // fell through to "the CLI returned no output".
  //
  // The bodies below are verbatim from `logs/paper-live.jsonl`.

  const RWA_REFUSAL = JSON.stringify({
    ok: false,
    error: {
      type: 'BitgetApiError',
      code: '400',
      category: 'unknown',
      message: 'HTTP 400 from Bitget: papTradingService not support RWA order validation error',
      suggestion: 'Retry later or verify endpoint parameters.',
      retryable: false,
      endpoint: 'POST /api/v3/trade/place-order',
    },
    timestamp: '2026-09-20T18:04:21.174Z',
  });

  it('reads a refusal that arrived on stderr, with stdout empty', () => {
    const result = client().parse('', 1, false, RWA_REFUSAL);
    expect(result.accepted).toBe(false);
    expect(result.orderId).toBeNull();
    // The whole point: the structured message survives. Before the fix this
    // read "the CLI returned no output (exit 1); stderr: {…" cut off at 300
    // characters, so the sentence naming the cause was present by luck and the
    // one naming the endpoint never was.
    expect(result.detail).toContain('papTradingService not support RWA');
    expect(result.detail).toContain('the CLI refused the order');
  });

  it('reads the scale refusal too, which names the exact defect', () => {
    const result = client().parse(
      '',
      1,
      false,
      JSON.stringify({
        ok: false,
        error: {
          type: 'BitgetApiError',
          code: '400',
          message:
            'HTTP 400 from Bitget: Parameter verification exception size checkBDScale error ' +
            'value=0.00123304 checkScale=6',
          endpoint: 'POST /api/v3/trade/place-order',
        },
      }),
    );
    expect(result.accepted).toBe(false);
    expect(result.detail).toContain('checkBDScale');
    expect(result.detail).toContain('checkScale=6');
  });

  it('prefers stdout when BOTH streams carry something', () => {
    // stderr is consulted only when stdout is empty. A CLI that writes progress
    // chatter to stderr beside a good stdout must not have that chatter read as
    // the result — which is why this is a fallback and not a concatenation.
    const result = client().parse(
      JSON.stringify({
        endpoint: 'POST /api/v3/trade/place-order',
        data: { dryRun: true, wouldSend: { symbol: 'BTCUSDT' } },
      }),
      0,
      false,
      'warning: some chatter\n',
    );
    expect(result.detail).toContain('DRY RUN');
    expect(result.detail).not.toContain('chatter');
  });

  it('still reports no output when neither stream has any', () => {
    const result = client().parse('', 1, false, '');
    expect(result.detail).toContain('no output on either stream');
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

  it('separates the verified request from the still-unverified FILL', () => {
    // The banner must not carry a blanket disclaimer over the parts that were
    // checked, nor claim more than the evidence supports. Both halves are
    // asserted, because either one alone would let the other drift.
    //
    // WHAT CHANGED, AND WHY THIS TEST HAD TO. It used to assert
    // `unverified === true` with the reason "no accepted placement has ever
    // been observed". On 2026-09-21 that stopped being true: run 35627286184
    // placed a BTCUSDT sell and the venue returned order id
    // 1485970832289546240. Leaving the assertion alone would have been the
    // mirror of the original bug — a banner confidently reporting a state the
    // evidence had moved past.
    //
    // The claim narrows rather than disappears. Acceptance is evidenced; a FILL
    // is not, because an order id is not a trade. And the promoted order is
    // still refused as an RWA instrument, which the banner must keep saying
    // even though a different instrument succeeded — that is the sentence most
    // at risk of being quietly dropped now that something works.
    const cap = describeCapability(loadAgentHubConfig({}), {});
    expect(cap.detail).toContain('IS verified');
    expect(cap.detail).toContain('3.0.0');
    expect(cap.detail).toContain('NOT verified');
    expect(cap.detail).toContain('FILL');
    expect(cap.detail).toContain('1485970832289546240');
    expect(cap.detail).toContain('RWA');
    // The retracted claim, asserted absent so it cannot come back by accident.
    expect(cap.detail).not.toContain('No order has ever been');
    expect(cap.unverified).toBe(false);
  });
});
