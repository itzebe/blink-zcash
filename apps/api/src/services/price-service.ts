/**
 * ZEC/USD price source.
 *
 * BLINK lets a recipient denominate a request in USD and settles in ZEC, so the
 * API needs a live ZEC/USD rate at request-creation time. The rate is fetched
 * server-side from CoinMarketCap and normalized into {@link ZecUsdPrice}; the
 * raw provider payload never leaves this module.
 *
 * Design rules:
 *  * The API key is read from the environment (`COINMARKETCAP_API_KEY`) and is
 *    never returned, logged, or placed in a URL/QR.
 *  * A price is only ever a real observation. There is no fallback price: if the
 *    provider is unreachable, misconfigured, rate-limited, or returns a
 *    malformed/zero/negative value, a {@link PriceUnavailableError} is thrown and
 *    the request is refused. BLINK never invents a rate.
 *  * Successful observations are cached briefly to absorb bursts, but a cache
 *    entry is never used to "fix up" a request later — the conversion is stored
 *    on the request itself (see the price snapshot in the payment service).
 */
import { formatUsdPrice, parseUsdPrice, type ZecUsdPrice } from '@blink/shared';

/** Raised when a live price cannot be obtained. Carries a stable `code`. */
export class PriceUnavailableError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'PriceUnavailableError';
  }
}

export interface ZecUsdPriceProvider {
  readonly name: string;
  /** Return the current ZEC/USD price, or throw {@link PriceUnavailableError}. */
  getZecUsdPrice(): Promise<ZecUsdPrice>;
}

export interface PriceProviderOptions {
  /** CoinMarketCap API key. Empty means "not configured". */
  apiKey: string;
  /** Provider id to report. Defaults to "coinmarketcap". */
  provider?: string;
  /** How long a successful observation may be reused, in ms. */
  cacheTtlMs?: number;
  /** Per-request timeout, in ms. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
}

const CMC_BASE_URL = 'https://pro-api.coinmarketcap.com';
/** CoinMarketCap id for Zcash. */
const ZEC_ID = '328';

/**
 * Normalize a provider-supplied price into a canonical decimal string.
 *
 * The provider returns a JSON number; `toFixed(8)` gives a bounded decimal
 * expansion (avoiding `1e-7`-style strings) which we then canonicalize. Values
 * that are not finite and positive are rejected.
 */
function normalizePrice(value: unknown): string {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) {
    throw new PriceUnavailableError('price provider returned a non-positive price', 'invalid_price');
  }
  const fixed = numeric.toFixed(8);
  const scaled = parseUsdPrice(fixed); // canonicalizes and re-validates > 0
  return formatUsdPrice(scaled);
}

/**
 * CoinMarketCap ZEC/USD price provider.
 *
 * Uses the Quotes Latest endpoint (`/v3/cryptocurrency/quotes/latest`) with
 * `id=328` (Zcash) and `convert=USD`.
 */
export class CoinMarketCapPriceProvider implements ZecUsdPriceProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cache: { price: ZecUsdPrice; expiresAt: number } | null = null;

  constructor(options: PriceProviderOptions) {
    this.name = options.provider ?? 'coinmarketcap';
    this.apiKey = options.apiKey.trim();
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  async getZecUsdPrice(): Promise<ZecUsdPrice> {
    if (!this.apiKey) {
      throw new PriceUnavailableError(
        'COINMARKETCAP_API_KEY is not configured; cannot obtain a live ZEC/USD price',
        'not_configured',
      );
    }

    const cached = this.cache;
    if (cached && cached.expiresAt > this.now()) return cached.price;

    const url = `${CMC_BASE_URL}/v3/cryptocurrency/quotes/latest?id=${ZEC_ID}&convert=USD`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'X-CMC_PRO_API_KEY': this.apiKey,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      // Never surface the key or the raw URL: only a short, safe message.
      const reason = err instanceof Error ? err.message : String(err);
      throw new PriceUnavailableError(`price provider unreachable: ${reason}`, 'unreachable');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new PriceUnavailableError('price provider rate limit reached', 'rate_limited');
    }
    if (res.status === 401 || res.status === 403) {
      throw new PriceUnavailableError('price provider rejected the API key', 'unauthorized');
    }
    if (!res.ok) {
      throw new PriceUnavailableError(`price provider returned HTTP ${res.status}`, 'provider_error');
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new PriceUnavailableError('price provider returned a non-JSON response', 'bad_response');
    }

    const observation = this.extract(payload);
    this.cache = { price: observation, expiresAt: this.now() + this.cacheTtlMs };
    return observation;
  }

  /** Pull the ZEC/USD price out of a CoinMarketCap Quotes Latest payload. */
  private extract(payload: unknown): ZecUsdPrice {
    const data =
      payload && typeof payload === 'object'
        ? (payload as { data?: Record<string, unknown> }).data
        : undefined;
    const zec = data?.[ZEC_ID];
    if (!zec || typeof zec !== 'object') {
      throw new PriceUnavailableError('price provider response did not contain ZEC', 'bad_response');
    }
    const quote = (zec as { quote?: Record<string, unknown> }).quote;
    const usd = quote?.USD;
    if (!usd || typeof usd !== 'object') {
      throw new PriceUnavailableError('price provider response had no USD quote', 'bad_response');
    }

    const price = normalizePrice((usd as { price?: unknown }).price);

    const rawTimestamp = (usd as { last_updated?: unknown }).last_updated;
    let observedAt: string | null = null;
    if (typeof rawTimestamp === 'string') {
      const parsed = Date.parse(rawTimestamp);
      if (!Number.isNaN(parsed)) observedAt = new Date(parsed).toISOString();
    }

    return { provider: this.name, asset: 'ZEC', quote: 'USD', price, observedAt };
  }
}

/** A provider that is deliberately disabled and reports so honestly. */
class DisabledPriceProvider implements ZecUsdPriceProvider {
  readonly name = 'none';
  async getZecUsdPrice(): Promise<ZecUsdPrice> {
    throw new PriceUnavailableError(
      'BLINK_PRICE_PROVIDER is not configured; USD requests are unavailable',
      'not_configured',
    );
  }
}

export interface PriceConfig {
  BLINK_PRICE_PROVIDER: 'none' | 'coinmarketcap';
  COINMARKETCAP_API_KEY: string;
  BLINK_PRICE_CACHE_TTL_MS: number;
  BLINK_PRICE_TIMEOUT_MS: number;
}

export function createZecUsdPriceProvider(
  config: PriceConfig,
  overrides: Partial<PriceProviderOptions> = {},
): ZecUsdPriceProvider {
  if (config.BLINK_PRICE_PROVIDER !== 'coinmarketcap') {
    return new DisabledPriceProvider();
  }
  return new CoinMarketCapPriceProvider({
    apiKey: config.COINMARKETCAP_API_KEY,
    cacheTtlMs: config.BLINK_PRICE_CACHE_TTL_MS,
    timeoutMs: config.BLINK_PRICE_TIMEOUT_MS,
    ...overrides,
  });
}
