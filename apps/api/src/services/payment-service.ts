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
  shieldedOnlyPolicy,
  withUnifiedReceivers,
  type Currency,
  type PaymentPurpose,
  type PaymentStatus,
  type PrivacyCapability,
  type PublicPaymentRequest,
  type ShieldedReceivers,
  type ShieldedVerificationRecord,
  type ShieldedVerificationState,
  type ZcashNetwork,
} from '@blink/shared';
import { buildZip321Uri } from '@blink/payment-request';
import {
  addressFingerprint,
  parseAddress,
  InvalidAddressError,
  type AddressKind,
  type ReceiverPools,
} from '@blink/zcash';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { paymentEvents, paymentRequests, transactions } from '../db/schema.js';
import type { Crypto } from '../crypto.js';
import { generateShortCode, isValidShortCode } from './short-code.js';
import { EngineUnavailableError, type ZcashEngine } from './zcash-engine.js';
import type { Observation, VerificationProvider } from './verification-provider.js';
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
  /**
   * The honest shielded-payment verification result, when the verification layer
   * had authoritative evidence to classify. `null`/absent when nothing was
   * observed or the transaction's composition could not be decoded.
   */
  shielded?: ShieldedVerificationRecord | null;
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
   *
   * A **definitive** engine rejection (the engine answered and rejected the
   * address) is a real validation failure. A **transient** engine problem
   * (timeout, connection error, 5xx — e.g. the engine cold-starting) is retried
   * a bounded number of times, and if it still cannot be reached the request
   * fails with `engine_unavailable` (503) rather than reporting a valid address
   * as invalid.
   */
  private async resolveAddress(
    address: string,
    network: ZcashNetwork,
  ): Promise<{ kind: AddressKind; receivers: ReceiverPools }> {
    if (this.opts.engine.configured) {
      try {
        const result = await this.callEngine(() =>
          this.opts.engine.inspectAddress(address, network),
        );
        return { kind: result.value.kind, receivers: result.value.receivers };
      } catch (err) {
        if (err instanceof EngineUnavailableError && err.reason === 'rejected') {
          throw new PaymentRequestError(
            `recipient address rejected: ${err.message}`,
            'invalid_address',
            400,
          );
        }
        throw new PaymentRequestError(
          `could not validate the recipient address: ${(err as Error).message}`,
          'engine_unavailable',
          503,
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
      return { kind: parsed.kind, receivers: parsed.receivers };
    } catch (err) {
      if (err instanceof InvalidAddressError) {
        throw new PaymentRequestError(err.message, 'invalid_address', 400);
      }
      throw err;
    }
  }

  /**
   * Enforce BLINK's shielded-first recipient policy against the *actual* decoded
   * ZIP 316 receiver composition — never the `u…` prefix and never the mere
   * existence of a shielded receiver.
   *
   * Refused outright:
   *   - a bare transparent address, and
   *   - a Unified Address that also exposes a transparent receiver (a "mixed"
   *     UA), because ZIP 321 gives the payer's wallet no way to prove it will
   *     pick the shielded receiver; it may silently settle into the transparent
   *     one and make the recipient and amount public on-chain.
   *
   * Fails closed when the composition is unknown.
   */
  private assertShieldedRecipient(receivers: ReceiverPools): ShieldedReceivers {
    const verdict = shieldedOnlyPolicy(receivers);
    if (verdict.ok) return verdict.receivers;
    if (verdict.reason === 'transparent_recipient') {
      throw new PaymentRequestError(
        'BLINK requires a shielded-only recipient: this address can receive transparently, which would expose the payment on-chain',
        'transparent_recipient',
      );
    }
    throw new PaymentRequestError(
      'BLINK could not confirm a shielded-only receiver in this recipient address',
      'shielded_receiver_unconfirmed',
    );
  }

  /**
   * Run an engine call, retrying only transient unavailability. A definitive
   * rejection is returned immediately (it is a verdict, not a hiccup). The
   * retries absorb a cold-starting engine without ever inventing a result.
   */
  private async callEngine<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!(err instanceof EngineUnavailableError) || err.reason !== 'unreachable') {
          throw err;
        }
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }
    throw lastError;
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
        const result = await this.callEngine(() =>
          this.opts.engine.buildUri(
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
          ),
        );
        return result.value;
      } catch (err) {
        if (err instanceof EngineUnavailableError && err.reason === 'rejected') {
          throw new PaymentRequestError(
            `could not build payment request: ${err.message}`,
            'invalid_payment_request',
            400,
          );
        }
        throw new PaymentRequestError(
          `could not build payment request: ${(err as Error).message}`,
          'engine_unavailable',
          503,
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

    const { kind, receivers } = await this.resolveAddress(
      input.recipientAddress,
      this.opts.network,
    );
    // A transparent-capable destination is refused outright (shielded-first).
    const shieldedReceivers = this.assertShieldedRecipient(receivers);
    const memo = this.validateMemo(input.memo, kind);
    const label = input.label?.trim() || null;
    const message = input.message?.trim() || null;
    const purpose: PaymentPurpose = input.purpose ?? 'invoice';

    // Snapshot the protocol-accurate privacy capability of this route, refined by
    // the address's real receiver composition. Because a mixed (transparent-
    // bearing) Unified Address never reaches here, the stored snapshot can only
    // ever describe a shielded-only route.
    const privacy = withUnifiedReceivers(privacyCapability(kind), shieldedReceivers);

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

    // Pass the requested recipient so the engine can establish, from the public
    // bytes, whether the transaction pays the recipient's transparent receiver.
    // The address is decrypted only in-process, only for this engine call, and is
    // never logged or returned.
    let expectedAddress: string | undefined;
    try {
      expectedAddress = this.opts.crypto.decrypt(current.recipientAddressEncrypted);
    } catch {
      expectedAddress = undefined;
    }

    const observation = await this.opts.provider.observe({
      claimedTxid: current.claimedTxid ?? undefined,
      network: current.network as ZcashNetwork,
      ...(expectedAddress ? { expectedAddress } : {}),
    });

    if (!observation) {
      return {
        row: current,
        outcome: {
          status: current.status as PaymentStatus,
          txid: current.txid,
          confirmations: current.confirmations,
          observed: false,
          shielded: null,
        },
      };
    }

    // Classify what the public transaction bytes actually establish. An
    // observation with no evidence (an older provider, or bytes the engine could
    // not decode) is classified conservatively as `observed`, never as a verified
    // shielded settlement.
    const shieldedRecord = this.classifyShieldedVerification(current, observation);

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
    // A public settlement that contradicts the shielded request (a transparent
    // payment to a shielded-only recipient, or a transaction that touches no
    // shielded pool at all) must never be promoted to CONFIRMED, however many
    // confirmations it has. It stays unverified.
    const contradictsShielded =
      shieldedRecord?.state === 'transparent_settlement' ||
      shieldedRecord?.state === 'contradictory';

    let next: PaymentStatus;
    if (contradictsShielded) {
      next = 'UNKNOWN';
    } else if (observation.confirmations >= required && required > 0) {
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
      shieldedVerification: shieldedRecord,
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
          shieldedState: shieldedRecord?.state ?? null,
        });
      } else if (contradictsShielded) {
        await this.recordEvent(current.id, 'FAILED', {
          txid: observation.txid,
          source: observation.source,
          reason: 'settlement_contradicts_shielded_request',
          shieldedState: shieldedRecord?.state ?? null,
        });
      } else {
        await this.recordEvent(current.id, 'CONFIRMATION', {
          txid: observation.txid,
          confirmations: observation.confirmations,
          source: observation.source,
          status: next,
          shieldedState: shieldedRecord?.state ?? null,
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
        shielded: shieldedRecord,
      },
    };
  }

  /**
   * Classify what a provider's observation actually establishes about a shielded
   * payment, from the public facts only.
   *
   * The ordering is deliberate and the distinctions are explicit:
   *
   *  1. If the transaction provably pays the requested recipient's transparent
   *     receiver, that is a `contradictory` settlement for a shielded request —
   *     the payment is public. (If the recipient is transparent-capable, this is
   *     the one case where the recipient and amount are independently verified.)
   *  2. Else if the transaction touches no shielded pool, the settlement is a
   *     `transparent_settlement`: public, so it contradicts a shielded request.
   *  3. Else if a shielded bundle is present and the recipient's transparent
   *     receiver was not paid, shielded activity is `shielded_activity_observed`.
   *     The recipient and amount remain unprovable from public data.
   *  4. Otherwise the composition is unknown: report plain `observed`.
   *
   * It never claims a shielded recipient or amount was paid: shielded transfers
   * do not expose them.
   */
  private classifyShieldedVerification(
    row: typeof paymentRequests.$inferSelect,
    observation: Observation,
  ): ShieldedVerificationRecord {
    const evidence = observation.evidence;
    const recipientKind = row.recipientAddressKind as AddressKind | null | undefined;
    const observedAt = this.now().toISOString();

    const transparentPaid = (evidence?.transparentRecipientZatoshis ?? null) !== null;
    const pools = evidence
      ? {
          transparent: evidence.pools.transparent,
          sapling: evidence.pools.sapling,
          orchard: evidence.pools.orchard,
          shielded: evidence.pools.shielded,
        }
      : null;

    // The only state in which a third party can independently verify recipient
    // and amount: the recipient exposes a transparent receiver and the
    // transaction pays it.
    let state: ShieldedVerificationState;
    if (transparentPaid) {
      state = recipientKind === 'transparent' ? 'recipient_verified' : 'contradictory';
    } else if (pools && !pools.shielded) {
      state = 'transparent_settlement';
    } else if (pools && pools.shielded) {
      state = 'shielded_activity_observed';
    } else {
      state = 'observed';
    }

    return {
      state,
      txid: observation.txid,
      pools,
      transparentRecipientZatoshis: evidence?.transparentRecipientZatoshis ?? null,
      recipientVerified: state === 'recipient_verified',
      amountVerified: state === 'recipient_verified',
      source: observation.source,
      observedAt,
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
