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
});
