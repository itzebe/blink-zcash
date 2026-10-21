import type { ShieldedVerificationRecord, ShieldedVerificationState } from '@blink/shared';

/**
 * Present the backend's shielded-verification level in plain language.
 *
 * The API computes an honest `ShieldedVerificationRecord` for every observation
 * (see `packages/shared/src/privacy.ts`). The receipt and the payer and merchant
 * screens must not let a reader collapse three different facts into one:
 *
 *   - a transaction is *confirmed* (its depth on-chain is established),
 *   - shielded *activity* was observed (a shielded pool was touched, but the
 *     intended recipient and amount are not necessarily identified), and
 *   - the intended recipient and amount were *verified* by evidence.
 *
 * This module maps the record to a short label, a sentence, a tone, and two
 * explicit per-fact statuses (recipient, amount), using exactly the states the
 * backend defines — never a stronger claim. It also states when the strongest
 * claim is *unavailable* because the required configuration is missing.
 */
export type VerificationLevel =
  | 'unobserved'
  | 'observed'
  | 'shielded'
  | 'shielded_recipient_verified'
  | 'recipient_verified'
  | 'contradicted';

export type VerificationTone = 'neutral' | 'progress' | 'ok' | 'bad';

/** The status of a single fact (recipient or amount) established by the evidence. */
export type VerificationFact = 'verified' | 'unverified' | 'not_applicable';

export interface VerificationSummary {
  level: VerificationLevel;
  label: string;
  detail: string;
  tone: VerificationTone;
  /**
   * Whether the evidence establishes the intended recipient AND the requested
   * amount. `false` for a mere shielded-activity observation, even when the
   * payment itself is confirmed.
   */
  verified: boolean;
  /** Recipient and amount stated separately, so neither implies the other. */
  facts: { recipient: VerificationFact; amount: VerificationFact };
  /** The backend state this summary came from (`unobserved` when there is none). */
  state: ShieldedVerificationState | 'unobserved';
  /**
   * True when the strongest available claim is blocked by missing configuration
   * (no recipient viewing key), so the interface can say "verification
   * unavailable" rather than leaving the reader to guess why a settlement is not
   * attributed to the recipient.
   */
  unavailable: boolean;
  /**
   * A sentence that reconciles a confirmed transaction with an unverified
   * shielded settlement. `null` when there is nothing to reconcile (the payment
   * is not confirmed, or the recipient and amount are verified).
   */
  caveat: string | null;
}

export interface VerificationOptions {
  /**
   * Whether the deployment has a recipient viewing key configured. `false` means
   * explicitly absent, so verification is unavailable. `true` or `null`/absent
   * means "not known to be missing" and no unavailability claim is made — never
   * assume a key exists.
   */
  keyConfigured?: boolean | null;
  /** The payment status, so a confirmed-but-unverified settlement is called out. */
  status?: string | null;
}

function summary(
  level: VerificationLevel,
  state: ShieldedVerificationState | 'unobserved',
  label: string,
  detail: string,
  tone: VerificationTone,
  facts: { recipient: VerificationFact; amount: VerificationFact },
): VerificationSummary {
  return {
    level,
    label,
    detail,
    tone,
    verified: facts.recipient === 'verified' && facts.amount === 'verified',
    facts,
    state,
    unavailable: false,
    caveat: null,
  };
}

/**
 * Keeps "confirmed" from being read as "verified". Added only when a transaction
 * is confirmed but the shielded recipient and amount are not verified, which is
 * exactly the ambiguity this module exists to remove.
 */
const CONFIRMED_BUT_UNVERIFIED_CAVEAT =
  'The transaction is confirmed on-chain, but confirmation only establishes the transaction\u2019s status — it does not verify the recipient or amount of a shielded payment. See the verification level above.';

export function summarizeVerification(
  record: ShieldedVerificationRecord | null | undefined,
  options: VerificationOptions = {},
): VerificationSummary {
  const confirmed = options.status === 'CONFIRMED';
  const noKey = options.keyConfigured === false;
  const withCaveat = (s: VerificationSummary): VerificationSummary =>
    confirmed && !s.verified ? { ...s, caveat: CONFIRMED_BUT_UNVERIFIED_CAVEAT } : s;
  const unavailableNote = (s: VerificationSummary): VerificationSummary =>
    noKey && !s.verified
      ? {
          ...s,
          unavailable: true,
          detail: `${s.detail} Recipient and amount verification is unavailable for this request because no recipient viewing key is configured.`,
        }
      : s;

  if (!record) {
    return withCaveat(
      summary(
        'unobserved',
        'unobserved',
        'Not verified yet',
        'BLINK has not observed an on-chain transaction for this request.',
        'neutral',
        { recipient: 'unverified', amount: 'unverified' },
      ),
    );
  }

  switch (record.state) {
    case 'shielded_recipient_verified':
      return withCaveat(
        summary(
          'shielded_recipient_verified',
          'shielded_recipient_verified',
          record.amountVerified
            ? 'Shielded recipient and amount verified'
            : 'Shielded recipient verified',
          record.amountVerified
            ? 'BLINK trial-decrypted the transaction with the recipient\u2019s viewing key and recovered a shielded note to the exact requested address for the exact requested amount. The sender remains private.'
            : 'BLINK trial-decrypted the transaction with the recipient\u2019s viewing key and recovered a shielded note to the exact requested address. The recovered amount did not match the requested amount exactly, so the amount is unverified. The sender remains private.',
          'ok',
          { recipient: 'verified', amount: record.amountVerified ? 'verified' : 'unverified' },
        ),
      );
    case 'shielded_activity_observed':
      return withCaveat(
        unavailableNote(
          summary(
            'shielded',
            'shielded_activity_observed',
            'Shielded activity observed',
            'BLINK observed a confirmed transaction that carries shielded-pool activity and does not pay the recipient transparently. The recipient and amount are private to the parties and remain unverified.',
            'progress',
            { recipient: 'unverified', amount: 'unverified' },
          ),
        ),
      );
    case 'recipient_verified':
      return withCaveat(
        summary(
          'recipient_verified',
          'recipient_verified',
          'Recipient and amount verified (public route)',
          'BLINK observed a confirmed transaction that provably pays the requested recipient the requested amount. On this transparent-capable route the recipient and amount are public on-chain.',
          'ok',
          { recipient: 'verified', amount: 'verified' },
        ),
      );
    case 'transparent_settlement':
      return withCaveat(
        summary(
          'contradicted',
          'transparent_settlement',
          'Public settlement detected',
          'BLINK observed a confirmed transaction that touches no shielded pool, so it is not a shielded payment. It was not confirmed as one.',
          'bad',
          { recipient: 'unverified', amount: 'unverified' },
        ),
      );
    case 'contradictory':
      return withCaveat(
        summary(
          'contradicted',
          'contradictory',
          'Contradiction detected',
          'BLINK observed a confirmed transaction paying the recipient\u2019s transparent receiver, which contradicts the shielded-only request. It was not confirmed as a shielded payment.',
          'bad',
          { recipient: 'unverified', amount: 'unverified' },
        ),
      );
    case 'observed':
    default:
      return withCaveat(
        unavailableNote(
          summary(
            'observed',
            'observed',
            'Observed, composition unknown',
            'BLINK observed a confirmed transaction but could not decode which pools it touches, so it makes no shielded claim about this settlement.',
            'progress',
            { recipient: 'unverified', amount: 'unverified' },
          ),
        ),
      );
  }
}

/**
 * One short line for the receipt, stating the level and what remains unprovable.
 * Never claims the recipient or amount of a shielded transfer.
 */
export function verificationDisclosure(
  record: ShieldedVerificationRecord | null | undefined,
): string {
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
