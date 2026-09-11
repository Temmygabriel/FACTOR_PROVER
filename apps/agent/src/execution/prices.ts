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
