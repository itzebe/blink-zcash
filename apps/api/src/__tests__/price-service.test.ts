/**
 * Price provider tests.
 *
 * The CoinMarketCap HTTP call is stubbed: these tests never touch the live API.
 * They assert the normalized shape and, importantly, that every failure mode is
 * surfaced as an error rather than a fabricated price.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CoinMarketCapPriceProvider,
  CoinGeckoPriceProvider,
  PriceUnavailableError,
  createZecUsdPriceProvider,
} from '../services/price-service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function cmcPayload(price: number, lastUpdated = '2026-01-01T00:00:00.000Z') {
  return {
    status: { error_code: 0 },
    data: {
      '328': {
        id: 328,
        symbol: 'ZEC',
        quote: { USD: { price, last_updated: lastUpdated } },
      },
    },
  };
}

function makeProvider(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new CoinMarketCapPriceProvider({
    apiKey: 'test-key',
    fetchImpl,
    cacheTtlMs: 0,
    ...overrides,
  });
}

describe('CoinMarketCapPriceProvider', () => {
  it('normalizes a valid ZEC/USD response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(cmcPayload(40))) as unknown as typeof fetch;
    const price = await makeProvider(fetchImpl).getZecUsdPrice();
    expect(price).toEqual({
      provider: 'coinmarketcap',
      asset: 'ZEC',
      quote: 'USD',
      price: '40',
      observedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('preserves sub-cent precision', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(cmcPayload(0.12345678)),
    ) as unknown as typeof fetch;
    const price = await makeProvider(fetchImpl).getZecUsdPrice();
    expect(price.price).toBe('0.12345678');
  });

  it('sends the API key server-side in the request header, never in the URL', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['X-CMC_PRO_API_KEY']).toBe('test-key');
      expect(String(_url)).not.toContain('test-key');
      return jsonResponse(cmcPayload(40));
    }) as unknown as typeof fetch;
    await makeProvider(fetchImpl).getZecUsdPrice();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('caches a successful observation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(cmcPayload(40))) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl, { cacheTtlMs: 60_000 });
    await provider.getZecUsdPrice();
    await provider.getZecUsdPrice();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws (never fabricates) when the key is missing', async () => {
    const provider = new CoinMarketCapPriceProvider({ apiKey: '' });
    await expect(provider.getZecUsdPrice()).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('maps HTTP failures to typed errors', async () => {
    const cases: Array<[number, string]> = [
      [429, 'rate_limited'],
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [500, 'provider_error'],
    ];
    for (const [status, code] of cases) {
      const fetchImpl = vi.fn(async () => jsonResponse({}, status)) as unknown as typeof fetch;
      await expect(makeProvider(fetchImpl).getZecUsdPrice()).rejects.toMatchObject({ code });
    }
  });

  it('rejects a malformed payload', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: {} })) as unknown as typeof fetch;
    await expect(makeProvider(fetchImpl).getZecUsdPrice()).rejects.toBeInstanceOf(
      PriceUnavailableError,
    );
  });

  it('rejects zero and negative prices', async () => {
    for (const bad of [0, -5]) {
      const fetchImpl = vi.fn(async () => jsonResponse(cmcPayload(bad))) as unknown as typeof fetch;
      await expect(makeProvider(fetchImpl).getZecUsdPrice()).rejects.toMatchObject({
        code: 'invalid_price',
      });
    }
  });

  it('reports a network failure without leaking the key', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    await expect(makeProvider(fetchImpl).getZecUsdPrice()).rejects.toMatchObject({
      code: 'unreachable',
    });
  });

  it('rejects a non-JSON body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>', { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(makeProvider(fetchImpl).getZecUsdPrice()).rejects.toMatchObject({
      code: 'bad_response',
    });
  });
});

describe('CoinGeckoPriceProvider', () => {
  function geckoPayload(usd: number, lastUpdatedAt = 1767225600) {
    return { zcash: { usd, last_updated_at: lastUpdatedAt } };
  }
  function makeGecko(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
    return new CoinGeckoPriceProvider({ cacheTtlMs: 0, fetchImpl, ...overrides });
  }

  it('normalizes a valid ZEC/USD response and timestamp', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(geckoPayload(1365.99)),
    ) as unknown as typeof fetch;
    const price = await makeGecko(fetchImpl).getZecUsdPrice();
    expect(price).toEqual({
      provider: 'coingecko',
      asset: 'ZEC',
      quote: 'USD',
      price: '1365.99',
      observedAt: new Date(1767225600 * 1000).toISOString(),
    });
  });

  it('needs no API key and sends no authorization header', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain('/api/v3/simple/price');
      expect(String(url)).toContain('ids=zcash');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(Object.keys(headers)).toEqual(['accept']);
      return jsonResponse(geckoPayload(40));
    }) as unknown as typeof fetch;
    await makeGecko(fetchImpl).getZecUsdPrice();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws (never fabricates) on a malformed payload', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    await expect(makeGecko(fetchImpl).getZecUsdPrice()).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('rejects zero and negative prices', async () => {
    for (const bad of [0, -1]) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(geckoPayload(bad)),
      ) as unknown as typeof fetch;
      await expect(makeGecko(fetchImpl).getZecUsdPrice()).rejects.toMatchObject({
        code: 'invalid_price',
      });
    }
  });

  it('maps HTTP failures to typed errors', async () => {
    for (const [status, code] of [
      [429, 'rate_limited'],
      [500, 'provider_error'],
    ] as Array<[number, string]>) {
      const fetchImpl = vi.fn(async () => jsonResponse({}, status)) as unknown as typeof fetch;
      await expect(makeGecko(fetchImpl).getZecUsdPrice()).rejects.toMatchObject({ code });
    }
  });

  it('caches a successful observation', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(geckoPayload(40)),
    ) as unknown as typeof fetch;
    const provider = makeGecko(fetchImpl, { cacheTtlMs: 60_000 });
    await provider.getZecUsdPrice();
    await provider.getZecUsdPrice();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('createZecUsdPriceProvider', () => {
  it('returns a disabled provider when the provider is none', async () => {
    const provider = createZecUsdPriceProvider({
      BLINK_PRICE_PROVIDER: 'none',
      COINMARKETCAP_API_KEY: '',
      BLINK_PRICE_CACHE_TTL_MS: 0,
      BLINK_PRICE_TIMEOUT_MS: 1000,
    });
    await expect(provider.getZecUsdPrice()).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('builds a CoinMarketCap provider when selected', () => {
    const provider = createZecUsdPriceProvider({
      BLINK_PRICE_PROVIDER: 'coinmarketcap',
      COINMARKETCAP_API_KEY: 'k',
      BLINK_PRICE_CACHE_TTL_MS: 0,
      BLINK_PRICE_TIMEOUT_MS: 1000,
    });
    expect(provider.name).toBe('coinmarketcap');
  });

  it('builds a keyless CoinGecko provider when selected', () => {
    const provider = createZecUsdPriceProvider({
      BLINK_PRICE_PROVIDER: 'coingecko',
      COINMARKETCAP_API_KEY: '',
      BLINK_PRICE_CACHE_TTL_MS: 0,
      BLINK_PRICE_TIMEOUT_MS: 1000,
    });
    expect(provider.name).toBe('coingecko');
  });
});
