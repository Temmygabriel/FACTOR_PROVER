/**
 * Live spot price lookup, for Execution Guard CHECK 4.
 *
 * Isolated in its own module for one reason: the guard must be testable without
 * a network. The guard takes a price source as a dependency, so tests inject a
 * fixed price and the sanity-band logic is exercised deterministically instead
 * of depending on what the market happened to be doing.
 *
 * Public endpoint — no API key required.
 */

const BASE = 'https://api.bitget.com';

export interface PriceQuote {
  symbol: string;
  /** Last traded price in USDT, as a number. */
  price: number;
  /** The raw string from the API, kept so a parse problem is visible. */
  raw: string;
  fetched_at: string;
}

interface TickerResponse {
  code?: string;
  msg?: string;
  data?: Array<Record<string, string>>;
}

export class PriceUnavailableError extends Error {
  symbol: string;
  constructor(symbol: string, message: string) {
    super(message);
    this.name = 'PriceUnavailableError';
    this.symbol = symbol;
  }
}

/**
 * Fetch the last price for a spot symbol.
 *
 * Throws rather than returning a sentinel. A caller that needs a price and gets
 * one it cannot distinguish from "zero" or "missing" is a caller that could
 * approve an order against a bad number, and CHECK 4 exists precisely to stop
 * orders going out against bad numbers.
 */
export async function fetchSpotPrice(symbol: string, timeoutMs = 10_000): Promise<PriceQuote> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE}/api/v2/spot/market/tickers?symbol=${encodeURIComponent(symbol)}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new PriceUnavailableError(symbol, `ticker request failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as TickerResponse;
    const row = body.data?.[0];

    if (!row) {
      throw new PriceUnavailableError(
        symbol,
        `ticker returned no data (code ${body.code ?? '?'}${body.msg ? `, ${body.msg}` : ''})`,
      );
    }

    // Bitget names this field differently across spot/mix endpoints; accept the
    // known spellings rather than assuming one and silently reading undefined.
    const raw = row['lastPr'] ?? row['close'] ?? row['last'] ?? '';
    const price = Number(raw);

    if (!raw || !Number.isFinite(price) || price <= 0) {
      throw new PriceUnavailableError(
        symbol,
        `ticker price was not a positive number: ${JSON.stringify(raw)}`,
      );
    }

    return {
      symbol,
      price,
      raw,
      fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  } catch (err) {
    if (err instanceof PriceUnavailableError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new PriceUnavailableError(symbol, `ticker request timed out after ${timeoutMs}ms`);
    }
    throw new PriceUnavailableError(
      symbol,
      `ticker request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Instrument precision
// ---------------------------------------------------------------------------

/**
 * The decimal places an instrument will accept, and its minimum order size.
 *
 * WHY THIS IS HERE AND WHY IT HAD TO BE ADDED. `qty` does not mean one thing —
 * market BUY takes it in QUOTE coin, market SELL in BASE coin (see `qtyFor` in
 * agentHub.ts) — and the two are not allowed the same number of decimals. The
 * client formatted both with `toFixed(8)` and its comment asserted 8 was "the
 * base-coin precision Bitget uses".
 *
 * That assertion was false, and a real order proved it. On 2026-09-20 the
 * venue refused a BTCUSDT sell with:
 *
 *   Parameter verification exception size checkBDScale error
 *   value=0.00123304 checkScale=6
 *
 * The notional was fundable and the side was right; the order died on decimal
 * places. The public endpoint answers with both numbers, and they differ in
 * both directions from the constant that was hardcoded:
 *
 *   BTCUSDT     quantityPrecision 6   quotePrecision 8
 *   RGOOGLUSDT  quantityPrecision 4   quotePrecision 6
 *
 * So `toFixed(8)` happened to be correct for a BTCUSDT BUY, wrong for a
 * BTCUSDT SELL, and wrong for an RGOOGLUSDT buy as well — the rToken just
 * never got far enough to say so, because it is refused as RWA first. A
 * constant could not have been picked to be right; the number is a property of
 * the instrument and has to be read from the instrument.
 *
 * Public endpoint, no API key — same as the ticker above, and kept in this
 * module for the same reason.
 */
export interface SpotPrecision {
  symbol: string;
  /** Decimals allowed on the BASE-coin quantity. What `qty` means for a SELL. */
  quantityPrecision: number;
  /** Decimals allowed on the QUOTE-coin amount. What `qty` means for a BUY. */
  quotePrecision: number;
  pricePrecision: number;
  /** Smallest order this instrument accepts, in USDT. */
  minTradeUsdt: number;
  fetched_at: string;
}

export class PrecisionUnavailableError extends Error {
  symbol: string;
  constructor(symbol: string, message: string) {
    super(message);
    this.name = 'PrecisionUnavailableError';
    this.symbol = symbol;
  }
}

/**
 * Read an instrument's precision.
 *
 * Throws rather than returning a default. A default here is exactly the bug
 * being fixed: any constant is wrong for some instrument, and the failure it
 * causes is a refused order at best. A caller that cannot learn the precision
 * must not place the order.
 */
export async function fetchSpotPrecision(
  symbol: string,
  timeoutMs = 10_000,
): Promise<SpotPrecision> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `${BASE}/api/v2/spot/public/symbols?symbol=${encodeURIComponent(symbol)}`,
      { headers: { accept: 'application/json' }, signal: controller.signal },
    );

    if (!res.ok) {
      throw new PrecisionUnavailableError(symbol, `instrument request failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as {
      code?: string;
      msg?: string;
      data?: Array<Record<string, string>>;
    };
    const row = body.data?.[0];

    if (!row) {
      throw new PrecisionUnavailableError(
        symbol,
        `instrument lookup returned no data (code ${body.code ?? '?'}` +
          `${body.msg ? `, ${body.msg}` : ''}) — the symbol may not be tradable in SPOT`,
      );
    }

    // Parsed as integers, and checked, rather than trusted. These arrive as
    // strings and reach `toFixed`, where a NaN would produce the literal
    // "NaN" as an order quantity.
    const int = (field: string): number => {
      const n = Number(row[field]);
      if (!Number.isInteger(n) || n < 0) {
        throw new PrecisionUnavailableError(
          symbol,
          `${field} was not a non-negative integer: ${JSON.stringify(row[field])}`,
        );
      }
      return n;
    };

    return {
      symbol,
      quantityPrecision: int('quantityPrecision'),
      quotePrecision: int('quotePrecision'),
      pricePrecision: int('pricePrecision'),
      minTradeUsdt: Number(row['minTradeUSDT'] ?? 0) || 0,
      fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  } catch (err) {
    if (err instanceof PrecisionUnavailableError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new PrecisionUnavailableError(symbol, `instrument request timed out after ${timeoutMs}ms`);
    }
    throw new PrecisionUnavailableError(
      symbol,
      `instrument request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
