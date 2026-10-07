/**
 * API integration tests.
 *
 * These run the real Fastify app against a real PostgreSQL database. They use a
 * stub verification provider, but the stub is honest by construction: it either
 * reports an observation the test explicitly asked it to report, or reports
 * nothing. No test asserts that a payment was confirmed without a provider
 * observation, and a dedicated test asserts the opposite (a claimed txid alone
 * must never confirm a payment).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../server.js';
import { loadConfig } from '../config.js';
import type { Observation, VerificationProvider } from '../services/verification-provider.js';
import { PriceUnavailableError, type ZecUsdPriceProvider } from '../services/price-service.js';
import { EngineUnavailableError, type ZcashEngine } from '../services/zcash-engine.js';
import type { ZecUsdPrice } from '@blink/shared';
import { paymentRequests } from '../db/schema.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://blink:blink_dev_pw@127.0.0.1:5432/blink_test';

const TEST_SAPLING =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';
const TEST_UA =
  'utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s';
const MAIN_TRANSPARENT = 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs';

const baseEnv = {
  DATABASE_URL,
  ZCASH_NETWORK: 'testnet',
  BLINK_ENCRYPTION_KEY: 'a'.repeat(64),
  APP_BASE_URL: 'https://blink.test',
  NODE_ENV: 'test',
  BLINK_ZCASH_SERVICE_URL: '',
  BLINK_VERIFICATION_PROVIDER: 'none',
  BLINK_CONFIRMATIONS_REQUIRED: '1',
} as unknown as NodeJS.ProcessEnv;

/** A price provider whose result each test sets explicitly. */
class StubPriceProvider implements ZecUsdPriceProvider {
  readonly name = 'stub';
  price: ZecUsdPrice | null = {
    provider: 'coinmarketcap',
    asset: 'ZEC',
    quote: 'USD',
    price: '40',
    observedAt: '2026-01-01T00:00:00.000Z',
  };
  error: PriceUnavailableError | null = null;
  calls = 0;

  async getZecUsdPrice(): Promise<ZecUsdPrice> {
    this.calls += 1;
    if (this.error) throw this.error;
    return this.price!;
  }
}

/** A provider whose behaviour each test sets explicitly. */
class StubProvider implements VerificationProvider {
  readonly name = 'stub';
  next: Observation | null = null;
  calls = 0;

  async observe(): Promise<Observation | null> {
    this.calls += 1;
    return this.next;
  }
}

let built: BuiltApp;
let provider: StubProvider;
let priceProvider: StubPriceProvider;

beforeAll(async () => {
  const config = loadConfig(baseEnv);
  provider = new StubProvider();
  priceProvider = new StubPriceProvider();
  built = await buildApp({ config, provider, priceProvider });
  await built.app.ready();
});

afterAll(async () => {
  await built.app.close();
});

beforeEach(async () => {
  provider.next = null;
  provider.calls = 0;
  priceProvider.price = {
    provider: 'coinmarketcap',
    asset: 'ZEC',
    quote: 'USD',
    price: '40',
    observedAt: '2026-01-01T00:00:00.000Z',
  };
  priceProvider.error = null;
  priceProvider.calls = 0;
  await built.db.delete(paymentRequests);
});

async function create(overrides: Record<string, unknown> = {}) {
  const res = await built.app.inject({
    method: 'POST',
    url: '/v1/payment-requests',
    payload: {
      recipientName: 'Joseph',
      recipientAddress: TEST_SAPLING,
      amount: '25.00',
      memo: 'Dinner',
      expiryMinutes: 30,
      ...overrides,
    },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('POST /v1/payment-requests', () => {
  it('creates a request with a valid ZIP 321 URI and a share URL without the address', async () => {
    const { status, body } = await create();
    expect(status).toBe(201);
    expect(body.zip321Uri).toMatch(/^zcash:ztestsapling/);
    expect(body.zip321Uri).toContain('amount=25');
    expect(body.zip321Uri).toContain('memo=RGlubmVy');
    expect(body.shareUrl).toBe(`https://blink.test/pay/${body.shortCode}`);
    expect(body.shareUrl).not.toContain('ztestsapling');
    expect(body.request).not.toHaveProperty('recipientAddress');
  });

  it('generates unpredictable, non-sequential short codes', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const { body } = await create();
      codes.add(body.shortCode);
    }
    expect(codes.size).toBe(8);
    for (const code of codes) {
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/);
    }
  });

  it('rejects an amount with more than 8 decimal places', async () => {
    const { status, body } = await create({ amount: '0.000000001' });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_amount');
  });

  it('rejects a memo attached to a transparent recipient', async () => {
    const TEST_TRANSPARENT = 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU';
    const { status, body } = await create({
      recipientAddress: TEST_TRANSPARENT,
      memo: 'this memo cannot be attached',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('memo_unsupported');
  });

  it('rejects an oversized memo', async () => {
    const { status, body } = await create({
      recipientAddress: TEST_SAPLING,
      memo: 'x'.repeat(600),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('memo_too_long');
  });

  it('rejects a mainnet address on a testnet deployment', async () => {
    const { status, body } = await create({ recipientAddress: MAIN_TRANSPARENT });
    expect(status).toBe(400);
    expect(['invalid_address', 'invalid_network']).toContain(body.error);
    expect(body.message).toMatch(/mainnet/i);
  });

  it('accepts a Unified Address and encodes it verbatim', async () => {
    const { status, body } = await create({ recipientAddress: TEST_UA });
    expect(status).toBe(201);
    expect(body.zip321Uri).toContain(TEST_UA);
  });

  it('rejects an unsupported expiry', async () => {
    const { status, body } = await create({ expiryMinutes: 7 });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_expiry');
  });

  it('rejects a malformed amount', async () => {
    const { status, body } = await create({ amount: 'twenty five' });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_amount');
  });
});

describe('payment purpose (everyday workflow label)', () => {
  it('defaults to invoice and echoes the purpose in the public projection', async () => {
    const { status, body } = await create();
    expect(status).toBe(201);
    expect(body.request.purpose).toBe('invoice');
  });

  it('persists an explicit purpose', async () => {
    for (const purpose of ['payroll', 'remittance', 'subscription', 'point_of_sale'] as const) {
      const { status, body } = await create({ purpose });
      expect(status).toBe(201);
      expect(body.request.purpose).toBe(purpose);
    }
  });

  it('rejects an unknown purpose rather than coercing it', async () => {
    const { status } = await create({ purpose: 'charity' });
    expect(status).toBe(400);
  });

  it('carries the purpose through to the receipt', async () => {
    const { body } = await create({ purpose: 'payroll' });
    const code = body.shortCode;
    const txid = 'a'.repeat(64);
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid },
    });
    provider.next = { txid, confirmations: 3, broadcast: true, source: 'stub' };
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/verify`,
      payload: {},
    });
    const receipt = await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().receipt.purpose).toBe('payroll');
  });
});

describe('the price-provider key is never exposed', () => {
  // A recognisable sentinel: if it ever reaches a response body, this fails.
  const KEY = 'cmc_sentinel_key_do_not_leak_0001';

  it('never returns the CoinMarketCap key from /health or a price lookup', async () => {
    const config = loadConfig({ ...baseEnv, COINMARKETCAP_API_KEY: KEY });
    const app = await buildApp({ config, provider: new StubProvider(), priceProvider });
    await app.app.ready();
    try {
      const health = await app.app.inject({ url: '/health' });
      const price = await app.app.inject({ url: '/v1/price/zec-usd' });
      for (const res of [health, price]) {
        expect(res.body).not.toContain(KEY);
      }
      // The presence-only diagnostic still reports that a key is configured.
      expect(health.json().priceKeyConfigured).toBe(true);
    } finally {
      await app.app.close();
    }
  });

  it('never returns the key from a created request, its public view, or its receipt', async () => {
    const config = loadConfig({ ...baseEnv, COINMARKETCAP_API_KEY: KEY });
    const stub = new StubProvider();
    const app = await buildApp({ config, provider: stub, priceProvider });
    await app.app.ready();
    try {
      const created = await app.app.inject({
        method: 'POST',
        url: '/v1/payment-requests',
        payload: {
          recipientName: 'Joseph',
          recipientAddress: TEST_SAPLING,
          amount: '25',
          currency: 'USD',
          expiryMinutes: 30,
        },
      });
      expect(created.statusCode).toBe(201);
      const code = created.json().shortCode;

      const txid = 'b'.repeat(64);
      await app.app.inject({
        method: 'POST',
        url: `/v1/payment-requests/${code}/transactions`,
        payload: { txid },
      });
      stub.next = { txid, confirmations: 3, broadcast: true, source: 'stub' };
      await app.app.inject({
        method: 'POST',
        url: `/v1/payment-requests/${code}/verify`,
        payload: {},
      });

      const views = await Promise.all([
        app.app.inject({ url: `/v1/payment-requests/${code}` }),
        app.app.inject({ url: `/v1/payment-requests/${code}/payment-details` }),
        app.app.inject({ url: `/v1/payment-requests/${code}/receipt` }),
      ]);
      expect(views[2].statusCode).toBe(200);
      for (const res of [created, ...views]) {
        expect(res.body).not.toContain(KEY);
      }
    } finally {
      await app.app.close();
    }
  });
});

describe('USD-denominated payment requests', () => {
  async function createUsd(overrides: Record<string, unknown> = {}) {
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/payment-requests',
      payload: {
        recipientName: 'Joseph',
        recipientAddress: TEST_SAPLING,
        amount: '25',
        currency: 'USD',
        expiryMinutes: 30,
        ...overrides,
      },
    });
    return { status: res.statusCode, body: res.json() };
  }

  it('converts $25 at $40/ZEC to amount=0.625 and never amount=25 (test 1)', async () => {
    const { status, body } = await createUsd();
    expect(status).toBe(201);
    expect(body.request.amount).toBe('0.625');
    expect(body.request.currency).toBe('ZEC');
    expect(body.request.usdAmount).toBe('25');
    expect(body.request.zecUsdPrice).toBe('40');
    expect(body.request.priceProvider).toBe('coinmarketcap');
    expect(body.zip321Uri).toContain('amount=0.625');
    expect(body.zip321Uri).not.toContain('amount=25');
  });

  it('converts $1 at $40/ZEC to 0.025 ZEC, never 1 ZEC (test 2)', async () => {
    const { body } = await createUsd({ amount: '1' });
    expect(body.request.amount).toBe('0.025');
    expect(body.zip321Uri).toContain('amount=0.025');
    expect(body.zip321Uri).not.toMatch(/amount=1(&|$)/);
  });

  it('converts $100 at $50/ZEC to 2 ZEC (test 3)', async () => {
    priceProvider.price = {
      provider: 'coinmarketcap',
      asset: 'ZEC',
      quote: 'USD',
      price: '50',
      observedAt: null,
    };
    const { body } = await createUsd({ amount: '100' });
    expect(body.request.amount).toBe('2');
    expect(body.zip321Uri).toContain('amount=2');
  });

  it('keeps the original conversion when the market price later changes (test 4)', async () => {
    const { body } = await createUsd({ amount: '25' });
    expect(body.request.amount).toBe('0.625');

    priceProvider.price = {
      provider: 'coinmarketcap',
      asset: 'ZEC',
      quote: 'USD',
      price: '50',
      observedAt: null,
    };
    const view = (await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}` })).json();
    expect(view.request.amount).toBe('0.625');
    expect(view.request.usdAmount).toBe('25');
    expect(view.request.zecUsdPrice).toBe('40');
  });

  it('fails safely when the price provider is unavailable (test 5)', async () => {
    priceProvider.error = new PriceUnavailableError('provider unreachable', 'unreachable');
    const { status, body } = await createUsd();
    expect(status).toBe(503);
    expect(body.error).toBe('price_unavailable');
    const list = await built.db.execute(sql`select count(*)::int as n from payment_requests`);
    expect((list.rows[0] as { n: number }).n).toBe(0);
  });

  it('reports a configuration error when the price provider is not configured (test 6)', async () => {
    priceProvider.error = new PriceUnavailableError('not configured', 'not_configured');
    const { status, body } = await createUsd();
    expect(status).toBe(503);
    expect(body.error).toBe('price_not_configured');
  });

  it('rejects an invalid/zero price (test 7)', async () => {
    priceProvider.price = {
      provider: 'coinmarketcap',
      asset: 'ZEC',
      quote: 'USD',
      price: '0',
      observedAt: null,
    };
    const { status, body } = await createUsd();
    expect(status).toBe(400);
    expect(body.error).toBe('conversion_failed');
  });

  it('rounds a non-whole-zatoshi USD amount UP to the next zatoshi', async () => {
    priceProvider.price = {
      provider: 'coinmarketcap',
      asset: 'ZEC',
      quote: 'USD',
      price: '40.25',
      observedAt: null,
    };
    const { status, body } = await createUsd({ amount: '25' });
    expect(status).toBe(201);
    // 2500 / 4025 * 1e8 = 62_111_801.24... zatoshis -> rounded up to 62_111_802.
    expect(body.request.amount).toBe('0.62111802');
    expect(body.request.usdAmount).toBe('25');
    expect(body.request.zecUsdPrice).toBe('40.25');
    // Never the raw USD number, and never rounded down.
    expect(body.request.amount).not.toBe('25');
    expect(body.zip321Uri).toContain('amount=0.62111802');
    expect(body.zip321Uri).not.toContain('amount=25');
  });

  it('handles a realistic high ZEC price for $1 and $25 without treating USD as ZEC', async () => {
    priceProvider.price = {
      provider: 'coinmarketcap',
      asset: 'ZEC',
      quote: 'USD',
      price: '1365.99',
      observedAt: '2026-10-06T00:00:00.000Z',
    };
    const one = await createUsd({ amount: '1' });
    expect(one.status).toBe(201);
    expect(one.body.request.amount).toBe('0.00073207');
    expect(one.body.zip321Uri).toContain('amount=0.00073207');
    expect(one.body.zip321Uri).not.toMatch(/amount=1(&|$)/);

    const twentyFive = await createUsd({ amount: '25' });
    expect(twentyFive.status).toBe(201);
    expect(twentyFive.body.request.amount).toBe('0.01830175');
    expect(twentyFive.body.request.usdAmount).toBe('25');
    expect(twentyFive.body.zip321Uri).toContain('amount=0.01830175');
    expect(twentyFive.body.zip321Uri).not.toContain('amount=25');
  });

  it('rejects malformed USD amounts', async () => {
    const { status, body } = await createUsd({ amount: '25.001' });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_amount');
  });

  it('does not call the price provider for a ZEC request', async () => {
    await create({ amount: '25' });
    expect(priceProvider.calls).toBe(0);
  });
});

describe('payment lifecycle', () => {
  it('moves through created → initiated → claimed → observed-confirmed', async () => {
    const { body } = await create();
    const code = body.shortCode;

    const view = (await built.app.inject({ url: `/v1/payment-requests/${code}` })).json();
    expect(view.request.status).toBe('WAITING_FOR_PAYMENT');

    const init = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/initiate`,
      payload: {},
    });
    expect(init.statusCode).toBe(200);
    expect(init.json().request.status).toBe('PAYMENT_INITIATED');

    const txid = 'b'.repeat(64);
    const claim = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid },
    });
    expect(claim.statusCode).toBe(202);
    expect(claim.json().request.status).toBe('TRANSACTION_CREATED');
    expect(claim.json().request.status).not.toBe('CONFIRMED');

    provider.next = { txid, confirmations: 2, broadcast: true, source: 'stub' };
    const verify = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/verify`,
      payload: {},
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().request.status).toBe('CONFIRMED');
    expect(verify.json().request.confirmations).toBe(2);
  });

  it('never confirms a payment when the provider observes nothing', async () => {
    const { body } = await create();
    const code = body.shortCode;
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid: 'c'.repeat(64) },
    });

    provider.next = null;
    const verify = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/verify`,
      payload: {},
    });
    expect(verify.json().verification.observed).toBe(false);
    expect(verify.json().request.status).not.toBe('CONFIRMED');
    // The public projection never exposes a raw txid, and no verified txid was
    // stored because nothing was observed.
    expect(verify.json().request.txid).toBeUndefined();
    expect(verify.json().request.txidShort).toBeNull();

    const receipt = await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` });
    expect(receipt.statusCode).toBe(409);
  });

  it('reports BROADCAST (not CONFIRMED) below the required depth', async () => {
    const { body } = await create();
    const code = body.shortCode;
    const txid = 'd'.repeat(64);
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid },
    });
    provider.next = { txid, confirmations: 0, broadcast: true, source: 'stub' };
    const verify = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/verify`,
      payload: {},
    });
    expect(verify.json().request.status).toBe('BROADCAST');
  });

  it('issues a receipt only after confirmation, with an honest statement', async () => {
    const { body } = await create();
    const code = body.shortCode;
    const txid = 'e'.repeat(64);
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid },
    });
    provider.next = { txid, confirmations: 3, broadcast: true, source: 'stub' };
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/verify`,
      payload: {},
    });
    const receipt = await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` });
    expect(receipt.statusCode).toBe(200);
    const r = receipt.json().receipt;
    expect(r.status).toBe('CONFIRMED');
    expect(r.txid).toBe(txid);
    expect(r.statement).toMatch(/cannot cryptographically prove/i);
  });

  it('refuses a second fulfilment of an already-confirmed request', async () => {
    const { body } = await create();
    const code = body.shortCode;
    const txid = 'f'.repeat(64);
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid },
    });
    provider.next = { txid, confirmations: 1, broadcast: true, source: 'stub' };
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/verify`,
      payload: {},
    });

    const again = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid: '1'.repeat(64) },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_paid');
  });

  it('does not expose the raw address on the public endpoint', async () => {
    const { body } = await create();
    const view = (await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}` })).body;
    expect(view).not.toContain(TEST_SAPLING);
  });

  it('stores the recipient address encrypted, never in plaintext', async () => {
    const { body } = await create();
    const rows = await built.db.execute(
      sql`select recipient_address_encrypted from payment_requests where short_code = ${body.shortCode}`,
    );
    const encrypted = (rows.rows[0] as { recipient_address_encrypted: string })
      .recipient_address_encrypted;
    expect(encrypted).not.toContain('ztestsapling');
    expect(built.crypto.decrypt(encrypted)).toBe(TEST_SAPLING);
  });

  it('rejects a txid that is not 64 hex characters', async () => {
    const { body } = await create();
    const res = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${body.shortCode}/transactions`,
      payload: { txid: 'not-a-txid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires the management token to cancel', async () => {
    const { body } = await create();
    const forbidden = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${body.shortCode}/cancel`,
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${body.shortCode}/cancel`,
      headers: { 'x-blink-management-token': body.managementToken },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().request.status).toBe('CANCELLED');
  });

  it('rejects an unknown short code', async () => {
    const res = await built.app.inject({ url: '/v1/payment-requests/ZZZZZZZZZZZZZ' });
    expect(res.statusCode).toBe(404);
  });

  it('expires a request whose deadline has passed', async () => {
    let clock = new Date('2030-01-01T00:00:00Z');
    const provider2 = new StubProvider();
    const built2 = await buildApp({
      config: loadConfig(baseEnv),
      provider: provider2,
      now: () => clock,
    });
    await built2.app.ready();
    try {
      const created = (
        await built2.app.inject({
          method: 'POST',
          url: '/v1/payment-requests',
          payload: {
            recipientName: 'Joseph',
            recipientAddress: TEST_SAPLING,
            amount: '1',
            expiryMinutes: 10,
          },
        })
      ).json();
      clock = new Date(clock.getTime() + 11 * 60_000);
      const view = (
        await built2.app.inject({ url: `/v1/payment-requests/${created.shortCode}` })
      ).json();
      expect(view.request.status).toBe('EXPIRED');

      const details = await built2.app.inject({
        url: `/v1/payment-requests/${created.shortCode}/payment-details`,
      });
      expect(details.statusCode).toBe(410);
    } finally {
      await built2.app.close();
    }
  });
});

describe('mainnet network isolation', () => {
  let mainBuilt: BuiltApp;
  let mainProvider: StubProvider;

  beforeAll(async () => {
    const config = loadConfig({
      ...baseEnv,
      ZCASH_NETWORK: 'mainnet',
      NEXT_PUBLIC_NETWORK: 'mainnet',
    });
    mainProvider = new StubProvider();
    mainBuilt = await buildApp({ config, provider: mainProvider });
    await mainBuilt.app.ready();
  });

  afterAll(async () => {
    await mainBuilt.app.close();
  });

  beforeEach(async () => {
    mainProvider.next = null;
    await mainBuilt.db.delete(paymentRequests);
  });

  async function createMain(overrides: Record<string, unknown> = {}) {
    const res = await mainBuilt.app.inject({
      method: 'POST',
      url: '/v1/payment-requests',
      payload: {
        recipientName: 'Mainnet Recipient',
        recipientAddress: MAIN_TRANSPARENT,
        amount: '1.5',
        expiryMinutes: 30,
        ...overrides,
      },
    });
    return { status: res.statusCode, body: res.json() };
  }

  it('health reports mainnet', async () => {
    const res = await mainBuilt.app.inject({ url: '/health' });
    expect(res.json().network).toBe('mainnet');
  });

  it('accepts a mainnet address and builds a mainnet ZIP 321 URI', async () => {
    const { status, body } = await createMain();
    expect(status).toBe(201);
    expect(body.zip321Uri).toMatch(/^zcash:t1/);
    expect(body.zip321Uri).toContain('amount=1.5');
    expect(body.request.network).toBe('mainnet');
  });

  it('rejects a testnet address on a mainnet deployment', async () => {
    const { status, body } = await createMain({ recipientAddress: TEST_SAPLING });
    expect(status).toBe(400);
    expect(['invalid_address', 'invalid_network']).toContain(body.error);
    expect(body.message).toMatch(/testnet/i);
  });

  it('never confirms a mainnet request from an unobserved txid', async () => {
    const { body } = await createMain();
    await mainBuilt.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${body.shortCode}/transactions`,
      payload: { txid: 'a'.repeat(64) },
    });
    mainProvider.next = null;
    const verify = await mainBuilt.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${body.shortCode}/verify`,
      payload: {},
    });
    expect(verify.json().verification.observed).toBe(false);
    expect(verify.json().request.status).not.toBe('CONFIRMED');
  });

  it('reports transparent privacy for a mainnet transparent recipient', async () => {
    const { body } = await createMain();
    expect(body.request.privacy.recipientKind).toBe('transparent');
    expect(body.request.privacy.recipient).toBe('public');
    expect(body.request.privacy.amount).toBe('public');
  });
});

describe('GET /health', () => {
  it('reports the configured network and provider', async () => {
    const res = await built.app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().network).toBe('testnet');
    expect(res.json().verificationProvider).toBe('none');
    // Presence-only diagnostic: never the key value, just whether one is loaded.
    expect(res.json().priceKeyConfigured).toBe(false);
  });

  it('reports priceKeyConfigured true when a CoinMarketCap key is loaded', async () => {
    const config = loadConfig({
      ...baseEnv,
      ZCASH_NETWORK: 'mainnet',
      NEXT_PUBLIC_NETWORK: 'mainnet',
      BLINK_PRICE_PROVIDER: 'coinmarketcap',
      COINMARKETCAP_API_KEY: 'x'.repeat(32),
    });
    expect(config.BLINK_PRICE_PROVIDER).toBe('coinmarketcap');
    const app = await buildApp({ config, provider: new StubProvider() });
    await app.app.ready();
    try {
      const res = await app.app.inject({ url: '/health' });
      expect(res.json().priceProvider).toBe('coinmarketcap');
      expect(res.json().priceKeyConfigured).toBe(true);
    } finally {
      await app.app.close();
    }
  });
});

describe('GET /v1/meta/network', () => {
  it('exposes the authoritative network for the fail-closed web guard', async () => {
    const res = await built.app.inject({ url: '/v1/meta/network' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.network).toBe('testnet');
    expect(typeof body.verificationProvider).toBe('string');
    expect(typeof body.priceProvider).toBe('string');
  });

  it('reports mainnet when the API is configured for mainnet', async () => {
    const config = loadConfig({
      ...baseEnv,
      ZCASH_NETWORK: 'mainnet',
      NEXT_PUBLIC_NETWORK: 'mainnet',
    });
    const main = await buildApp({ config, provider: new StubProvider() });
    await main.app.ready();
    try {
      const res = await main.app.inject({ url: '/v1/meta/network' });
      expect(res.json().network).toBe('mainnet');
    } finally {
      await main.app.close();
    }
  });
});

describe('privacy capability', () => {
  it('marks a Sapling recipient as shielded and never claims the sender is hidden', async () => {
    const { body } = await create({ recipientAddress: TEST_SAPLING });
    const privacy = body.request.privacy;
    expect(privacy.recipientKind).toBe('sapling');
    expect(privacy.recipient).toBe('protected');
    expect(privacy.amount).toBe('protected');
    // A transparent payer stays public; BLINK must not claim otherwise.
    expect(privacy.sender).toBe('varies');
    expect(privacy.level).toBe('shielded');
    expect(JSON.stringify(privacy).toLowerCase()).not.toContain('anonymous');
  });

  it('marks a Unified Address recipient as shielded', async () => {
    const { status, body } = await create({ recipientAddress: TEST_UA, memo: 'x' });
    expect(status).toBe(201);
    expect(body.request.privacy.recipientKind).toBe('unified');
    expect(body.request.privacy.recipient).toBe('protected');
    expect(body.request.privacy.supportsMemo).toBe(true);
  });

  it('marks a transparent recipient as fully public', async () => {
    const config = loadConfig({
      ...baseEnv,
      ZCASH_NETWORK: 'mainnet',
      NEXT_PUBLIC_NETWORK: 'mainnet',
    });
    const main = await buildApp({ config, provider: new StubProvider() });
    await main.app.ready();
    try {
      const res = await main.app.inject({
        method: 'POST',
        url: '/v1/payment-requests',
        payload: {
          recipientName: 'Merchant',
          recipientAddress: MAIN_TRANSPARENT,
          amount: '1',
          expiryMinutes: 30,
        },
      });
      const privacy = res.json().request.privacy;
      expect(privacy.recipientKind).toBe('transparent');
      expect(privacy.recipient).toBe('public');
      expect(privacy.amount).toBe('public');
      expect(privacy.level).toBe('transparent');
      expect(privacy.supportsMemo).toBe(false);
    } finally {
      await main.app.close();
    }
  });

  it('exposes the same privacy capability on the public view and the payment details', async () => {
    const { body } = await create({ recipientAddress: TEST_SAPLING });
    const view = (
      await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}` })
    ).json();
    expect(view.request.privacy.recipientKind).toBe('sapling');

    const details = (
      await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}/payment-details` })
    ).json();
    expect(details.privacy.recipientKind).toBe('sapling');
    expect(details.privacy.amount).toBe('protected');
  });

  it('persists the privacy snapshot on the stored row', async () => {
    const { body } = await create({ recipientAddress: TEST_SAPLING });
    const [row] = await built.db
      .select({ privacy: paymentRequests.privacy })
      .from(paymentRequests)
      .where(sql`${paymentRequests.shortCode} = ${body.shortCode}`);
    expect(row?.privacy).toMatchObject({ recipientKind: 'sapling', level: 'shielded' });
  });
});

describe('payment link states (shareable /pay/<code>)', () => {
  it('resolves an existing request with amount, purpose and privacy', async () => {
    const { body } = await create({ purpose: 'remittance', amount: '12.5', currency: 'USD' });
    const res = await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}` });
    expect(res.statusCode).toBe(200);
    const req = res.json().request;
    expect(req.amount).toBe('0.3125'); // $12.50 at $40/ZEC
    expect(req.usdAmount).toBe('12.5');
    expect(req.purpose).toBe('remittance');
    expect(req.privacy.level).toBe('shielded');
    expect(req.status).toBe('WAITING_FOR_PAYMENT');
  });

  it('returns 404 for a nonexistent request link', async () => {
    const res = await built.app.inject({ url: '/v1/payment-requests/ZZZZZZZZZZZZZ' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('returns 404 (not a 500) for a malformed request link', async () => {
    const res = await built.app.inject({ url: '/v1/payment-requests/not-a-code' });
    expect(res.statusCode).toBe(404);
  });

  it('reports an expired request and refuses to present it as payable', async () => {
    let clock = new Date('2030-01-01T00:00:00Z');
    const built2 = await buildApp({
      config: loadConfig(baseEnv),
      provider: new StubProvider(),
      now: () => clock,
    });
    await built2.app.ready();
    try {
      const created = (
        await built2.app.inject({
          method: 'POST',
          url: '/v1/payment-requests',
          payload: {
            recipientName: 'Joseph',
            recipientAddress: TEST_SAPLING,
            amount: '1',
            expiryMinutes: 10,
          },
        })
      ).json();
      clock = new Date(clock.getTime() + 11 * 60_000);
      const view = (
        await built2.app.inject({ url: `/v1/payment-requests/${created.shortCode}` })
      ).json();
      expect(view.request.status).toBe('EXPIRED');
      const details = await built2.app.inject({
        url: `/v1/payment-requests/${created.shortCode}/payment-details`,
      });
      expect(details.statusCode).toBe(410);
    } finally {
      await built2.app.close();
    }
  });

  it('reports an already-paid request as CONFIRMED', async () => {
    const { body } = await create();
    const code = body.shortCode;
    const txid = 'c'.repeat(64);
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid },
    });
    provider.next = { txid, confirmations: 5, broadcast: true, source: 'stub' };
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/verify`,
      payload: {},
    });
    const view = (await built.app.inject({ url: `/v1/payment-requests/${code}` })).json();
    expect(view.request.status).toBe('CONFIRMED');
    // Starting the flow again is refused, so a paid link cannot be double-paid.
    const init = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/initiate`,
      payload: {},
    });
    expect(init.statusCode).toBe(409);
    expect(init.json().error).toBe('already_paid');
  });

  it('reports a cancelled request and refuses to present it as payable', async () => {
    const { body } = await create();
    const code = body.shortCode;
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/cancel`,
      headers: { 'x-blink-management-token': body.managementToken },
      payload: {},
    });
    const view = (await built.app.inject({ url: `/v1/payment-requests/${code}` })).json();
    expect(view.request.status).toBe('CANCELLED');
    const init = await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/initiate`,
      payload: {},
    });
    expect(init.statusCode).toBe(409);
    expect(init.json().error).toBe('cancelled');
  });
});

describe('receipt preserves the original USD snapshot and settlement', () => {
  async function confirmUsd(usdAmount: string) {
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/payment-requests',
      payload: {
        recipientName: 'Joseph',
        recipientAddress: TEST_SAPLING,
        amount: usdAmount,
        currency: 'USD',
        purpose: 'payroll',
        memo: 'Salary',
        expiryMinutes: 30,
      },
    });
    const body = res.json();
    const code = body.shortCode;
    const txid = 'd'.repeat(64);
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid },
    });
    provider.next = { txid, confirmations: 4, broadcast: true, source: 'stub' };
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/verify`,
      payload: {},
    });
    return { code, created: body };
  }

  it('shows the original USD amount, the ZEC settlement and the creation rate', async () => {
    const { code } = await confirmUsd('100');
    const receipt = (
      await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` })
    ).json().receipt;
    // Original request: $100 USD. Settlement: 2.5 ZEC at $40/ZEC.
    expect(receipt.usdAmount).toBe('100');
    expect(receipt.amount).toBe('2.5');
    expect(receipt.currency).toBe('ZEC');
    expect(receipt.zecUsdPrice).toBe('40');
  });

  it('keeps the USD snapshot even if the live price later moves', async () => {
    const { code } = await confirmUsd('100');
    priceProvider.price = {
      provider: 'coinmarketcap',
      asset: 'ZEC',
      quote: 'USD',
      price: '999',
      observedAt: null,
    };
    const receipt = (
      await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` })
    ).json().receipt;
    expect(receipt.usdAmount).toBe('100');
    expect(receipt.zecUsdPrice).toBe('40'); // creation rate, not 999
    expect(receipt.amount).toBe('2.5');
  });

  it('preserves purpose and privacy status on the receipt', async () => {
    const { code } = await confirmUsd('100');
    const receipt = (
      await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` })
    ).json().receipt;
    expect(receipt.purpose).toBe('payroll');
    expect(receipt.privacy.level).toBe('shielded');
    expect(receipt.privacy.recipientKind).toBe('sapling');
  });

  it('issues a receipt only for a confirmed payment (a claim alone yields none)', async () => {
    const { body } = await create();
    const code = body.shortCode;
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid: 'e'.repeat(64) },
    });
    const receipt = await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` });
    expect(receipt.statusCode).toBe(409);
    expect(receipt.json().error).toBe('not_confirmed');
  });
});

describe('GET /ready', () => {
  it('reports ready with a live database and no engine configured', async () => {
    const res = await built.app.inject({ url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.ready).toBe(true);
    expect(body.checks.database).toBe(true);
    // No engine is configured in this suite, so engine readiness is not applicable.
    expect(body.checks.engine).toBeNull();
  });

  it('reports starting (503) when the configured engine is unreachable', async () => {
    const config = loadConfig({
      ...baseEnv,
      // A port nothing listens on: the engine ping fails fast.
      BLINK_ZCASH_SERVICE_URL: 'http://127.0.0.1:1',
      BLINK_ZCASH_TIMEOUT_MS: '500',
    });
    const app = await buildApp({ config, provider: new StubProvider() });
    await app.app.ready();
    try {
      const res = await app.app.inject({ url: '/ready' });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe('starting');
      expect(body.ready).toBe(false);
      expect(body.checks.database).toBe(true);
      expect(body.checks.engine).toBe(false);
    } finally {
      await app.app.close();
    }
  });

  it('keeps liveness independent of readiness (health stays ok)', async () => {
    // Liveness stays independent of readiness: /health is still ok even when the
    // engine is unreachable, so Render does not restart a healthy process.
    const config = loadConfig({
      ...baseEnv,
      BLINK_ZCASH_SERVICE_URL: 'http://127.0.0.1:1',
      BLINK_ZCASH_TIMEOUT_MS: '500',
    });
    const app = await buildApp({ config, provider: new StubProvider() });
    await app.app.ready();
    try {
      const health = await app.app.inject({ url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json().status).toBe('ok');
      expect(health.json().zcashEngineConfigured).toBe(true);
    } finally {
      await app.app.close();
    }
  });
});

describe('payment is gated on a real network observation', () => {
  // The safety rule that must never regress: an unknown or unverified network
  // keeps a payment unconfirmed. Only a real provider observation at the
  // required confirmation depth may confirm it. The keep-alive endpoint cannot
  // influence any of this.

  async function createAndClaim() {
    const { body } = await create();
    const code = body.shortCode;
    const txid = 'f'.repeat(64);
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${code}/transactions`,
      payload: { txid },
    });
    return { code, txid };
  }

  it('stays unconfirmed while the network is unknown (provider observes nothing)', async () => {
    const { code } = await createAndClaim();
    provider.next = null; // no observation => network state is unknown
    const verify = (
      await built.app.inject({ method: 'POST', url: `/v1/payment-requests/${code}/verify`, payload: {} })
    ).json();
    expect(verify.verification.observed).toBe(false);
    expect(verify.request.status).not.toBe('CONFIRMED');
    // No receipt is issued for an unconfirmed payment.
    const receipt = await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` });
    expect(receipt.statusCode).toBe(409);
  });

  it('confirms only after a real observation meets the confirmation threshold', async () => {
    const { code, txid } = await createAndClaim();
    provider.next = { txid, confirmations: 1, broadcast: true, source: 'stub' };
    const verify = (
      await built.app.inject({ method: 'POST', url: `/v1/payment-requests/${code}/verify`, payload: {} })
    ).json();
    expect(verify.verification.observed).toBe(true);
    expect(verify.request.status).toBe('CONFIRMED');
    const receipt = await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` });
    expect(receipt.statusCode).toBe(200);
  });

  it('does not confirm below the required confirmation depth', async () => {
    const { code, txid } = await createAndClaim();
    // Broadcast but not yet mined to depth 1: observed, but not confirmed.
    provider.next = { txid, confirmations: 0, broadcast: true, source: 'stub' };
    const verify = (
      await built.app.inject({ method: 'POST', url: `/v1/payment-requests/${code}/verify`, payload: {} })
    ).json();
    expect(verify.verification.observed).toBe(true);
    expect(verify.request.status).not.toBe('CONFIRMED');
    const receipt = await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` });
    expect(receipt.statusCode).toBe(409);
  });

  it('is never unlocked by hitting the keep-alive endpoint', async () => {
    const { code } = await createAndClaim();
    // Ping keep-alive as much as a monitor would.
    for (let i = 0; i < 5; i++) {
      const ka = await built.app.inject({ url: '/health/keepalive' });
      expect(ka.statusCode).toBe(200);
    }
    // Keep-alive says only "process alive"; it cannot stand in for a network
    // observation, so the payment remains unconfirmed.
    provider.next = null;
    const verify = (
      await built.app.inject({ method: 'POST', url: `/v1/payment-requests/${code}/verify`, payload: {} })
    ).json();
    expect(verify.verification.observed).toBe(false);
    expect(verify.request.status).not.toBe('CONFIRMED');
  });
});

describe('engine error classification', () => {
  /** An engine stub that throws exactly what a test asks it to throw. */
  class ThrowingEngine implements ZcashEngine {
    readonly configured = true;
    constructor(private readonly error: Error) {}
    async ping() {
      return false;
    }
    async inspectAddress(): Promise<never> {
      throw this.error;
    }
    async buildUri(): Promise<never> {
      throw this.error;
    }
    async decodeTransaction(): Promise<never> {
      throw this.error;
    }
  }

  async function appWithEngine(error: Error) {
    const config = loadConfig({ ...baseEnv, BLINK_ZCASH_SERVICE_URL: 'https://engine.test' });
    const app = await buildApp({
      config,
      provider: new StubProvider(),
      engine: new ThrowingEngine(error),
    });
    await app.app.ready();
    return app;
  }

  const payload = {
    recipientName: 'Joseph',
    recipientAddress: TEST_SAPLING,
    amount: '1',
    expiryMinutes: 30,
  };

  it('reports a transient (unreachable) engine as 503, never as an invalid address', async () => {
    const app = await appWithEngine(
      new EngineUnavailableError('blink-zcash service unreachable: fetch failed', 'unreachable'),
    );
    try {
      const res = await app.app.inject({
        method: 'POST',
        url: '/v1/payment-requests',
        payload,
      });
      // A cold-starting engine must never make a valid address look invalid.
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('engine_unavailable');
    } finally {
      await app.app.close();
    }
  });

  it('reports a definitive (rejected) engine verdict as an invalid address', async () => {
    const app = await appWithEngine(
      new EngineUnavailableError('address is for testnet but mainnet was expected', 'rejected'),
    );
    try {
      const res = await app.app.inject({
        method: 'POST',
        url: '/v1/payment-requests',
        payload,
      });
      // A real network mismatch stays a hard, non-retryable validation error.
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_address');
      expect(res.json().message).toMatch(/mainnet/i);
    } finally {
      await app.app.close();
    }
  });
});
