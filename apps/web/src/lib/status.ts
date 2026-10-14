import type { PaymentStatus, PaymentPurpose } from '@blink/shared';
import { PAYMENT_PURPOSE_LABELS } from '@blink/shared';

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

/**
 * The kind of evidence behind a status, so a merchant can tell apart three
 * things that are easy to confuse: a request nobody has touched, a transaction
 * id the payer *claimed* (unverified), and a transaction a provider actually
 * *observed* on-chain.
 *
 *  - `none`     — a local request state; no payment evidence at all.
 *  - `claimed`  — the payer reported a txid; BLINK has not observed it. Not proof.
 *  - `observed` — a verification provider saw the transaction (CONFIRMING or
 *                 CONFIRMED). This is the only observed evidence.
 *  - `final`    — a terminal non-success (failed / expired / cancelled).
 */
export type StatusEvidence = 'none' | 'claimed' | 'observed' | 'final';

const EVIDENCE: Record<PaymentStatus, StatusEvidence> = {
  CREATED: 'none',
  WAITING_FOR_PAYMENT: 'none',
  PAYMENT_INITIATED: 'none',
  TRANSACTION_CREATED: 'claimed',
  BROADCAST: 'claimed',
  CONFIRMING: 'observed',
  CONFIRMED: 'observed',
  FAILED: 'final',
  EXPIRED: 'final',
  CANCELLED: 'final',
  UNKNOWN: 'none',
};

export function statusEvidence(status: string): StatusEvidence {
  return EVIDENCE[status as PaymentStatus] ?? 'none';
}

/**
 * One honest sentence for the current status, so a merchant never has to guess
 * whether "transaction reported" means the money arrived. It never claims a
 * confirmation BLINK has not observed.
 */
export function statusDetail(status: string): string {
  switch (status) {
    case 'CREATED':
    case 'WAITING_FOR_PAYMENT':
      return 'No payment has been observed for this request yet.';
    case 'PAYMENT_INITIATED':
      return 'The payer started the payment. Nothing has been observed on-chain yet.';
    case 'TRANSACTION_CREATED':
    case 'BROADCAST':
      return 'A transaction id was reported, but BLINK has not observed it on the Zcash network. A reported id is not proof of payment.';
    case 'CONFIRMING':
      return 'BLINK observed the transaction on the Zcash network and is waiting for it to reach the required confirmation depth.';
    case 'CONFIRMED':
      return 'BLINK observed the transaction on the Zcash network at the required confirmation depth.';
    case 'FAILED':
      return 'This request failed. It will not settle.';
    case 'EXPIRED':
      return 'This request expired before a payment was observed.';
    case 'CANCELLED':
      return 'This request was cancelled by its owner.';
    default:
      return 'The status of this request is not yet known.';
  }
}

/** Whether a request can still be paid: not terminal and not past its expiry. */
export function isPayableStatus(status: string): boolean {
  return !['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(status);
}

/** Human-facing label for a payment purpose, e.g. `payroll` -> "Private payroll". */
export function purposeLabel(purpose: string): string {
  return PAYMENT_PURPOSE_LABELS[purpose as PaymentPurpose] ?? 'Private invoice';
}
