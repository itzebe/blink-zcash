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
const ZEC_ID = '1437';
/** CoinMarketCap symbol for Zcash, asserted on the returned entry. */
const ZEC_SYMBOL = 'ZEC';
const COINGECKO_BASE_URL = 'https://api.coingecko.com';
/** CoinGecko id for Zcash. */
const COINGECKO_ID = 'zcash';
const COINBASE_BASE_URL = 'https://api.coinbase.com';

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
 * `id=1437` (Zcash) and `convert=USD`. Requires a server-side API key.
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

  /**
   * Pull the ZEC/USD price out of a CoinMarketCap Quotes Latest payload.
   *
   * CoinMarketCap has shipped two shapes for this endpoint: an id-keyed object
   * (`data["1437"].quote.USD`) and, on the v3 line, arrays (`data[0].quote[0]`).
   * Both are accepted, but the entry is only trusted when it actually identifies
   * ZEC and the quote actually identifies USD, so a mis-addressed id (the old
   * `id=328` returned Monero) can never be reported as a Zcash price.
   */
  protected extract(payload: unknown): ZecUsdPrice {
    const data =
      payload && typeof payload === 'object'
        ? (payload as { data?: unknown }).data
        : undefined;

    // Accept either `data` as an array of entries or as an id-keyed object.
    let entries: unknown[];
    if (Array.isArray(data)) {
      entries = data;
    } else if (data && typeof data === 'object') {
      const byId = (data as Record<string, unknown>)[ZEC_ID];
      entries = byId === undefined ? Object.values(data as Record<string, unknown>) : [byId];
    } else {
      entries = [];
    }

    const zec = entries.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const id = (entry as { id?: unknown }).id;
      const symbol = (entry as { symbol?: unknown }).symbol;
      // Trust by id when present, else by symbol; require the entry to name ZEC.
      if (id !== undefined && id !== null) return String(id) === ZEC_ID;
      return typeof symbol === 'string' && symbol.toUpperCase() === ZEC_SYMBOL;
    });
    if (!zec || typeof zec !== 'object') {
      throw new PriceUnavailableError('price provider response did not contain ZEC', 'bad_response');
    }

    const quoteRaw = (zec as { quote?: unknown }).quote;
    // The quote is either an object keyed by currency (`quote.USD`) or an array
    // of quotes each carrying their currency in `symbol`.
    let usd: unknown;
    if (Array.isArray(quoteRaw)) {
      usd = quoteRaw.find(
        (q) =>
          q &&
          typeof q === 'object' &&
          typeof (q as { symbol?: unknown }).symbol === 'string' &&
          (q as { symbol: string }).symbol.toUpperCase() === 'USD',
      );
    } else if (quoteRaw && typeof quoteRaw === 'object') {
      const keyed = quoteRaw as Record<string, unknown>;
      usd =
        keyed.USD ??
        Object.values(keyed).find(
          (q) =>
            q &&
            typeof q === 'object' &&
            typeof (q as { symbol?: unknown }).symbol === 'string' &&
            (q as { symbol: string }).symbol.toUpperCase() === 'USD',
        );
    }
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

/**
 * Coinbase ZEC/USD price provider.
 *
 * Uses the public spot-price endpoint, which needs no API key and has generous
 * unauthenticated limits, so a deployment can offer USD requests without
 * provisioning a secret. Every failure is surfaced, never a fabricated price.
 */
export class CoinbasePriceProvider extends HttpPriceProvider {
  readonly name = 'coinbase';

  protected request(): { url: string; headers: Record<string, string> } {
    return {
      url: `${COINBASE_BASE_URL}/v2/prices/ZEC-USD/spot`,
      headers: { accept: 'application/json' },
    };
  }

  /** Pull the ZEC/USD price out of a Coinbase spot-price payload. */
  protected extract(payload: unknown): ZecUsdPrice {
    const data =
      payload && typeof payload === 'object'
        ? (payload as { data?: { amount?: unknown; base?: unknown; currency?: unknown } }).data
        : undefined;
    if (!data || typeof data !== 'object') {
      throw new PriceUnavailableError('price provider response did not contain ZEC', 'bad_response');
    }
    if (data.base !== 'ZEC' || data.currency !== 'USD') {
      throw new PriceUnavailableError('price provider response was not a ZEC/USD quote', 'bad_response');
    }
    return {
      provider: this.name,
      asset: 'ZEC',
      quote: 'USD',
      price: normalizePrice(data.amount),
      // Coinbase's spot endpoint carries no timestamp; the moment we fetched it
      // is the observation time. Never invented, just recorded.
      observedAt: new Date(this.now()).toISOString(),
    };
  }
}

/**
 * Tries each provider in order and returns the first live observation. Providers
 * are independent live sources, not fallback values: a hard failure in one is
 * retried against the next, and if all fail the last error is thrown. No price
 * is ever invented. Used by the `auto` provider so a deployment with no
 * CoinMarketCap key still offers USD requests, and so one public source
 * rate-limiting the host does not take the whole flow down.
 */
export class ChainedPriceProvider implements ZecUsdPriceProvider {
  readonly name: string;

  constructor(
    private readonly providers: ZecUsdPriceProvider[],
    name = 'auto',
  ) {
    this.name = name;
  }

  async getZecUsdPrice(): Promise<ZecUsdPrice> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        return await provider.getZecUsdPrice();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new PriceUnavailableError('no live price provider succeeded', 'provider_error');
  }
}

export interface PriceConfig {
  BLINK_PRICE_PROVIDER: 'none' | 'coinmarketcap' | 'coingecko' | 'coinbase' | 'auto';
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
  switch (config.BLINK_PRICE_PROVIDER) {
    case 'coinmarketcap':
      return new CoinMarketCapPriceProvider({ apiKey: config.COINMARKETCAP_API_KEY, ...shared });
    case 'coingecko':
      return new CoinGeckoPriceProvider(shared);
    case 'coinbase':
      return new CoinbasePriceProvider(shared);
    case 'auto':
      // Prefer CoinMarketCap when a key is configured, then the keyless sources
      // (Coinbase, CoinGecko). A bad or rate-limited key still falls through to a
      // live keyless price rather than failing the request.
      return new ChainedPriceProvider(
        config.COINMARKETCAP_API_KEY
          ? [
              new CoinMarketCapPriceProvider({ apiKey: config.COINMARKETCAP_API_KEY, ...shared }),
              new CoinbasePriceProvider(shared),
              new CoinGeckoPriceProvider(shared),
            ]
          : [new CoinbasePriceProvider(shared), new CoinGeckoPriceProvider(shared)],
      );
    default:
      return new DisabledPriceProvider();
  }
}
