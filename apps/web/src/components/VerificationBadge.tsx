import type { ShieldedVerificationRecord } from '@blink/shared';
import { summarizeVerification, verificationDisclosure } from '@/lib/verification';

/**
 * The verification level BLINK actually established, shown next to a payment
 * status so a payer or merchant can tell a shielded settlement apart from a
 * public (transparent) one — and from a mere observation whose composition could
 * not be decoded. It renders only the backend's own record and never upgrades a
 * claim.
 */
export function VerificationBadge({
  record,
  showDetail = true,
}: {
  record: ShieldedVerificationRecord | null | undefined;
  showDetail?: boolean;
}) {
  const s = summarizeVerification(record);
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
    </div>
  );
}
