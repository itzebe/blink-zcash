import type { PaymentStatus } from '@blink/shared';

export type StatusTone = 'neutral' | 'waiting' | 'progress' | 'ok' | 'bad';

const TONE: Record<PaymentStatus, StatusTone> = {
  CREATED: 'waiting',
  WAITING_FOR_PAYMENT: 'waiting',
  PAYMENT_INITIATED: 'progress',
  TRANSACTION_CREATED: 'progress',
  BROADCAST: 'progress',
  CONFIRMING: 'progress',
  CONFIRMED: 'ok',
  FAILED: 'bad',
  EXPIRED: 'bad',
  CANCELLED: 'bad',
  UNKNOWN: 'neutral',
};

const LABEL: Record<PaymentStatus, string> = {
  CREATED: 'Creating',
  WAITING_FOR_PAYMENT: 'Waiting for payment',
  PAYMENT_INITIATED: 'Payment initiated',
  TRANSACTION_CREATED: 'Transaction reported',
  BROADCAST: 'Broadcast',
  CONFIRMING: 'Confirming',
  CONFIRMED: 'Confirmed',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  UNKNOWN: 'Unknown',
};

export function statusTone(status: string): StatusTone {
  return TONE[status as PaymentStatus] ?? 'neutral';
}

export function statusLabel(status: string): string {
  return LABEL[status as PaymentStatus] ?? status;
}

/**
 * Whether the status shown is a claim or an observed fact. Only CONFIRMED and
 * CONFIRMING are backed by a provider observation. Everything else is a local
 * BLINK request state.
 */
export function statusIsVerified(status: string): boolean {
  return status === 'CONFIRMED' || status === 'CONFIRMING';
}
