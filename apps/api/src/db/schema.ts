/**
 * BLINK database schema (PostgreSQL, via Drizzle ORM).
 *
 * Design notes
 * ------------
 * * Recipient addresses are stored encrypted (`recipient_address_encrypted`).
 *   The plaintext never appears in the database.
 * * Blockchain-derived state (txid, confirmations, broadcast) lives in its own
 *   table, `transactions`, which only the verification layer writes to. User
 *   metadata lives in `payment_requests`. This separation is what makes it
 *   impossible for a client to forge a confirmation.
 * * `payment_events` is append-only.
 * * No seed phrases or private keys are ever stored.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Optional display handle. */
    handle: text('handle'),
    /** Ed25519-style public key hex, if the user opts into a local identity. */
    publicKey: text('public_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    handleIdx: uniqueIndex('users_handle_idx').on(t.handle),
  }),
);

export const paymentRequests = pgTable(
  'payment_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Cryptographically random, URL-safe short code. Never sequential. */
    shortCode: text('short_code').notNull(),
    recipientName: text('recipient_name').notNull(),
    /** AES-256-GCM ciphertext of the recipient Zcash address. */
    recipientAddressEncrypted: text('recipient_address_encrypted').notNull(),
    /** Address kind, e.g. transparent | sapling | unified. Non-sensitive. */
    recipientAddressKind: text('recipient_address_kind'),
    /** Non-sensitive fingerprint (truncated SHA-256) for display/debugging. */
    recipientAddressFingerprint: text('recipient_address_fingerprint'),
    amount: text('amount').notNull(),
    currency: text('currency').notNull().default('ZEC'),
    /**
     * Original requested amount in USD, when the recipient denominated the
     * request in USD. Null for a native ZEC request. Kept so the payer always
     * sees exactly what was requested, independent of later market moves.
     */
    usdAmount: text('usd_amount'),
    /** ZEC/USD price used to convert `usdAmount`. Null for a native ZEC request. */
    zecUsdPrice: text('zec_usd_price'),
    /** Price provider id, e.g. "coinmarketcap". */
    priceProvider: text('price_provider'),
    /** Provider price timestamp, when supplied. */
    priceObservedAt: timestamp('price_observed_at', { withTimezone: true }),
    memo: text('memo'),
    label: text('label'),
    message: text('message'),
    network: text('network').notNull(),
    /**
     * Privacy capability snapshot derived from the recipient address kind at
     * creation. Stored (rather than recomputed on read) so a receipt always
     * reports exactly what was shown when the request was made, and so the
     * wording can never drift to over-claim privacy.
     */
    privacy: jsonb('privacy'),
    /** The ZIP 321 URI. Contains the address, so access is controlled. */
    zip321Uri: text('zip321_uri').notNull(),
    status: text('status').notNull().default('CREATED'),
    /**
     * The txid reported by the payer's wallet. This is an untrusted claim: it is
     * never treated as proof. `txid` below is set only by the verification layer
     * after it has observed the transaction on-chain.
     */
    claimedTxid: text('claimed_txid'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** Set only by the verification layer. */
    txid: text('txid'),
    confirmations: integer('confirmations').notNull().default(0),
    /** Owning user, when the recipient has an identity. */
    ownerId: uuid('owner_id').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shortCodeIdx: uniqueIndex('payment_requests_short_code_idx').on(t.shortCode),
    statusIdx: index('payment_requests_status_idx').on(t.status),
    ownerIdx: index('payment_requests_owner_idx').on(t.ownerId),
  }),
);

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentRequestId: uuid('payment_request_id')
      .notNull()
      .references(() => paymentRequests.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    data: jsonb('data').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    requestIdx: index('payment_events_request_idx').on(t.paymentRequestId),
  }),
);

/**
 * Blockchain-observed state. Written exclusively by the verification layer.
 * A client can never mutate these rows; there is no API route that exposes a
 * write to them.
 */
export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentRequestId: uuid('payment_request_id')
      .notNull()
      .references(() => paymentRequests.id, { onDelete: 'cascade' }),
    txid: text('txid').notNull(),
    confirmations: integer('confirmations').notNull().default(0),
    broadcast: boolean('broadcast').notNull().default(false),
    blockHeight: integer('block_height'),
    source: text('source').notNull(),
    /** Raw, redacted provider payload for auditability. */
    rawObservation: jsonb('raw_observation'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    txidIdx: uniqueIndex('transactions_txid_idx').on(t.txid),
    requestIdx: index('transactions_request_idx').on(t.paymentRequestId),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('sessions_token_hash_idx').on(t.tokenHash),
  }),
);
