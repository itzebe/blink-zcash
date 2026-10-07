/**
 * `/health/keepalive` tests.
 *
 * The keep-alive endpoint exists so an EXTERNAL uptime monitor can keep the
 * Render Free web service from idling. It must be the cheapest, safest endpoint
 * in the app: it proves only that the process is alive and must not touch the
 * database, the Zcash engine, lightwalletd, the price source, payment logic, or
 * any configuration value. It must never be read as "the Zcash network is
 * verified".
 *
 * These tests build a real Fastify app whose dependencies are counting spies, so
 * any accidental work is caught. The engine ping is deliberately configured to
 * fail: if the endpoint consulted readiness, the test would see it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type BuiltApp } from '../server.js';
import { loadConfig } from '../config.js';
import type { Database } from '../db/index.js';
import type { Observation, VerificationProvider } from '../services/verification-provider.js';
import type { ZcashEngine, InspectResult, EngineResult, TransactionInfo } from '../services/zcash-engine.js';
import type { ZecUsdPriceProvider } from '../services/price-service.js';
import type { ZecUsdPrice } from '@blink/shared';

// A recognisable sentinel: if it ever reaches the keep-alive body, the test fails.
const CMC_KEY = 'cmc_keepalive_sentinel_do_not_leak_0001';

const baseEnv = {
  DATABASE_URL: 'postgres://blink:blink_dev_pw@127.0.0.1:5432/blink_test',
  ZCASH_NETWORK: 'testnet',
  BLINK_ENCRYPTION_KEY: 'a'.repeat(64),
  APP_BASE_URL: 'https://blink.test',
  NODE_ENV: 'test',
  // Configured so the app has dependencies that the endpoint MUST NOT touch.
  BLINK_ZCASH_SERVICE_URL: 'https://engine.test',
  BLINK_VERIFICATION_PROVIDER: 'none',
  BLINK_CONFIRMATIONS_REQUIRED: '1',
  BLINK_PRICE_PROVIDER: 'coinmarketcap',
  COINMARKETCAP_API_KEY: CMC_KEY,
} as unknown as NodeJS.ProcessEnv;

/** Counts every call so a spy can assert the endpoint did no work. */
class CountingEngine implements ZcashEngine {
  readonly configured = true;
  pingCalls = 0;
  inspectCalls = 0;
  buildCalls = 0;
  decodeCalls = 0;

  async ping(): Promise<boolean> {
    this.pingCalls += 1;
    return false; // deliberately unreachable: readiness would report "starting"
  }
  async inspectAddress(): Promise<EngineResult<InspectResult>> {
    this.inspectCalls += 1;
    throw new Error('keepalive must not call the Zcash engine');
  }
  async buildUri(): Promise<EngineResult<string>> {
    this.buildCalls += 1;
    throw new Error('keepalive must not call the Zcash engine');
  }
  async decodeTransaction(): Promise<EngineResult<TransactionInfo>> {
    this.decodeCalls += 1;
    throw new Error('keepalive must not call the Zcash engine');
  }
}

class CountingProvider implements VerificationProvider {
  readonly name = 'stub';
  observeCalls = 0;
  async observe(): Promise<Observation | null> {
    this.observeCalls += 1;
    return null;
  }
}

class CountingPrice implements ZecUsdPriceProvider {
  readonly name = 'stub';
  calls = 0;
  async getZecUsdPrice(): Promise<ZecUsdPrice> {
    this.calls += 1;
    throw new Error('keepalive must not look up a price');
  }
}

/** A proxy database whose every property access is recorded; `execute` counts. */
function countingDb() {
  let executeCalls = 0;
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'execute') {
          return async () => {
            executeCalls += 1;
            return { rows: [] };
          };
        }
        return () => {
          throw new Error(`keepalive must not touch the database (via ${String(prop)})`);
        };
      },
    },
  ) as unknown as Database;
  return { proxy, executeCalls: () => executeCalls };
}

let built: BuiltApp;
let engine: CountingEngine;
let provider: CountingProvider;
let price: CountingPrice;
let db: ReturnType<typeof countingDb>;

beforeAll(async () => {
  const config = loadConfig(baseEnv);
  engine = new CountingEngine();
  provider = new CountingProvider();
  price = new CountingPrice();
  db = countingDb();
  built = await buildApp({
    config,
    db: db.proxy,
    engine,
    provider,
    priceProvider: price,
  });
  await built.app.ready();
});

afterAll(async () => {
  await built.app.close();
});

describe('GET /health/keepalive', () => {
  it('returns HTTP 200 with exactly { status: "ok" }', async () => {
    const res = await built.app.inject({ url: '/health/keepalive' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('never exposes a secret or any configuration value', async () => {
    const res = await built.app.inject({ url: '/health/keepalive' });
    const body = res.body;
    expect(body).not.toContain(CMC_KEY);
    expect(body).not.toContain('coinmarketcap');
    expect(body).not.toContain('lightwalletd');
    expect(body).not.toContain('testnet');
    expect(body).not.toContain('engine.test');
  });

  it('does not perform database work', async () => {
    const before = db.executeCalls();
    await built.app.inject({ url: '/health/keepalive' });
    expect(db.executeCalls()).toBe(before);
  });

  it('does not touch the Zcash engine or run network verification', async () => {
    engine.pingCalls = 0;
    engine.inspectCalls = 0;
    engine.buildCalls = 0;
    engine.decodeCalls = 0;
    await built.app.inject({ url: '/health/keepalive' });
    expect(engine.pingCalls).toBe(0);
    expect(engine.inspectCalls).toBe(0);
    expect(engine.buildCalls).toBe(0);
    expect(engine.decodeCalls).toBe(0);
  });

  it('does not access payment logic or the verification provider', async () => {
    provider.observeCalls = 0;
    await built.app.inject({ url: '/health/keepalive' });
    expect(provider.observeCalls).toBe(0);
  });

  it('does not look up a price', async () => {
    price.calls = 0;
    await built.app.inject({ url: '/health/keepalive' });
    expect(price.calls).toBe(0);
  });

  it('never claims a verified network or readiness', async () => {
    const res = await built.app.inject({ url: '/health/keepalive' });
    const body = res.json() as Record<string, unknown>;
    // The endpoint is liveness only: it must not carry network/readiness fields
    // that could be mistaken for "Mainnet verified".
    expect(body).not.toHaveProperty('network');
    expect(body).not.toHaveProperty('ready');
    expect(body).not.toHaveProperty('checks');
  });

  it('answers even while the engine is unreachable (independent of readiness)', async () => {
    // The engine ping fails by construction, so readiness is "starting"...
    const ready = await built.app.inject({ url: '/ready' });
    expect(ready.statusCode).toBe(503);
    // ...but the process is alive, which is all keep-alive claims.
    const keepalive = await built.app.inject({ url: '/health/keepalive' });
    expect(keepalive.statusCode).toBe(200);
  });

  it('leaves the normal /health liveness endpoint intact', async () => {
    const res = await built.app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
