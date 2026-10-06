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
  /** CoinMarketCap API key. Empty/absent means "not configured". */
  apiKey?: string;
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
const COINGECKO_BASE_URL = 'https://api.coingecko.com';
/** CoinGecko id for Zcash. */
const COINGECKO_ID = 'zcash';

/** Parse an optional provider timestamp into a canonical ISO string. */
function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

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
 * Shared machinery for HTTP price providers: caching, request timeouts, and
 * mapping transport/HTTP failures to {@link PriceUnavailableError}. Subclasses
 * supply the request (URL + headers) and the payload extractor.
 */
abstract class HttpPriceProvider implements ZecUsdPriceProvider {
  abstract readonly name: string;
  protected readonly cacheTtlMs: number;
  protected readonly timeoutMs: number;
  protected readonly fetchImpl: typeof fetch;
  protected readonly now: () => number;
  private cache: { price: ZecUsdPrice; expiresAt: number } | null = null;

  constructor(options: PriceProviderOptions) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /** Provider-specific request: the URL and any authentication headers. */
  protected abstract request(): { url: string; headers: Record<string, string> };
  /** Provider-specific payload decoding. */
  protected abstract extract(payload: unknown): ZecUsdPrice;

  async getZecUsdPrice(): Promise<ZecUsdPrice> {
    const cached = this.cache;
    if (cached && cached.expiresAt > this.now()) return cached.price;

    const { url, headers } = this.request();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    } catch (err) {
      // Never surface credentials or the raw URL: only a short, safe message.
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
}

/**
 * CoinMarketCap ZEC/USD price provider.
 *
 * Uses the Quotes Latest endpoint (`/v3/cryptocurrency/quotes/latest`) with
 * `id=328` (Zcash) and `convert=USD`. Requires a server-side API key.
 */
export class CoinMarketCapPriceProvider extends HttpPriceProvider {
  readonly name: string;
  private readonly apiKey: string;

  constructor(options: PriceProviderOptions) {
    super(options);
    this.name = options.provider ?? 'coinmarketcap';
    this.apiKey = (options.apiKey ?? '').trim();
  }

  override async getZecUsdPrice(): Promise<ZecUsdPrice> {
    if (!this.apiKey) {
      throw new PriceUnavailableError(
        'COINMARKETCAP_API_KEY is not configured; cannot obtain a live ZEC/USD price',
        'not_configured',
      );
    }
    return super.getZecUsdPrice();
  }

  protected request(): { url: string; headers: Record<string, string> } {
    return {
      url: `${CMC_BASE_URL}/v3/cryptocurrency/quotes/latest?id=${ZEC_ID}&convert=USD`,
      headers: { 'X-CMC_PRO_API_KEY': this.apiKey, accept: 'application/json' },
    };
  }

  /** Pull the ZEC/USD price out of a CoinMarketCap Quotes Latest payload. */
  protected extract(payload: unknown): ZecUsdPrice {
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
    const observedAt = parseTimestamp((usd as { last_updated?: unknown }).last_updated);

    return { provider: this.name, asset: 'ZEC', quote: 'USD', price, observedAt };
  }
}

/**
 * CoinGecko ZEC/USD price provider.
 *
 * Uses the public `simple/price` endpoint. It needs no API key, so a deployment
 * can offer USD-denominated requests without provisioning a secret. The public
 * tier is rate-limited; every failure is surfaced as an error, never a
 * fabricated price.
 */
export class CoinGeckoPriceProvider extends HttpPriceProvider {
  readonly name = 'coingecko';

  protected request(): { url: string; headers: Record<string, string> } {
    return {
      url: `${COINGECKO_BASE_URL}/api/v3/simple/price?ids=${COINGECKO_ID}&vs_currencies=usd&include_last_updated_at=true`,
      headers: { accept: 'application/json' },
    };
  }

  /** Pull the ZEC/USD price out of a CoinGecko simple/price payload. */
  protected extract(payload: unknown): ZecUsdPrice {
    const entry =
      payload && typeof payload === 'object'
        ? (payload as Record<string, { usd?: unknown; last_updated_at?: unknown }>)[COINGECKO_ID]
        : undefined;
    if (!entry || typeof entry !== 'object') {
      throw new PriceUnavailableError('price provider response did not contain ZEC', 'bad_response');
    }
    const price = normalizePrice(entry.usd);
    const observedAt =
      typeof entry.last_updated_at === 'number' && Number.isFinite(entry.last_updated_at)
        ? new Date(entry.last_updated_at * 1000).toISOString()
        : null;
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
  BLINK_PRICE_PROVIDER: 'none' | 'coinmarketcap' | 'coingecko';
  COINMARKETCAP_API_KEY: string;
  BLINK_PRICE_CACHE_TTL_MS: number;
  BLINK_PRICE_TIMEOUT_MS: number;
}

export function createZecUsdPriceProvider(
  config: PriceConfig,
  overrides: Partial<PriceProviderOptions> = {},
): ZecUsdPriceProvider {
  const shared = {
    cacheTtlMs: config.BLINK_PRICE_CACHE_TTL_MS,
    timeoutMs: config.BLINK_PRICE_TIMEOUT_MS,
    ...overrides,
  };
  if (config.BLINK_PRICE_PROVIDER === 'coinmarketcap') {
    return new CoinMarketCapPriceProvider({ apiKey: config.COINMARKETCAP_API_KEY, ...shared });
  }
  if (config.BLINK_PRICE_PROVIDER === 'coingecko') {
    return new CoinGeckoPriceProvider(shared);
  }
  return new DisabledPriceProvider();
}
