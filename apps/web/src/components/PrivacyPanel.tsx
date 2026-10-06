import type { PrivacyCapability } from '@blink/shared';

/**
 * Protocol-accurate privacy disclosure.
 *
 * Shows what Zcash actually protects for this route, derived from the recipient
 * address kind. It never says "anonymous" and never implies a transparent sender
 * is hidden. The sender row is labelled "Depends on payer" when the request
 * cannot determine the payer's pool.
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
  ] as const;

  return (
    <div className={`privacy privacy--${privacy.level}`}>
      <div className="privacy__head">
        <span className="privacy__kicker">Privacy</span>
        <span className="privacy__route">{privacy.routeLabel}</span>
      </div>
      <div className="privacy__facts">
        {facts.map((f) => (
          <span key={f.label} className={`privacy__fact privacy__fact--${f.fact}`}>
            <span className="privacy__fact-label">{f.label}</span>
            <span className="privacy__fact-value">
              {f.fact === 'protected'
                ? 'Protected'
                : f.fact === 'public'
                  ? 'Public'
                  : 'Depends on payer'}
            </span>
          </span>
        ))}
      </div>
      {!compact ? (
        <p className="privacy__note">
          {privacy.recipient === 'public'
            ? privacy.recipientStatement
            : `${privacy.recipientStatement} ${privacy.senderStatement}`}
        </p>
      ) : null}
    </div>
  );
}
