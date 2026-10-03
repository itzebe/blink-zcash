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

beforeAll(async () => {
  const config = loadConfig(baseEnv);
  provider = new StubProvider();
  built = await buildApp({ config, provider });
  await built.app.ready();
});

afterAll(async () => {
  await built.app.close();
});

beforeEach(async () => {
  provider.next = null;
  provider.calls = 0;
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

describe('GET /health', () => {
  it('reports the configured network and provider', async () => {
    const res = await built.app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().network).toBe('testnet');
    expect(res.json().verificationProvider).toBe('none');
  });
});
