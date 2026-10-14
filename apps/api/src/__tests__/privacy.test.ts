/**
 * Privacy regression tests for the plaintext-recipient-address defect.
 *
 * Root cause: `payment_requests.zip321_uri` stored the complete ZIP 321 URI,
 * which embeds the recipient address in the clear, even though
 * `recipient_address_encrypted` was AES-256-GCM. These tests pin the fix: the URI
 * is never persisted (the column is NULL) and is reconstructed on demand from the
 * encrypted address, so no stored field exposes an address.
 *
 * They run against a real PostgreSQL database, exactly like the rest of the API
 * suite, and assert on the *exact* plaintext of a known test address rather than
 * a shape, so a regression that reintroduces the value anywhere fails loudly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

import { buildApp, type BuiltApp } from '../server.js';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createCrypto } from '../crypto.js';
import type { Observation, VerificationProvider } from '../services/verification-provider.js';
import type { ZecUsdPriceProvider } from '../services/price-service.js';
import type { ZecUsdPrice } from '@blink/shared';
import { paymentEvents, paymentRequests } from '../db/schema.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://blink:blink_dev_pw@127.0.0.1:5432/blink_test';
const ENCRYPTION_KEY = 'b'.repeat(64);

// Known shielded test addresses; their exact plaintext must never be persisted.
const TEST_SAPLING =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';
const TEST_UA =
  'utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s';

const baseEnv = {
  DATABASE_URL,
  ZCASH_NETWORK: 'testnet',
  BLINK_ENCRYPTION_KEY: ENCRYPTION_KEY,
  APP_BASE_URL: 'https://blink.test',
  NODE_ENV: 'test',
  BLINK_ZCASH_SERVICE_URL: '',
  BLINK_VERIFICATION_PROVIDER: 'none',
  BLINK_CONFIRMATIONS_REQUIRED: '1',
  BLINK_RATE_LIMIT_MAX: '100000',
} as unknown as NodeJS.ProcessEnv;

class StubProvider implements VerificationProvider {
  readonly name = 'stub';
  next: Observation | null = null;
  async observe(): Promise<Observation | null> {
    return this.next;
  }
}

class StubPriceProvider implements ZecUsdPriceProvider {
  readonly name = 'stub';
  async getZecUsdPrice(): Promise<ZecUsdPrice> {
    return {
      provider: 'stub',
      asset: 'ZEC',
      quote: 'USD',
      price: '40',
      observedAt: '2026-01-01T00:00:00.000Z',
    };
  }
}

let built: BuiltApp;
let provider: StubProvider;

beforeAll(async () => {
  const config = loadConfig(baseEnv);
  provider = new StubProvider();
  built = await buildApp({ config, provider, priceProvider: new StubPriceProvider() });
  await built.app.ready();
});

afterAll(async () => {
  await built.app.close();
});

beforeEach(async () => {
  provider.next = null;
  await built.db.delete(paymentEvents);
  await built.db.delete(paymentRequests);
});

async function create(overrides: Record<string, unknown> = {}) {
  const res = await built.app.inject({
    method: 'POST',
    url: '/v1/payment-requests',
    payload: {
      recipientName: 'Merchant',
      recipientAddress: TEST_SAPLING,
      amount: '25',
      memo: 'Dinner',
      expiryMinutes: 30,
      ...overrides,
    },
  });
  return { status: res.statusCode, body: res.json() };
}

async function rawRow(shortCode: string) {
  const { rows } = await built.db.execute(
    sql`SELECT * FROM payment_requests WHERE short_code = ${shortCode} LIMIT 1`,
  );
  return rows[0] as Record<string, unknown>;
}

describe('new records never persist the recipient address in a URI field', () => {
  it('stores zip321_uri as NULL while still returning the URI to the creator', async () => {
    const { status, body } = await create();
    expect(status).toBe(201);
    // The caller that just created the request still gets a usable URI...
    expect(body.zip321Uri).toMatch(/^zcash:ztestsapling/);
    expect(body.zip321Uri).toContain('amount=25');
    // ...but nothing is persisted.
    const row = await rawRow(body.shortCode);
    expect(row.zip321_uri).toBeNull();
  });

  it('does not store the plaintext address anywhere in the row', async () => {
    const { body } = await create({ recipientAddress: TEST_UA });
    const row = await rawRow(body.shortCode);
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(TEST_UA);
    // No column holds a `zcash:` URI either.
    for (const value of Object.values(row)) {
      if (typeof value === 'string') expect(value).not.toContain('zcash:');
    }
  });

  it('keeps the encrypted address decryptable through the supported code path', async () => {
    const { body } = await create();
    const row = await rawRow(body.shortCode);
    const stored = row.recipient_address_encrypted as string;
    // Ciphertext, not the address.
    expect(stored).not.toContain('ztestsapling');
    const crypto = createCrypto(ENCRYPTION_KEY, false);
    expect(crypto.decrypt(stored)).toBe(TEST_SAPLING);
  });

  it('never writes the address or a zcash: URI into a payment event', async () => {
    const { body } = await create();
    // Drive the lifecycle so CREATED / VIEWED / claim events all get written.
    await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}` });
    await built.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${body.shortCode}/transactions`,
      payload: { txid: 'b'.repeat(64) },
    });

    const { rows } = await built.db.execute(
      sql`SELECT type, data::text AS data FROM payment_events`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const data = String((row as { data: string }).data);
      expect(data).not.toContain(TEST_SAPLING);
      expect(data).not.toContain('zcash:');
    }
  });
});

describe('reconstructed ZIP 321 URIs preserve recipient, amount, memo and encoding', () => {
  it('round-trips through /payment-details to the exact expected URI', async () => {
    const { body } = await create({ amount: '12.5', memo: 'Table 7' });
    const details = (
      await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}/payment-details` })
    ).json();
    expect(details.zip321Uri).toMatch(/^zcash:ztestsapling/);
    expect(details.zip321Uri).toContain(`amount=12.5`);
    // memo "Table 7" -> base64url
    expect(details.zip321Uri).toContain('memo=VGFibGUgNw');
    // The reconstructed URI equals the one handed out at creation.
    expect(details.zip321Uri).toBe(body.zip321Uri);
  });

  it('preserves label and message', async () => {
    const { body } = await create({ label: 'Cafe', message: 'thanks' });
    const details = (
      await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}/payment-details` })
    ).json();
    expect(details.zip321Uri).toContain('label=Cafe');
    expect(details.zip321Uri).toContain('message=thanks');
  });

  it('reconstructs a stable URI across repeated reads', async () => {
    const { body } = await create();
    const first = (
      await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}/payment-details` })
    ).json().zip321Uri;
    const second = (
      await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}/payment-details` })
    ).json().zip321Uri;
    expect(first).toBe(second);
    expect(first).toBe(body.zip321Uri);
  });
});

describe('public surfaces never expose the recipient address', () => {
  it('omits the address from the public view, share URL, payment-details fingerprint and receipt', async () => {
    const { body } = await create();
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

    const view = await built.app.inject({ url: `/v1/payment-requests/${code}` });
    const details = await built.app.inject({
      url: `/v1/payment-requests/${code}/payment-details`,
    });
    const receipt = await built.app.inject({ url: `/v1/payment-requests/${code}/receipt` });
    expect(receipt.statusCode).toBe(200);

    // payment-details legitimately carries the URI (the payer must be able to
    // pay); every other surface must not contain the address.
    expect(details.body).toContain(TEST_SAPLING);
    for (const res of [view, receipt]) {
      expect(res.body).not.toContain(TEST_SAPLING);
      expect(res.body).not.toContain('ztestsapling');
    }
    expect(body.shareUrl).not.toContain(TEST_SAPLING);
  });
});

describe('an unreadable ciphertext fails closed instead of leaking or falling back', () => {
  it('returns 409 payment_details_unavailable and no URI, never a stale value', async () => {
    const { body } = await create();
    // Simulate a key rotation / corruption: the stored ciphertext no longer
    // decrypts under the configured key.
    await built.db.execute(
      sql`UPDATE payment_requests SET recipient_address_encrypted = 'not-valid-ciphertext'
          WHERE short_code = ${body.shortCode}`,
    );
    const details = await built.app.inject({
      url: `/v1/payment-requests/${body.shortCode}/payment-details`,
    });
    expect(details.statusCode).toBe(409);
    expect(details.json().error).toBe('payment_details_unavailable');
    // No URI and no address anywhere in the failure body.
    expect(details.body).not.toContain('zcash:');
    expect(details.body).not.toContain(TEST_SAPLING);
    // The public projection still resolves without leaking an address.
    const view = await built.app.inject({ url: `/v1/payment-requests/${body.shortCode}` });
    expect(view.body).not.toContain(TEST_SAPLING);
  });
});

describe('migration remediation of historical plaintext URIs', () => {
  /** Insert a row that mimics a legacy record with a plaintext URI. */
  async function insertLegacy(shortCode: string, uri: string) {
    const crypto = createCrypto(ENCRYPTION_KEY, false);
    await built.db.execute(sql`
      INSERT INTO payment_requests
        (short_code, recipient_name, recipient_address_encrypted, recipient_address_kind,
         amount, currency, memo, network, privacy, zip321_uri, status, expires_at)
      VALUES
        (${shortCode}, 'Legacy', ${crypto.encrypt(TEST_SAPLING)}, 'sapling',
         '25', 'ZEC', 'Dinner', 'testnet', '{}'::jsonb, ${uri}, 'WAITING_FOR_PAYMENT',
         now() + interval '1 hour')
    `);
  }

  it('blanks existing plaintext URIs and remains usable', async () => {
    const legacyUri = `zcash:${TEST_SAPLING}?amount=25&memo=RGlubmVy`;
    await insertLegacy('ABCDEFGHJKMNP', legacyUri);

    await migrate(DATABASE_URL);

    const row = await rawRow('ABCDEFGHJKMNP');
    expect(row.zip321_uri).toBeNull();
    // The record is still resolvable and hands back a reconstructed URI.
    const details = await built.app.inject({
      url: `/v1/payment-requests/ABCDEFGHJKMNP/payment-details`,
    });
    expect(details.statusCode).toBe(200);
    expect(details.json().zip321Uri).toBe(legacyUri);
  });

  it('is idempotent: re-running does not corrupt already-remediated rows', async () => {
    await insertLegacy('QRSTUVWXYZ234', `zcash:${TEST_SAPLING}?amount=25`);
    await migrate(DATABASE_URL);
    await migrate(DATABASE_URL);
    const row = await rawRow('QRSTUVWXYZ234');
    expect(row.zip321_uri).toBeNull();
    const details = await built.app.inject({
      url: `/v1/payment-requests/QRSTUVWXYZ234/payment-details`,
    });
    expect(details.statusCode).toBe(200);
    expect(details.json().zip321Uri).toContain(TEST_SAPLING);
  });

  it('blanks only the URI column and preserves every unrelated request field', async () => {
    await insertLegacy('ZZZZZZZZZZZZZ', `zcash:${TEST_SAPLING}?amount=25`);
    const before = await rawRow('ZZZZZZZZZZZZZ');

    await migrate(DATABASE_URL);

    const after = await rawRow('ZZZZZZZZZZZZZ');
    // The one remediated field changes...
    expect(after.zip321_uri).toBeNull();
    // ...and nothing else does.
    const strip = (row: Record<string, unknown>) => {
      const { zip321_uri, ...rest } = row;
      void zip321_uri;
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
    expect(after.recipient_address_encrypted).toBe(before.recipient_address_encrypted);
    expect(after.memo).toBe('Dinner');
    expect(after.network).toBe('testnet');
    expect(after.amount).toBe('25');
  });

  it('the migration source never drops or deletes request data', () => {
    const source = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(source).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(source).not.toMatch(/\bTRUNCATE\b/i);
  });
});
