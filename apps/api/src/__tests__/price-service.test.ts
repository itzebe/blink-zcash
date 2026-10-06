/**
 * Price provider tests.
 *
 * The CoinMarketCap HTTP call is stubbed: these tests never touch the live API.
 * They assert the normalized shape and, importantly, that every failure mode is
 * surfaced as an error rather than a fabricated price.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ChainedPriceProvider,
  CoinbasePriceProvider,
  CoinGeckoPriceProvider,
  CoinMarketCapPriceProvider,
  PriceUnavailableError,
  createZecUsdPriceProvider,
} from '../services/price-service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// The live v3 Quotes Latest endpoint returns `data` as an ARRAY and `quote` as
// an ARRAY of per-currency quotes; id 1437 is Zcash (id 328 is Monero). The
// tests use that exact shape so a regression cannot pass against a fabricated
// payload the real API never returns.
function cmcPayload(price: number, lastUpdated = '2026-01-01T00:00:00.000Z') {
  return {
    status: { error_code: 0 },
    data: [
      {
        id: 1437,
        symbol: 'ZEC',
        quote: [{ id: 2781, symbol: 'USD', price, last_updated: lastUpdated }],
      },
    ],
  };
}

/** The legacy id-keyed object shape, which must also still be understood. */
function cmcObjectPayload(price: number, lastUpdated = '2026-01-01T00:00:00.000Z') {
  return {
    status: { error_code: 0 },
    data: {
      '1437': {
        id: 1437,
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

  it('also understands the legacy id-keyed object response shape', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(cmcObjectPayload(41.5)),
    ) as unknown as typeof fetch;
    const price = await makeProvider(fetchImpl).getZecUsdPrice();
    expect(price.price).toBe('41.5');
  });

  it('requests the Zcash id (1437), not the old Monero id', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toContain('id=1437');
      expect(String(url)).not.toContain('id=328');
      return jsonResponse(cmcPayload(40));
    }) as unknown as typeof fetch;
    await makeProvider(fetchImpl).getZecUsdPrice();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a response whose entry is not ZEC (guards against a wrong id)', async () => {
    // id 328 is Monero: if the request id regresses, the entry will not be ZEC
    // and the provider must refuse rather than report Monero's price as ZEC.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: 328,
            symbol: 'XMR',
            quote: [{ symbol: 'USD', price: 560.47, last_updated: '2026-01-01T00:00:00.000Z' }],
          },
        ],
      }),
    ) as unknown as typeof fetch;
    await expect(makeProvider(fetchImpl).getZecUsdPrice()).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('rejects a response with no USD quote', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ id: 1437, symbol: 'ZEC', quote: [{ symbol: 'EUR', price: 1200 }] }],
      }),
    ) as unknown as typeof fetch;
    await expect(makeProvider(fetchImpl).getZecUsdPrice()).rejects.toMatchObject({
      code: 'bad_response',
    });
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

describe('CoinbasePriceProvider', () => {
  function coinbasePayload(amount: number) {
    return { data: { amount: String(amount), base: 'ZEC', currency: 'USD' } };
  }
  function makeCoinbase(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
    return new CoinbasePriceProvider({ cacheTtlMs: 0, fetchImpl, ...overrides });
  }

  it('normalizes a valid ZEC/USD spot response', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(coinbasePayload(1365.315)),
    ) as unknown as typeof fetch;
    const price = await makeCoinbase(fetchImpl).getZecUsdPrice();
    expect(price).toMatchObject({
      provider: 'coinbase',
      asset: 'ZEC',
      quote: 'USD',
      price: '1365.315',
    });
    expect(typeof price.observedAt).toBe('string');
    expect(Number.isNaN(Date.parse(price.observedAt!))).toBe(false);
  });

  it('needs no API key and sends no authorization header', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain('/v2/prices/ZEC-USD/spot');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(Object.keys(headers)).toEqual(['accept']);
      return jsonResponse(coinbasePayload(40));
    }) as unknown as typeof fetch;
    await makeCoinbase(fetchImpl).getZecUsdPrice();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws (never fabricates) on a wrong-pair payload', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { amount: '1', base: 'BTC', currency: 'USD' } }),
    ) as unknown as typeof fetch;
    await expect(makeCoinbase(fetchImpl).getZecUsdPrice()).rejects.toMatchObject({
      code: 'bad_response',
    });
  });
});

describe('ChainedPriceProvider', () => {
  it('returns the first provider that succeeds', async () => {
    const ok = { name: 'ok', getZecUsdPrice: vi.fn(async () => ({ provider: 'ok', asset: 'ZEC', quote: 'USD', price: '1', observedAt: null })) };
    const never = { name: 'never', getZecUsdPrice: vi.fn(async () => { throw new Error('x'); }) };
    const chain = new ChainedPriceProvider([never, ok]);
    const price = await chain.getZecUsdPrice();
    expect(price.provider).toBe('ok');
    expect(never.getZecUsdPrice).toHaveBeenCalledOnce();
  });

  it('rethrows the last error when every provider fails', async () => {
    const bad = () => ({ name: 'bad', getZecUsdPrice: async () => { throw new PriceUnavailableError('nope', 'provider_error'); } });
    const chain = new ChainedPriceProvider([bad(), bad()]);
    await expect(chain.getZecUsdPrice()).rejects.toMatchObject({ code: 'provider_error' });
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

  it('does not silently fall through when coinmarketcap is explicitly selected', async () => {
    // Explicit coinmarketcap must fail clearly on an invalid key, not substitute
    // a keyless price: the operator asked for CoinMarketCap specifically.
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    const provider = createZecUsdPriceProvider(
      {
        BLINK_PRICE_PROVIDER: 'coinmarketcap',
        COINMARKETCAP_API_KEY: 'bad',
        BLINK_PRICE_CACHE_TTL_MS: 0,
        BLINK_PRICE_TIMEOUT_MS: 1000,
      },
      { fetchImpl },
    );
    await expect(provider.getZecUsdPrice()).rejects.toMatchObject({ code: 'unauthorized' });
    // Only the CoinMarketCap endpoint was contacted; no keyless source was tried.
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('pro-api.coinmarketcap.com');
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

  it('builds a keyless Coinbase provider when selected', () => {
    const provider = createZecUsdPriceProvider({
      BLINK_PRICE_PROVIDER: 'coinbase',
      COINMARKETCAP_API_KEY: '',
      BLINK_PRICE_CACHE_TTL_MS: 0,
      BLINK_PRICE_TIMEOUT_MS: 1000,
    });
    expect(provider.name).toBe('coinbase');
  });

  it('builds the keyless auto chain when selected', () => {
    const provider = createZecUsdPriceProvider({
      BLINK_PRICE_PROVIDER: 'auto',
      COINMARKETCAP_API_KEY: '',
      BLINK_PRICE_CACHE_TTL_MS: 0,
      BLINK_PRICE_TIMEOUT_MS: 1000,
    });
    expect(provider.name).toBe('auto');
  });

  it('prefers CoinMarketCap inside the auto chain when a key is configured', async () => {
    // The first provider in the chain must be CoinMarketCap, so a deployment
    // that provisions the key actually uses it (not a keyless source).
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toContain('pro-api.coinmarketcap.com');
      return jsonResponse(cmcPayload(42));
    }) as unknown as typeof fetch;
    const provider = createZecUsdPriceProvider(
      {
        BLINK_PRICE_PROVIDER: 'auto',
        COINMARKETCAP_API_KEY: 'k',
        BLINK_PRICE_CACHE_TTL_MS: 0,
        BLINK_PRICE_TIMEOUT_MS: 1000,
      },
      { fetchImpl },
    );
    const price = await provider.getZecUsdPrice();
    expect(price.provider).toBe('coinmarketcap');
    expect(price.price).toBe('42');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('falls through the auto chain to a keyless source when CoinMarketCap fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('pro-api.coinmarketcap.com')) return jsonResponse({}, 500);
      return jsonResponse({ data: { amount: '40', base: 'ZEC', currency: 'USD' } });
    }) as unknown as typeof fetch;
    const provider = createZecUsdPriceProvider(
      {
        BLINK_PRICE_PROVIDER: 'auto',
        COINMARKETCAP_API_KEY: 'k',
        BLINK_PRICE_CACHE_TTL_MS: 0,
        BLINK_PRICE_TIMEOUT_MS: 1000,
      },
      { fetchImpl },
    );
    const price = await provider.getZecUsdPrice();
    expect(price.provider).toBe('coinbase');
  });
});
