import type { ShieldedVerificationRecord } from '@blink/shared';

/**
 * Present the backend's shielded-verification level in plain language.
 *
 * The API computes an honest `ShieldedVerificationRecord` for every observation
 * (see `packages/shared/src/privacy.ts`). Until now the receipt and the payer and
 * merchant screens only showed the coarse payment status ("Confirmed"), which
 * hides the important distinction between a shielded settlement BLINK observed
 * and a public (transparent) settlement that contradicts the request. This maps
 * the record to a short label, a sentence, and a tone, using exactly the states
 * the backend defines — never a stronger claim.
 */
export type VerificationLevel =
  | 'unobserved'
  | 'observed'
  | 'shielded'
  | 'shielded_recipient_verified'
  | 'recipient_verified'
  | 'contradicted';

export type VerificationTone = 'neutral' | 'progress' | 'ok' | 'bad';

export interface VerificationSummary {
  level: VerificationLevel;
  label: string;
  detail: string;
  tone: VerificationTone;
}

function summary(
  level: VerificationLevel,
  label: string,
  detail: string,
  tone: VerificationTone,
): VerificationSummary {
  return { level, label, detail, tone };
}

export function summarizeVerification(
  record: ShieldedVerificationRecord | null | undefined,
): VerificationSummary {
  if (!record) {
    return summary(
      'unobserved',
      'Not verified yet',
      'BLINK has not observed an on-chain transaction for this request.',
      'neutral',
    );
  }
  switch (record.state) {
    case 'shielded_recipient_verified':
      return summary(
        'shielded_recipient_verified',
        record.amountVerified
          ? 'Shielded recipient and amount verified'
          : 'Shielded recipient verified',
        record.amountVerified
          ? 'BLINK trial-decrypted the transaction with the recipient\u2019s viewing key and recovered a shielded note to the exact requested address for the exact requested amount. The sender remains private.'
          : 'BLINK trial-decrypted the transaction with the recipient\u2019s viewing key and recovered a shielded note to the exact requested address. The recovered amount did not match the requested amount exactly, so the amount is unverified. The sender remains private.',
        'ok',
      );
    case 'shielded_activity_observed':
      return summary(
        'shielded',
        'Shielded activity observed',
        'BLINK observed a confirmed transaction that carries shielded-pool activity and does not pay the recipient transparently. The recipient and amount are private to the parties and remain unverified.',
        'ok',
      );
    case 'recipient_verified':
      return summary(
        'recipient_verified',
        'Recipient verified (public route)',
        'BLINK observed a confirmed transaction that provably pays the requested recipient. On this transparent-capable route the recipient and amount are public on-chain.',
        'ok',
      );
    case 'transparent_settlement':
      return summary(
        'contradicted',
        'Public settlement detected',
        'BLINK observed a confirmed transaction that touches no shielded pool, so it is not a shielded payment. It was not confirmed as one.',
        'bad',
      );
    case 'contradictory':
      return summary(
        'contradicted',
        'Contradiction detected',
        'BLINK observed a confirmed transaction paying the recipient\u2019s transparent receiver, which contradicts the shielded-only request. It was not confirmed as a shielded payment.',
        'bad',
      );
    case 'observed':
    default:
      return summary(
        'observed',
        'Observed, composition unknown',
        'BLINK observed a confirmed transaction but could not decode which pools it touches, so it makes no shielded claim about this settlement.',
        'progress',
      );
  }
}

/**
 * One short line for the receipt, stating the level and what remains unprovable.
 * Never claims the recipient or amount of a shielded transfer.
 */
export function verificationDisclosure(record: ShieldedVerificationRecord | null | undefined): string {
  const s = summarizeVerification(record);
  if (
    s.level === 'shielded' ||
    s.level === 'shielded_recipient_verified' ||
    s.level === 'recipient_verified'
  ) {
    return `${s.label}. ${s.detail} BLINK cannot cryptographically prove the sender of a shielded transfer; those details are private to the parties.`;
  }
  return `${s.label}. ${s.detail}`;
}
