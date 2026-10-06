import {
  BLINK_APP_PRIVACY_NOTE,
  privacyHeadline,
  privacyHeadlineSentence,
  type PrivacyCapability,
} from '@blink/shared';

/**
 * Protocol-accurate privacy disclosure, in two layers.
 *
 * 1. A plain-language status for someone who has never used Zcash ("Shielded
 *    payment" / "Public payment") and a one-sentence explanation of what a
 *    stranger can see on the blockchain.
 * 2. The per-fact breakdown, derived from the recipient address kind. It never
 *    says "anonymous" and never implies a transparent sender is hidden; the
 *    sender row is "Depends on payer" when the request cannot know the payer's
 *    pool.
 *
 * A separate note distinguishes what the Zcash protocol protects from what BLINK
 * itself stores, so the whole request is never labelled private when a memo is
 * plaintext.
 */
export function PrivacyPanel({
  privacy,
  compact = false,
}: {
  privacy: PrivacyCapability;
  compact?: boolean;
}) {
  const facts = [
    { label: 'Recipient', fact: privacy.recipient },
    { label: 'Amount', fact: privacy.amount },
    { label: 'Sender', fact: privacy.sender },
    { label: 'Memo', fact: privacy.memo },
  ] as const;

  return (
    <div className={`privacy privacy--${privacy.level}`}>
      <div className="privacy__head">
        <span className="privacy__kicker">Privacy</span>
        <span className="privacy__route">{privacy.routeLabel}</span>
      </div>
      <p className="privacy__headline">
        <span className="privacy__headline-mark" aria-hidden="true">
          {privacy.level === 'shielded' ? '🛡' : '👁'}
        </span>
        {privacyHeadline(privacy)}
      </p>
      <div className="privacy__facts">
        {facts.map((f) => (
          <span key={f.label} className={`privacy__fact privacy__fact--${f.fact}`}>
            <span className="privacy__fact-label">{f.label}</span>
            <span className="privacy__fact-value">
              {f.fact === 'protected'
                ? 'Protected'
                : f.fact === 'public'
                  ? f.label === 'Memo'
                    ? 'Plaintext'
                    : 'Public'
                  : 'Depends on payer'}
            </span>
          </span>
        ))}
      </div>
      {!compact ? (
        <>
          <p className="privacy__note">{privacyHeadlineSentence(privacy)}</p>
          {/* What the protocol protects vs. what BLINK the application handles. */}
          <p className="privacy__app-note">{BLINK_APP_PRIVACY_NOTE}</p>
        </>
      ) : null}
    </div>
  );
}
