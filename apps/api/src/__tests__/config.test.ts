/**
 * Config guardrail tests. These assert that BLINK refuses to start in
 * configurations where it would silently be unable to verify payments.
 */
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';

const base = {
  NODE_ENV: 'development',
  ZCASH_NETWORK: 'testnet',
  DATABASE_URL: 'postgres://blink:blink_dev_pw@127.0.0.1:5432/blink',
} as unknown as NodeJS.ProcessEnv;

describe('loadConfig verification guardrails', () => {
  it('defaults to a none provider and testnet', () => {
    const config = loadConfig(base);
    expect(config.BLINK_VERIFICATION_PROVIDER).toBe('none');
    expect(config.ZCASH_NETWORK).toBe('testnet');
  });

  it('refuses lightwalletd without an endpoint', () => {
    expect(() =>
      loadConfig({ ...base, BLINK_VERIFICATION_PROVIDER: 'lightwalletd' }),
    ).toThrow(/BLINK_LIGHTWALLETD_URL/);
  });

  it('accepts lightwalletd with an endpoint', () => {
    const config = loadConfig({
      ...base,
      BLINK_VERIFICATION_PROVIDER: 'lightwalletd',
      BLINK_LIGHTWALLETD_URL: 'http://localhost:9067',
    });
    expect(config.BLINK_VERIFICATION_PROVIDER).toBe('lightwalletd');
  });

  it('refuses node-rpc without an endpoint', () => {
    expect(() => loadConfig({ ...base, BLINK_VERIFICATION_PROVIDER: 'node-rpc' })).toThrow(
      /ZCASH_RPC_URL/,
    );
  });

  it('refuses mainnet with no verification provider in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        ZCASH_NETWORK: 'mainnet',
        NEXT_PUBLIC_NETWORK: 'mainnet',
        BLINK_ENCRYPTION_KEY: 'a'.repeat(64),
        BLINK_VERIFICATION_PROVIDER: 'none',
      }),
    ).toThrow(/Mainnet requires/);
  });

  it('requires an encryption key in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /BLINK_ENCRYPTION_KEY/,
    );
  });

  it('rejects a web/API network mismatch', () => {
    expect(() => loadConfig({ ...base, NEXT_PUBLIC_NETWORK: 'mainnet' })).toThrow(/must match/);
  });

  it('refuses coinmarketcap without an API key in development', () => {
    expect(() => loadConfig({ ...base, BLINK_PRICE_PROVIDER: 'coinmarketcap' })).toThrow(
      /COINMARKETCAP_API_KEY/,
    );
  });

  it('degrades to none (not a crash) when production is missing the CMC key', () => {
    // A missing price key must not take the whole API down (ZEC must keep
    // working). USD is disabled with an explicit 503 instead.
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      ZCASH_NETWORK: 'mainnet',
      NEXT_PUBLIC_NETWORK: 'mainnet',
      BLINK_ENCRYPTION_KEY: 'a'.repeat(64),
      BLINK_VERIFICATION_PROVIDER: 'lightwalletd',
      BLINK_LIGHTWALLETD_URL: 'https://zec.rocks:443',
      BLINK_PRICE_PROVIDER: 'coinmarketcap',
    });
    expect(config.BLINK_PRICE_PROVIDER).toBe('none');
  });

  it('accepts coinmarketcap with an API key', () => {
    const config = loadConfig({
      ...base,
      BLINK_PRICE_PROVIDER: 'coinmarketcap',
      COINMARKETCAP_API_KEY: 'test-key',
    });
    expect(config.BLINK_PRICE_PROVIDER).toBe('coinmarketcap');
    expect(config.COINMARKETCAP_API_KEY).toBe('test-key');
  });

  it('auto-selects the keyless auto chain when no key is present', () => {
    expect(loadConfig(base).BLINK_PRICE_PROVIDER).toBe('auto');
  });

  it('treats a blank provider as unset rather than an invalid value', () => {
    // `.env.example` ships `BLINK_PRICE_PROVIDER=`; a blank value must not refuse
    // to boot.
    expect(loadConfig({ ...base, BLINK_PRICE_PROVIDER: '' }).BLINK_PRICE_PROVIDER).toBe('auto');
    expect(
      loadConfig({ ...base, BLINK_PRICE_PROVIDER: '   ', COINMARKETCAP_API_KEY: 'k' })
        .BLINK_PRICE_PROVIDER,
    ).toBe('coinmarketcap');
  });

  it('keeps auto a resilient chain when a key is present (CoinMarketCap preferred inside it)', () => {
    // `auto` must not collapse to a bare CoinMarketCap provider: the chain keeps
    // the keyless sources behind it, so a bad/rate-limited key cannot take USD
    // requests down. The chain prefers CoinMarketCap (see price-service tests).
    expect(
      loadConfig({ ...base, BLINK_PRICE_PROVIDER: 'auto', COINMARKETCAP_API_KEY: 'k' })
        .BLINK_PRICE_PROVIDER,
    ).toBe('auto');
  });

  it('keeps auto keyless when no key is present', () => {
    expect(loadConfig({ ...base, BLINK_PRICE_PROVIDER: 'auto' }).BLINK_PRICE_PROVIDER).toBe('auto');
  });

  it('trims a whitespace-padded CoinMarketCap key so it is not treated as absent', () => {
    const config = loadConfig({
      ...base,
      BLINK_PRICE_PROVIDER: 'coinmarketcap',
      COINMARKETCAP_API_KEY: '  k  ',
    });
    expect(config.COINMARKETCAP_API_KEY).toBe('k');
  });

  it('auto-selects CoinMarketCap when a key is present and no provider is set', () => {
    expect(loadConfig({ ...base, COINMARKETCAP_API_KEY: 'k' }).BLINK_PRICE_PROVIDER).toBe(
      'coinmarketcap',
    );
  });

  it('accepts an explicit none to disable USD requests', () => {
    expect(loadConfig({ ...base, BLINK_PRICE_PROVIDER: 'none' }).BLINK_PRICE_PROVIDER).toBe('none');
  });

  it('accepts the keyless coingecko provider', () => {
    const config = loadConfig({ ...base, BLINK_PRICE_PROVIDER: 'coingecko' });
    expect(config.BLINK_PRICE_PROVIDER).toBe('coingecko');
  });

  it('refuses mainnet in production without an explicit coinmarketcap price provider', () => {
    const mainnetBase = {
      ...base,
      NODE_ENV: 'production',
      ZCASH_NETWORK: 'mainnet',
      NEXT_PUBLIC_NETWORK: 'mainnet',
      BLINK_ENCRYPTION_KEY: 'a'.repeat(64),
      BLINK_VERIFICATION_PROVIDER: 'lightwalletd',
      BLINK_LIGHTWALLETD_URL: 'https://zec.rocks:443',
    } as unknown as NodeJS.ProcessEnv;
    // keyless auto chain is refused on mainnet
    expect(() => loadConfig(mainnetBase)).toThrow(/coinmarketcap/);
    expect(() => loadConfig({ ...mainnetBase, BLINK_PRICE_PROVIDER: 'coingecko' })).toThrow(
      /coinmarketcap/,
    );
    // explicit coinmarketcap with a key is accepted
    const ok = loadConfig({
      ...mainnetBase,
      BLINK_PRICE_PROVIDER: 'coinmarketcap',
      COINMARKETCAP_API_KEY: 'k',
    });
    expect(ok.BLINK_PRICE_PROVIDER).toBe('coinmarketcap');
    expect(ok.ZCASH_NETWORK).toBe('mainnet');
    // `none` is allowed: it disables USD requests but keeps ZEC working
    expect(loadConfig({ ...mainnetBase, BLINK_PRICE_PROVIDER: 'none' }).BLINK_PRICE_PROVIDER).toBe(
      'none',
    );
  });

  it('allows keyless price providers on testnet even in production', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      ZCASH_NETWORK: 'testnet',
      BLINK_ENCRYPTION_KEY: 'a'.repeat(64),
      BLINK_VERIFICATION_PROVIDER: 'lightwalletd',
      BLINK_LIGHTWALLETD_URL: 'https://testnet.zec.rocks:443',
    });
    expect(config.BLINK_PRICE_PROVIDER).toBe('auto');
  });
});
