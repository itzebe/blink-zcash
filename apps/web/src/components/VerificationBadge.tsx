import type { ShieldedVerificationRecord } from '@blink/shared';
import {
  summarizeVerification,
  verificationDisclosure,
  type VerificationFact,
  type VerificationOptions,
} from '@/lib/verification';

const FACT_LABEL: Record<VerificationFact, string> = {
  verified: 'Verified',
  unverified: 'Not verified',
  not_applicable: 'Not applicable',
};

function FactRow({ name, fact }: { name: string; fact: VerificationFact }) {
  return (
    <div className="verification__fact" data-fact={fact}>
      <span className="verification__fact-name">{name}</span>
      <span className={`verification__fact-status verification__fact-status--${fact}`}>
        {FACT_LABEL[fact]}
      </span>
    </div>
  );
}

/**
 * The verification level BLINK actually established, shown next to a payment
 * status so a payer or merchant can tell a shielded settlement apart from a
 * public (transparent) one — and from a mere observation whose composition could
 * not be decoded. It renders only the backend's own record and never upgrades a
 * claim: the recipient and the amount are shown as separate facts, a confirmed
 * but unverified settlement carries an explicit caveat, and missing configuration
 * is named rather than implied.
 */
export function VerificationBadge({
  record,
  showDetail = true,
  options,
}: {
  record: ShieldedVerificationRecord | null | undefined;
  showDetail?: boolean;
  options?: VerificationOptions;
}) {
  const s = summarizeVerification(record, options);
  const shielded =
    s.level === 'shielded' ||
    s.level === 'shielded_recipient_verified' ||
    s.level === 'recipient_verified';
  return (
    <div className={`verification verification--${s.tone}`} data-level={s.level}>
      <div className="verification__head">
        <span className="verification__kicker">Verification</span>
        <span className={`verification__label verification__label--${s.tone}`}>{s.label}</span>
      </div>
      {showDetail ? (
        <p className="verification__detail">
          {shielded ? verificationDisclosure(record) : s.detail}
        </p>
      ) : null}
      {showDetail ? (
        <div className="verification__facts">
          <FactRow name="Recipient" fact={s.facts.recipient} />
          <FactRow name="Amount" fact={s.facts.amount} />
        </div>
      ) : null}
      {showDetail && s.unavailable ? (
        <p className="verification__flag verification__flag--unavailable">
          Recipient and amount verification is unavailable for this request.
        </p>
      ) : null}
      {showDetail && s.caveat ? (
        <p className="verification__flag verification__flag--caveat">{s.caveat}</p>
      ) : null}
    </div>
  );
}
