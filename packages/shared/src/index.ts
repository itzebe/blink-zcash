/**
 * Shared domain vocabulary for BLINK.
 *
 * This module is deliberately dependency-free so that it can be imported by the
 * API, the web client, the payment-request package and test harnesses without
 * pulling in any runtime concerns.
 */

/** Zcash networks supported by BLINK. */
export type ZcashNetwork = 'testnet' | 'mainnet';

/**
 * Address families BLINK understands. Sprout is deliberately absent: ZIP 321
 * disallows it and BLINK rejects it at parse time.
 */
export type AddressKind = 'transparent' | 'sapling' | 'unified';

/** Currencies a BLINK payment request can be denominated in. */
export type Currency = 'ZEC';

/**
 * Lifecycle of a payment request. These states are intentionally granular: we
 * never collapse everything into a single "SUCCESS" bucket, because a request
 * that has been broadcast is not the same as one that is confirmed.
 */
export const PAYMENT_STATUSES = [
  'CREATED',
  'WAITING_FOR_PAYMENT',
  'PAYMENT_INITIATED',
  'TRANSACTION_CREATED',
  'BROADCAST',
  'CONFIRMING',
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'UNKNOWN',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Terminal states never transition again.
 */
export const TERMINAL_STATUSES: readonly PaymentStatus[] = [
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
];

export function isTerminalStatus(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Allowed forward transitions of the payment-request state machine. The API
 * layer enforces this so that neither a client nor a bug can move a request
 * backwards (e.g. from CONFIRMED back to WAITING_FOR_PAYMENT).
 *
 * Forward jumps are permitted. A payer's wallet can broadcast before BLINK ever
 * sees an explicit "initiate", and the verification layer can observe several
 * confirmations in a single poll, so a request may legitimately skip
 * intermediate states. What is never permitted is moving backwards or leaving a
 * terminal state.
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: [
    'WAITING_FOR_PAYMENT',
    'PAYMENT_INITIATED',
    'TRANSACTION_CREATED',
    'BROADCAST',
    'CONFIRMING',
    'CONFIRMED',
    'EXPIRED',
    'CANCELLED',
    'FAILED',
    'UNKNOWN',
  ],
  WAITING_FOR_PAYMENT: [
    'PAYMENT_INITIATED',
    'TRANSACTION_CREATED',
    'BROADCAST',
    'CONFIRMING',
    'CONFIRMED',
    'EXPIRED',
    'CANCELLED',
    'FAILED',
    'UNKNOWN',
  ],
  PAYMENT_INITIATED: [
    'TRANSACTION_CREATED',
    'BROADCAST',
    'CONFIRMING',
    'CONFIRMED',
    'EXPIRED',
    'FAILED',
    'UNKNOWN',
  ],
  TRANSACTION_CREATED: ['BROADCAST', 'CONFIRMING', 'CONFIRMED', 'FAILED', 'UNKNOWN'],
  BROADCAST: ['CONFIRMING', 'CONFIRMED', 'FAILED', 'UNKNOWN'],
  CONFIRMING: ['CONFIRMED', 'FAILED', 'UNKNOWN'],
  CONFIRMED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
  UNKNOWN: ['CONFIRMING', 'BROADCAST', 'CONFIRMED', 'FAILED'],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: PaymentStatus,
    public readonly to: PaymentStatus,
  ) {
    super(`Illegal payment status transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/**
 * Events recorded against a payment request. The event log is append-only and
 * is the source of truth for how a request reached its current status.
 */
export const PAYMENT_EVENT_TYPES = [
  'CREATED',
  'VIEWED',
  'PAYMENT_INITIATED',
  'TRANSACTION_DETECTED',
  'BROADCAST',
  'CONFIRMATION',
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'STATUS_POLLED',
] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export interface PaymentEvent {
  id: string;
  paymentRequestId: string;
  type: PaymentEventType;
  /** Machine-readable payload. Never contains secrets or key material. */
  data: Record<string, unknown>;
  createdAt: string;
}

/**
 * A blockchain-observed fact about a transaction. This is stored separately
 * from user-editable metadata so it can never be forged by a client.
 */
export interface BlockchainObservation {
  txid: string;
  /** Number of confirmations observed on-chain. */
  confirmations: number;
  /** Whether the transaction was observed in the mempool / node view. */
  broadcast: boolean;
  /** Block height containing the transaction, when known. */
  blockHeight: number | null;
  /** Where the observation came from, e.g. "lightwalletd" or "node-rpc". */
  source: string;
  observedAt: string;
}

export interface PaymentRequest {
  id: string;
  shortCode: string;
  /** Human-friendly display name for the recipient, e.g. "Joseph". */
  recipientName: string;
  /**
   * The Zcash address. This is the only sensitive field and is encrypted at
   * rest by the API. It is never placed in a shareable link.
   */
  recipientAddress: string;
  amount: string;
  currency: Currency;
  memo: string | null;
  label: string | null;
  message: string | null;
  network: ZcashNetwork;
  status: PaymentStatus;
  /** Set only by the verification layer, never by a client. */
  txid: string | null;
  confirmations: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Public projection of a payment request safe to hand to a payer. */
export interface PublicPaymentRequest {
  shortCode: string;
  recipientName: string;
  amount: string;
  currency: Currency;
  memo: string | null;
  network: ZcashNetwork;
  status: PaymentStatus;
  confirmations: number;
  txidShort: string | null;
  expiresAt: string;
  createdAt: string;
}

export const DEFAULT_EXPIRY_MINUTES = 30;
export const ALLOWED_EXPIRY_MINUTES = [10, 30, 60, 1440] as const;
export type ExpiryMinutes = (typeof ALLOWED_EXPIRY_MINUTES)[number];

/** Maximum memo size permitted by the Zcash shielded memo field. */
export const MAX_MEMO_BYTES = 512;

export * from './money.js';
