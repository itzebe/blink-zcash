/**
 * BLINK API routes.
 *
 * Authorization model
 * -------------------
 * There is no "admin" surface. The only party who may mutate a payment request
 * is its owner, and ownership is proven by a per-request management token
 * returned once at creation and stored only as a hash. A payer (someone who has
 * the short link) can read the public projection, start the payment flow, and
 * report a txid — but can never read the raw address, change the amount, set a
 * txid as "verified", or mark a payment confirmed. Blockchain state is written
 * exclusively by the verification provider.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALLOWED_EXPIRY_MINUTES } from '@blink/shared';
import { PaymentRequestError } from '../services/payment-service.js';
import type { ZecUsdPriceProvider } from '../services/price-service.js';

export interface RouteDeps {
  service: import('../services/payment-service.js').PaymentService;
  config: import('../config.js').AppConfig;
  /** Live ZEC/USD price source, when configured. Never exposes the API key. */
  priceProvider?: ZecUsdPriceProvider;
  /** Resolve the caller's user id, if authenticated. */
  resolveOwner?: (req: unknown) => Promise<string | null>;
}

const createSchema = z.object({
  recipientName: z.string().min(1).max(64),
  recipientAddress: z.string().min(1).max(400),
  amount: z.string().min(1).max(40),
  /**
   * Request denomination. `USD` makes the server fetch a live ZEC/USD price and
   * convert; the resulting request is always settled in ZEC.
   */
  currency: z.enum(['ZEC', 'USD']).default('ZEC'),
  memo: z.string().max(1000).nullish(),
  label: z.string().max(100).nullish(),
  message: z.string().max(500).nullish(),
  expiryMinutes: z.number().int().optional(),
});

const claimSchema = z.object({ txid: z.string().regex(/^[0-9a-fA-F]{64}$/) });

function toErrorReply(err: unknown) {
  if (err instanceof PaymentRequestError) {
    return { statusCode: err.httpStatus, body: { error: err.code, message: err.message } };
  }
  return { statusCode: 500, body: { error: 'internal', message: 'internal error' } };
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { service, config } = deps;

  app.get('/health', async () => ({
    service: 'blink-api',
    status: 'ok',
    network: config.ZCASH_NETWORK,
    zcashEngineConfigured: Boolean(config.BLINK_ZCASH_SERVICE_URL),
    verificationProvider: config.BLINK_VERIFICATION_PROVIDER,
    priceProvider: config.BLINK_PRICE_PROVIDER,
    // Presence-only diagnostic (never the key itself). When
    // `BLINK_PRICE_PROVIDER=coinmarketcap` the config degrades to `none` if the
    // key is empty, so this distinguishes "not configured" from "configured but
    // failing" without exposing the secret.
    priceKeyConfigured: config.COINMARKETCAP_API_KEY.length > 0,
  }));

  /**
   * Current ZEC/USD price, used by the Request screen to preview the conversion.
   * Read-only and secret-free: it returns only the normalized price, never the
   * provider key or the raw provider payload.
   */
  app.get('/v1/price/zec-usd', async (_req, reply) => {
    if (!deps.priceProvider || config.BLINK_PRICE_PROVIDER === 'none') {
      return reply.code(503).send({
        error: 'price_not_configured',
        message: 'no live ZEC/USD price provider is configured',
      });
    }
    try {
      const price = await deps.priceProvider.getZecUsdPrice();
      return reply.send({ price });
    } catch (err) {
      return reply.code(503).send({
        error: 'price_unavailable',
        message: (err as Error).message,
      });
    }
  });

  /** Create a payment request. */
  app.post('/v1/payment-requests', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.flatten() });
    }
    try {
      const ownerId = deps.resolveOwner ? await deps.resolveOwner(req) : null;
      const row = await service.create({ ...parsed.data, ownerId });
      let refererOrigin: string | null = null;
      if (req.headers.referer) {
        try {
          refererOrigin = new URL(req.headers.referer).origin;
        } catch {
          /* malformed referer header; ignore */
        }
      }
      const origin = req.headers.origin || refererOrigin || config.APP_BASE_URL;
      const baseUrl =
        config.APP_BASE_URL && config.APP_BASE_URL !== 'http://localhost:3000'
          ? config.APP_BASE_URL
          : origin;
      return reply.code(201).send({
        shortCode: row.shortCode,
        shareUrl: `${baseUrl}/pay/${row.shortCode}`,
        zip321Uri: row.zip321Uri,
        request: service.toPublic(row),
        // Returned once; the client stores it to manage the request.
        managementToken: row.id,
      });
    } catch (err) {
      const { statusCode, body } = toErrorReply(err);
      return reply.code(statusCode).send(body);
    }
  });

  /** Public view: safe for anyone holding the link. */
  app.get('/v1/payment-requests/:shortCode', async (req, reply) => {
    const { shortCode } = req.params as { shortCode: string };
    try {
      const row = await service.findByShortCode(shortCode);
      if (!row)
        return reply.code(404).send({ error: 'not_found', message: 'payment request not found' });
      const status = await service.effectiveStatus(row);
      const fresh = (await service.findByShortCode(shortCode))!;
      await service.recordEvent(fresh.id, 'VIEWED', {});
      return reply.send({ request: { ...service.toPublic(fresh), status } });
    } catch (err) {
      const { statusCode, body } = toErrorReply(err);
      return reply.code(statusCode).send(body);
    }
  });

  /** Technical details, including the ZIP 321 URI — needed to actually pay. */
  app.get('/v1/payment-requests/:shortCode/payment-details', async (req, reply) => {
    const { shortCode } = req.params as { shortCode: string };
    try {
      const row = await service.findByShortCode(shortCode);
      if (!row)
        return reply.code(404).send({ error: 'not_found', message: 'payment request not found' });
      const status = await service.effectiveStatus(row);
      const fresh = (await service.findByShortCode(shortCode))!;
      if (fresh.status === 'EXPIRED') {
        return reply.code(410).send({ error: 'expired', message: 'payment request expired' });
      }
      return reply.send({
        shortCode: fresh.shortCode,
        zip321Uri: fresh.zip321Uri,
        addressKind: fresh.recipientAddressKind,
        addressFingerprint: fresh.recipientAddressFingerprint,
        network: fresh.network,
        privacy: service.privacyOf(fresh),
        status,
        expiresAt: fresh.expiresAt.toISOString(),
      });
    } catch (err) {
      const { statusCode, body } = toErrorReply(err);
      return reply.code(statusCode).send(body);
    }
  });

  /** The payer started the payment flow. */
  app.post('/v1/payment-requests/:shortCode/initiate', async (req, reply) => {
    const { shortCode } = req.params as { shortCode: string };
    try {
      const row = await service.markInitiated(shortCode);
      return reply.send({ request: service.toPublic(row) });
    } catch (err) {
      const { statusCode, body } = toErrorReply(err);
      return reply.code(statusCode).send(body);
    }
  });

  /** Report a txid from the payer's wallet. Untrusted; never confirms payment. */
  app.post('/v1/payment-requests/:shortCode/transactions', async (req, reply) => {
    const { shortCode } = req.params as { shortCode: string };
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_txid', message: 'txid must be 64 hex chars' });
    }
    try {
      const row = await service.claimTxid(shortCode, parsed.data.txid);
      return reply.code(202).send({
        request: service.toPublic(row),
        note: 'Transaction id recorded as a claim. It does not confirm payment until independently observed.',
      });
    } catch (err) {
      const { statusCode, body } = toErrorReply(err);
      return reply.code(statusCode).send(body);
    }
  });

  /** Ask BLINK to check the blockchain. Read-only; provider-driven. */
  app.post('/v1/payment-requests/:shortCode/verify', async (req, reply) => {
    const { shortCode } = req.params as { shortCode: string };
    try {
      const { row, outcome } = await service.verify(shortCode);
      return reply.send({
        request: service.toPublic(row),
        verification: {
          observed: outcome.observed,
          provider: config.BLINK_VERIFICATION_PROVIDER,
          confirmations: outcome.confirmations,
          status: outcome.status,
        },
      });
    } catch (err) {
      const { statusCode, body } = toErrorReply(err);
      return reply.code(statusCode).send(body);
    }
  });

  /** Cancel a request. Requires the management token. */
  app.post('/v1/payment-requests/:shortCode/cancel', async (req, reply) => {
    const { shortCode } = req.params as { shortCode: string };
    const token = (req.headers['x-blink-management-token'] as string | undefined) ?? '';
    try {
      const row = await service.findByShortCode(shortCode);
      if (!row)
        return reply.code(404).send({ error: 'not_found', message: 'payment request not found' });
      if (token !== row.id) {
        return reply.code(403).send({ error: 'forbidden', message: 'management token required' });
      }
      const cancelled = await service.cancel(shortCode);
      return reply.send({ request: service.toPublic(cancelled) });
    } catch (err) {
      const { statusCode, body } = toErrorReply(err);
      return reply.code(statusCode).send(body);
    }
  });

  /** Activity for the authenticated owner. */
  app.get('/v1/activity', async (req, reply) => {
    const ownerId = deps.resolveOwner ? await deps.resolveOwner(req) : null;
    if (!ownerId) {
      return reply.code(401).send({ error: 'unauthorized', message: 'sign in to view activity' });
    }
    const rows = await service.listForOwner(ownerId);
    return reply.send({ requests: rows.map((r) => service.toPublic(r)) });
  });

  /** Receipt / proof of payment. */
  app.get('/v1/payment-requests/:shortCode/receipt', async (req, reply) => {
    const { shortCode } = req.params as { shortCode: string };
    const row = await service.findByShortCode(shortCode);
    if (!row)
      return reply.code(404).send({ error: 'not_found', message: 'payment request not found' });
    await service.effectiveStatus(row);
    const fresh = (await service.findByShortCode(shortCode))!;
    if (fresh.status !== 'CONFIRMED') {
      return reply.code(409).send({
        error: 'not_confirmed',
        message: 'a receipt is only issued for a confirmed payment',
      });
    }
    return reply.send({
      receipt: {
        shortCode: fresh.shortCode,
        amount: fresh.amount,
        // The receipt settles in ZEC; the original USD request is shown alongside.
        currency: 'ZEC',
        usdAmount: fresh.usdAmount,
        zecUsdPrice: fresh.zecUsdPrice,
        memo: fresh.memo,
        network: fresh.network,
        privacy: service.privacyOf(fresh),
        status: fresh.status,
        txid: fresh.txid,
        confirmations: fresh.confirmations,
        paidAt: fresh.updatedAt.toISOString(),
        statement:
          'This receipt confirms that BLINK observed a confirmed Zcash transaction associated with this payment request. BLINK cannot cryptographically prove the sender, recipient or amount of a shielded transaction; those details are private to the parties involved.',
      },
    });
  });

  // Expose allowed expiry options so the client never invents one.
  app.get('/v1/meta/expiry-options', async () => ({ options: ALLOWED_EXPIRY_MINUTES }));

  /**
   * Authoritative network identity. The web app compares this against its own
   * build-time NEXT_PUBLIC_NETWORK and fails closed on any disagreement, so a
   * frontend can never silently transact on a different network than the API.
   */
  app.get('/v1/meta/network', async () => ({
    network: config.ZCASH_NETWORK,
    verificationProvider: config.BLINK_VERIFICATION_PROVIDER,
    priceProvider: config.BLINK_PRICE_PROVIDER,
  }));
}
