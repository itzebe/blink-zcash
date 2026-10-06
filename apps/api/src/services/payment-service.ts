/**
 * Payment request service.
 *
 * Owns the lifecycle of a BLINK payment request: creation, sharing, payer
 * claims, and status reads. Blockchain-derived fields are only ever written by
 * `verifyRequest`, which delegates to a verification provider that reports only
 * what it actually observed.
 */
import {
  assertTransition,
  canTransition,
  ALLOWED_EXPIRY_MINUTES,
  MAX_MEMO_BYTES,
  convertUsdToZec,
  settledZecAmount,
  formatZatoshisToZec,
  normaliseUsdAmount,
  parseZecToZatoshis,
  privacyCapability,
  type Currency,
  type PaymentPurpose,
  type PaymentStatus,
  type PrivacyCapability,
  type PublicPaymentRequest,
  type ZcashNetwork,
} from '@blink/shared';
import { buildZip321Uri } from '@blink/payment-request';
import {
  addressFingerprint,
  parseAddress,
  InvalidAddressError,
  type AddressKind,
} from '@blink/zcash';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { paymentEvents, paymentRequests, transactions } from '../db/schema.js';
import type { Crypto } from '../crypto.js';
import { generateShortCode, isValidShortCode } from './short-code.js';
import type { EngineUnavailableError, ZcashEngine } from './zcash-engine.js';
import type { VerificationProvider } from './verification-provider.js';
import { PriceUnavailableError, type ZecUsdPriceProvider } from './price-service.js';

export interface CreatePaymentRequestInput {
  recipientName: string;
  recipientAddress: string;
  /**
   * Requested amount. When `currency` is `ZEC` (default) this is a ZEC decimal
   * string. When `currency` is `USD` this is a USD decimal string that the
   * server converts to ZEC using a live price.
   */
  amount: string;
  currency?: Currency;
  memo?: string | null;
  label?: string | null;
  message?: string | null;
  /** Everyday workflow label. Presentation metadata; defaults to `invoice`. */
  purpose?: PaymentPurpose;
  expiryMinutes?: number;
  ownerId?: string | null;
}

export class PaymentRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'PaymentRequestError';
  }
}

export interface PaymentServiceOptions {
  db: Database;
  crypto: Crypto;
  engine: ZcashEngine;
  provider: VerificationProvider;
  network: ZcashNetwork;
  confirmationsRequired: number;
  /**
   * Live ZEC/USD price source. Required only to create USD-denominated
   * requests; a native ZEC request never calls it.
   */
  priceProvider?: ZecUsdPriceProvider;
  now?: () => Date;
  /** Test hook: lets tests force a deterministic short code. */
  generateCode?: () => string;
}

export interface VerificationOutcome {
  status: PaymentStatus;
  txid: string | null;
  confirmations: number;
  observed: boolean;
}

export class PaymentService {
  private readonly now: () => Date;

  constructor(private readonly opts: PaymentServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Validate a recipient address. Uses the authoritative Rust engine when it is
   * configured, otherwise the local packages. Network mismatch is always a hard
   * error.
   */
  private async resolveAddress(
    address: string,
    network: ZcashNetwork,
  ): Promise<{ kind: AddressKind }> {
    if (this.opts.engine.configured) {
      try {
        const result = await this.opts.engine.inspectAddress(address, network);
        return { kind: result.value.kind };
      } catch (err) {
        const message = (err as EngineUnavailableError).message;
        throw new PaymentRequestError(
          `recipient address rejected: ${message}`,
          'invalid_address',
          400,
        );
      }
    }

    try {
      const parsed = parseAddress(address);
      if (parsed.network !== network) {
        throw new PaymentRequestError(
          `address is for ${parsed.network} but BLINK is configured for ${network}`,
          'invalid_network',
          400,
        );
      }
      return { kind: parsed.kind };
    } catch (err) {
      if (err instanceof InvalidAddressError) {
        throw new PaymentRequestError(err.message, 'invalid_address', 400);
      }
      throw err;
    }
  }

  private validateMemo(memo: string | null | undefined, kind: AddressKind): string | null {
    if (memo === undefined || memo === null || memo === '') return null;
    if (kind === 'transparent') {
      throw new PaymentRequestError(
        'memos can only be attached to shielded (Sapling or Unified) recipients',
        'memo_unsupported',
      );
    }
    const bytes = Buffer.byteLength(memo, 'utf8');
    if (bytes > MAX_MEMO_BYTES) {
      throw new PaymentRequestError(
        `memo exceeds the ${MAX_MEMO_BYTES}-byte Zcash memo limit`,
        'memo_too_long',
      );
    }
    return memo;
  }

  private async buildUri(
    address: string,
    amount: string,
    memo: string | null,
    label: string | null,
    message: string | null,
  ): Promise<string> {
    if (this.opts.engine.configured) {
      try {
        const result = await this.opts.engine.buildUri(
          [
            {
              address,
              amount,
              ...(memo ? { memo } : {}),
              ...(label ? { label } : {}),
              ...(message ? { message } : {}),
            },
          ],
          this.opts.network,
        );
        return result.value;
      } catch (err) {
        throw new PaymentRequestError(
          `could not build payment request: ${(err as Error).message}`,
          'invalid_payment_request',
        );
      }
    }
    try {
      return buildZip321Uri(
        [
          {
            address,
            amount,
            memo: memo ?? undefined,
            label: label ?? undefined,
            message: message ?? undefined,
          },
        ],
        {
          network: this.opts.network,
        },
      );
    } catch (err) {
      throw new PaymentRequestError(
        `could not build payment request: ${(err as Error).message}`,
        'invalid_payment_request',
      );
    }
  }

  /**
   * Resolve the requested amount into the ZEC amount ZIP 321 will carry.
   *
   * A ZEC request is validated and canonicalised locally. A USD request is
   * converted server-side using a live price — the client can never supply the
   * ZEC amount, so a malicious client cannot claim an arbitrary conversion.
   */
  private async resolveAmount(input: CreatePaymentRequestInput): Promise<{
    currency: Currency;
    zecAmount: string;
    usdAmount: string | null;
    zecUsdPrice: string | null;
    priceProvider: string | null;
    priceObservedAt: Date | null;
  }> {
    const currency: Currency = input.currency ?? 'ZEC';

    if (currency === 'ZEC') {
      let zecAmount: string;
      try {
        zecAmount = formatZatoshisToZec(parseZecToZatoshis(input.amount));
      } catch (err) {
        throw new PaymentRequestError(`invalid amount: ${(err as Error).message}`, 'invalid_amount');
      }
      return {
        currency,
        zecAmount,
        usdAmount: null,
        zecUsdPrice: null,
        priceProvider: null,
        priceObservedAt: null,
      };
    }

    if (currency !== 'USD') {
      throw new PaymentRequestError('only ZEC and USD are supported', 'unsupported_currency');
    }

    let usdAmount: string;
    try {
      usdAmount = normaliseUsdAmount(input.amount);
    } catch (err) {
      throw new PaymentRequestError(
        `invalid USD amount: ${(err as Error).message}`,
        'invalid_amount',
      );
    }

    const priceProvider = this.opts.priceProvider;
    if (!priceProvider) {
      throw new PaymentRequestError(
        'USD-denominated requests require a configured price provider',
        'price_unavailable',
        503,
      );
    }

    let price;
    try {
      price = await priceProvider.getZecUsdPrice();
    } catch (err) {
      if (err instanceof PriceUnavailableError) {
        throw new PaymentRequestError(
          `could not obtain a live ZEC/USD price: ${err.message}`,
          err.code === 'not_configured' ? 'price_not_configured' : 'price_unavailable',
          503,
        );
      }
      throw err;
    }

    let conversion;
    try {
      conversion = convertUsdToZec(usdAmount, price.price);
    } catch (err) {
      throw new PaymentRequestError(
        `could not convert USD to ZEC: ${(err as Error).message}`,
        'conversion_failed',
      );
    }

    // USD almost never converts to a whole number of zatoshis. `settledZecAmount`
    // rounds UP to the next zatoshi so the request always asks for at least the
    // USD-equivalent value (over-ask < 1 zatoshi), never rounds down, and never
    // collapses the amount to the raw USD figure.
    return {
      currency,
      zecAmount: settledZecAmount(conversion),
      usdAmount: conversion.usd,
      zecUsdPrice: conversion.price,
      priceProvider: price.provider,
      priceObservedAt: price.observedAt ? new Date(price.observedAt) : null,
    };
  }

  async create(input: CreatePaymentRequestInput) {
    const resolved = await this.resolveAmount(input);
    const canonicalAmount = resolved.zecAmount;

    const expiryMinutes = input.expiryMinutes ?? 30;
    if (
      !ALLOWED_EXPIRY_MINUTES.includes(expiryMinutes as (typeof ALLOWED_EXPIRY_MINUTES)[number])
    ) {
      throw new PaymentRequestError(
        `expiry must be one of ${ALLOWED_EXPIRY_MINUTES.join(', ')} minutes`,
        'invalid_expiry',
      );
    }

    const recipientName = input.recipientName?.trim();
    if (!recipientName || recipientName.length > 64) {
      throw new PaymentRequestError(
        'recipient name is required (max 64 characters)',
        'invalid_recipient',
      );
    }

    const { kind } = await this.resolveAddress(input.recipientAddress, this.opts.network);
    const memo = this.validateMemo(input.memo, kind);
    const label = input.label?.trim() || null;
    const message = input.message?.trim() || null;
    const purpose: PaymentPurpose = input.purpose ?? 'invoice';

    // Snapshot the protocol-accurate privacy capability of this route from the
    // recipient address kind. Stored so a receipt always reports what was shown.
    const privacy = privacyCapability(kind);

    const uri = await this.buildUri(input.recipientAddress, canonicalAmount, memo, label, message);

    const now = this.now();
    const expiresAt = new Date(now.getTime() + expiryMinutes * 60_000);

    const code = await this.uniqueCode();
    const encrypted = this.opts.crypto.encrypt(input.recipientAddress);
    const fingerprint = addressFingerprint(input.recipientAddress);

    const inserted = await this.opts.db
      .insert(paymentRequests)
      .values({
        shortCode: code,
        recipientName,
        recipientAddressEncrypted: encrypted,
        recipientAddressKind: kind,
        recipientAddressFingerprint: fingerprint,
        amount: canonicalAmount,
        currency: resolved.currency,
        purpose,
        usdAmount: resolved.usdAmount,
        zecUsdPrice: resolved.zecUsdPrice,
        priceProvider: resolved.priceProvider,
        priceObservedAt: resolved.priceObservedAt,
        memo,
        label,
        message,
        network: this.opts.network,
        privacy,
        zip321Uri: uri,
        status: 'WAITING_FOR_PAYMENT',
        ownerId: input.ownerId ?? null,
        expiresAt,
      })
      .returning();

    const row = inserted[0]!;
    await this.recordEvent(row.id, 'CREATED', { shortCode: code, network: this.opts.network });
    return row;
  }

  private async uniqueCode(): Promise<string> {
    const generate = this.opts.generateCode ?? (() => generateShortCode());
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generate();
      if (!isValidShortCode(code)) continue;
      const existing = await this.opts.db
        .select({ id: paymentRequests.id })
        .from(paymentRequests)
        .where(eq(paymentRequests.shortCode, code))
        .limit(1);
      if (existing.length === 0) return code;
    }
    throw new PaymentRequestError('could not allocate a unique short code', 'internal', 500);
  }

  async recordEvent(
    paymentRequestId: string,
    type: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.opts.db.insert(paymentEvents).values({ paymentRequestId, type, data });
  }

  async findByShortCode(shortCode: string) {
    if (!isValidShortCode(shortCode)) return null;
    const rows = await this.opts.db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.shortCode, shortCode))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Public projection. Does not include the raw address or the URI. */
  toPublic(row: typeof paymentRequests.$inferSelect): PublicPaymentRequest {
    return {
      shortCode: row.shortCode,
      recipientName: row.recipientName,
      amount: row.amount,
      // ZIP 321 amounts are always ZEC; a USD request is settled in ZEC.
      currency: 'ZEC',
      usdAmount: row.usdAmount,
      zecUsdPrice: row.zecUsdPrice,
      priceProvider: row.priceProvider,
      priceObservedAt: row.priceObservedAt ? row.priceObservedAt.toISOString() : null,
      purpose: (row.purpose ?? 'invoice') as PaymentPurpose,
      memo: row.memo,
      network: row.network as ZcashNetwork,
      status: row.status as PaymentStatus,
      confirmations: row.confirmations,
      txidShort: row.txid ? `${row.txid.slice(0, 8)}…${row.txid.slice(-6)}` : null,
      privacy: this.privacyOf(row),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * The privacy capability for a row. Uses the stored snapshot, falling back to
   * deriving it from the address kind for rows created before privacy was
   * persisted. Never guesses beyond the address kind the request actually used.
   */
  privacyOf(row: typeof paymentRequests.$inferSelect): PrivacyCapability {
    const stored = row.privacy as PrivacyCapability | null | undefined;
    if (stored && typeof stored === 'object' && stored.recipientKind) return stored;
    const kind = row.recipientAddressKind as AddressKind | null | undefined;
    return privacyCapability(kind ?? 'transparent');
  }

  isExpired(row: typeof paymentRequests.$inferSelect): boolean {
    return row.expiresAt.getTime() <= this.now().getTime();
  }

  /**
   * Apply expiry lazily and return the up-to-date status. Expiry only applies to
   * the BLINK request layer; it does not make an on-chain transaction
   * impossible, and we say so in the UI.
   */
  async effectiveStatus(row: typeof paymentRequests.$inferSelect): Promise<PaymentStatus> {
    const status = row.status as PaymentStatus;
    if (
      status === 'WAITING_FOR_PAYMENT' ||
      status === 'CREATED' ||
      status === 'PAYMENT_INITIATED'
    ) {
      if (this.isExpired(row)) {
        await this.transition(row, 'EXPIRED');
        return 'EXPIRED';
      }
    }
    return status;
  }

  private async transition(
    row: typeof paymentRequests.$inferSelect,
    to: PaymentStatus,
    extra: Partial<typeof paymentRequests.$inferInsert> = {},
  ): Promise<boolean> {
    const from = row.status as PaymentStatus;
    if (!canTransition(from, to)) return false;
    assertTransition(from, to);
    await this.opts.db
      .update(paymentRequests)
      .set({ status: to, updatedAt: this.now(), ...extra })
      .where(and(eq(paymentRequests.id, row.id), eq(paymentRequests.status, from)));
    return true;
  }

  /** The payer opened the link and started the payment flow. */
  async markInitiated(shortCode: string) {
    const row = await this.findByShortCode(shortCode);
    if (!row) throw new PaymentRequestError('payment request not found', 'not_found', 404);
    const status = await this.effectiveStatus(row);

    if (status === 'CONFIRMED' || status === 'BROADCAST' || status === 'CONFIRMING') {
      throw new PaymentRequestError(
        'this payment request has already been paid',
        'already_paid',
        409,
      );
    }
    if (status === 'EXPIRED') {
      throw new PaymentRequestError('this payment request has expired', 'expired', 410);
    }
    if (status === 'CANCELLED' || status === 'FAILED') {
      throw new PaymentRequestError(
        `this payment request is ${status.toLowerCase()}`,
        status.toLowerCase(),
        409,
      );
    }

    await this.transition(row, 'PAYMENT_INITIATED');
    await this.recordEvent(row.id, 'PAYMENT_INITIATED', {});
    return (await this.findByShortCode(shortCode))!;
  }

  /**
   * Record a txid the payer's wallet reported. This is an untrusted claim: it is
   * stored separately from verified blockchain state and never marks the payment
   * complete on its own.
   */
  async claimTxid(shortCode: string, txid: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new PaymentRequestError('transaction id must be 64 hex characters', 'invalid_txid');
    }
    const row = await this.findByShortCode(shortCode);
    if (!row) throw new PaymentRequestError('payment request not found', 'not_found', 404);

    const status = await this.effectiveStatus(row);
    if (status === 'CONFIRMED') {
      throw new PaymentRequestError(
        'this payment request has already been paid',
        'already_paid',
        409,
      );
    }
    if (status === 'EXPIRED' || status === 'CANCELLED') {
      throw new PaymentRequestError(
        `this payment request is ${status.toLowerCase()}`,
        status.toLowerCase(),
        410,
      );
    }

    await this.opts.db
      .update(paymentRequests)
      .set({ claimedTxid: txid, claimedAt: this.now(), updatedAt: this.now() })
      .where(eq(paymentRequests.id, row.id));

    const fresh = (await this.findByShortCode(shortCode))!;
    await this.transition(fresh, 'TRANSACTION_CREATED');
    await this.recordEvent(row.id, 'TRANSACTION_DETECTED', { claimed: true });
    return (await this.findByShortCode(shortCode))!;
  }

  /**
   * Ask the verification provider to observe the transaction, then update the
   * request from what was actually observed. If nothing is observed, the status
   * is left exactly as it was.
   */
  async verify(
    shortCode: string,
  ): Promise<{ row: typeof paymentRequests.$inferSelect; outcome: VerificationOutcome }> {
    const row = await this.findByShortCode(shortCode);
    if (!row) throw new PaymentRequestError('payment request not found', 'not_found', 404);

    await this.effectiveStatus(row);
    const current = (await this.findByShortCode(shortCode))!;

    const observation = await this.opts.provider.observe({
      claimedTxid: current.claimedTxid ?? undefined,
      network: current.network as ZcashNetwork,
    });

    if (!observation) {
      return {
        row: current,
        outcome: {
          status: current.status as PaymentStatus,
          txid: current.txid,
          confirmations: current.confirmations,
          observed: false,
        },
      };
    }

    // Persist the observation, keyed by txid. Upsert keeps confirmations fresh.
    await this.opts.db
      .insert(transactions)
      .values({
        paymentRequestId: current.id,
        txid: observation.txid,
        confirmations: observation.confirmations,
        broadcast: observation.broadcast,
        blockHeight: observation.blockHeight ?? null,
        source: observation.source,
        rawObservation: observation.raw ?? {},
      })
      .onConflictDoUpdate({
        target: transactions.txid,
        set: {
          confirmations: observation.confirmations,
          broadcast: observation.broadcast,
          blockHeight: observation.blockHeight ?? null,
          source: observation.source,
          rawObservation: observation.raw ?? {},
          observedAt: this.now(),
        },
      });

    const required = this.opts.confirmationsRequired;
    let next: PaymentStatus;
    if (observation.confirmations >= required && required > 0) {
      next = 'CONFIRMED';
    } else if (observation.confirmations > 0) {
      next = 'CONFIRMING';
    } else if (observation.broadcast) {
      next = 'BROADCAST';
    } else {
      next = current.status as PaymentStatus;
    }

    const patch: Partial<typeof paymentRequests.$inferInsert> = {
      txid: observation.txid,
      confirmations: observation.confirmations,
      updatedAt: this.now(),
    };

    if (canTransition(current.status as PaymentStatus, next)) {
      patch.status = next;
      await this.opts.db
        .update(paymentRequests)
        .set(patch)
        .where(eq(paymentRequests.id, current.id));
      if (next === 'CONFIRMED') {
        await this.recordEvent(current.id, 'CONFIRMED', {
          txid: observation.txid,
          confirmations: observation.confirmations,
          source: observation.source,
        });
      } else {
        await this.recordEvent(current.id, 'CONFIRMATION', {
          txid: observation.txid,
          confirmations: observation.confirmations,
          source: observation.source,
          status: next,
        });
      }
    } else {
      await this.opts.db
        .update(paymentRequests)
        .set(patch)
        .where(eq(paymentRequests.id, current.id));
    }

    const fresh = (await this.findByShortCode(shortCode))!;
    return {
      row: fresh,
      outcome: {
        status: fresh.status as PaymentStatus,
        txid: fresh.txid,
        confirmations: fresh.confirmations,
        observed: true,
      },
    };
  }

  async cancel(shortCode: string) {
    const row = await this.findByShortCode(shortCode);
    if (!row) throw new PaymentRequestError('payment request not found', 'not_found', 404);
    const status = row.status as PaymentStatus;
    if (status === 'CONFIRMED') {
      throw new PaymentRequestError('a confirmed payment cannot be cancelled', 'already_paid', 409);
    }
    if (!canTransition(status, 'CANCELLED')) {
      throw new PaymentRequestError(
        `a ${status.toLowerCase()} request cannot be cancelled`,
        'invalid_state',
        409,
      );
    }
    await this.opts.db
      .update(paymentRequests)
      .set({ status: 'CANCELLED', updatedAt: this.now() })
      .where(eq(paymentRequests.id, row.id));
    await this.recordEvent(row.id, 'CANCELLED', {});
    return (await this.findByShortCode(shortCode))!;
  }

  async listEvents(paymentRequestId: string) {
    return this.opts.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentRequestId, paymentRequestId))
      .orderBy(paymentEvents.createdAt);
  }

  /** Expire requests whose deadline has passed and that are still awaiting payment. */
  async expireStale(): Promise<number> {
    const now = this.now();
    const result = await this.opts.db
      .update(paymentRequests)
      .set({ status: 'EXPIRED', updatedAt: now })
      .where(
        and(
          sql`${paymentRequests.status} IN ('CREATED','WAITING_FOR_PAYMENT','PAYMENT_INITIATED')`,
          lt(paymentRequests.expiresAt, now),
        ),
      )
      .returning({ id: paymentRequests.id });
    return result.length;
  }
}
