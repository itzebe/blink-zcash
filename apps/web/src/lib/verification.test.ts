import { describe, expect, it } from 'vitest';
import type { ShieldedVerificationRecord } from '@blink/shared';
import { summarizeVerification, verificationDisclosure } from './verification.js';

function rec(
  state: ShieldedVerificationRecord['state'],
  overrides: Partial<ShieldedVerificationRecord> = {},
): ShieldedVerificationRecord {
  return {
    state,
    txid: 'a'.repeat(64),
    pools: null,
    transparentRecipientZatoshis: null,
    recipientVerified: false,
    amountVerified: false,
    keyVerified: false,
    source: 'test',
    observedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('summarizeVerification — every backend state', () => {
  it('reports an unobserved request as neutral, without claiming verification', () => {
    const s = summarizeVerification(null);
    expect(s.level).toBe('unobserved');
    expect(s.state).toBe('unobserved');
    expect(s.tone).toBe('neutral');
    expect(s.verified).toBe(false);
    expect(s.detail).toMatch(/has not observed/i);
  });

  it('maps a shielded settlement to the shielded level (not a proof of recipient)', () => {
    const s = summarizeVerification(rec('shielded_activity_observed'));
    expect(s.level).toBe('shielded');
    expect(s.tone).toBe('progress');
    // A shielded-activity observation is never a verified recipient or amount.
    expect(s.verified).toBe(false);
    expect(s.facts.recipient).toBe('unverified');
    expect(s.facts.amount).toBe('unverified');
    expect(s.detail).toMatch(/unverified/i);
    expect(s.detail).toMatch(/recipient and amount/i);
  });

  it('names the shielded recipient only when a viewing key verified it', () => {
    const verified = rec('shielded_recipient_verified', {
      keyVerified: true,
      recipientVerified: true,
      amountVerified: true,
    });
    const s = summarizeVerification(verified);
    expect(s.level).toBe('shielded_recipient_verified');
    expect(s.tone).toBe('ok');
    expect(s.verified).toBe(true);
    expect(s.facts.recipient).toBe('verified');
    expect(s.facts.amount).toBe('verified');
    expect(s.detail).toMatch(/viewing key/i);
    // Even a verified shielded recipient must not imply the sender is known.
    expect(s.detail).toMatch(/sender remains private/i);
  });

  it('does not claim the amount when a verified shielded amount did not match', () => {
    const verified = rec('shielded_recipient_verified', {
      keyVerified: true,
      recipientVerified: true,
      amountVerified: false,
    });
    const s = summarizeVerification(verified);
    expect(s.label).toBe('Shielded recipient verified');
    expect(s.facts.recipient).toBe('verified');
    expect(s.facts.amount).toBe('unverified');
    expect(s.verified).toBe(false);
    expect(s.detail).toMatch(/amount is unverified/i);
  });

  it('flags a transparent settlement as a contradiction, never "confirmed"', () => {
    const s = summarizeVerification(rec('transparent_settlement'));
    expect(s.level).toBe('contradicted');
    expect(s.tone).toBe('bad');
    expect(s.verified).toBe(false);
    expect(s.detail).toMatch(/not confirmed as one|not a shielded payment/i);
  });

  it('flags a transparent-recipient payment as a contradiction', () => {
    const s = summarizeVerification(rec('contradictory'));
    expect(s.level).toBe('contradicted');
    expect(s.tone).toBe('bad');
    expect(s.verified).toBe(false);
  });

  it('treats a plain observed transaction as composition-unknown', () => {
    const s = summarizeVerification(rec('observed'));
    expect(s.level).toBe('observed');
    expect(s.verified).toBe(false);
    expect(s.detail).toMatch(/could not decode/i);
  });

  it('names the independently verified recipient only for a transparent-capable route', () => {
    const s = summarizeVerification(rec('recipient_verified'));
    expect(s.level).toBe('recipient_verified');
    expect(s.verified).toBe(true);
    expect(s.detail).toMatch(/public on-chain/i);
  });
});

describe('summarizeVerification — confirmed is not verified', () => {
  it('adds a reconciliation caveat when a transaction is confirmed but the recipient/amount are not verified', () => {
    const s = summarizeVerification(rec('shielded_activity_observed'), { status: 'CONFIRMED' });
    expect(s.verified).toBe(false);
    expect(s.caveat).toBeTruthy();
    expect(s.caveat).toMatch(/confirmation only establishes the transaction/i);
    expect(s.caveat).toMatch(/does not verify the recipient or amount/i);
  });

  it('does not add the caveat once the recipient and amount are verified', () => {
    const verified = rec('shielded_recipient_verified', {
      keyVerified: true,
      recipientVerified: true,
      amountVerified: true,
    });
    const s = summarizeVerification(verified, { status: 'CONFIRMED' });
    expect(s.verified).toBe(true);
    expect(s.caveat).toBeNull();
  });

  it('does not add the caveat while the payment is not yet confirmed', () => {
    const s = summarizeVerification(rec('shielded_activity_observed'), { status: 'CONFIRMING' });
    expect(s.caveat).toBeNull();
  });

  it('never promotes a shielded-activity observation to recipient verification', () => {
    const s = summarizeVerification(rec('shielded_activity_observed'), { status: 'CONFIRMED' });
    expect(s.level).toBe('shielded');
    expect(s.verified).toBe(false);
    expect(s.facts.recipient).toBe('unverified');
  });
});

describe('summarizeVerification — unavailable evidence', () => {
  it('states that recipient/amount verification is unavailable when no viewing key is configured', () => {
    const s = summarizeVerification(rec('shielded_activity_observed'), { keyConfigured: false });
    expect(s.unavailable).toBe(true);
    expect(s.detail).toMatch(/no recipient viewing key is configured/i);
  });

  it('does not claim unavailability when the key presence is unknown', () => {
    const s = summarizeVerification(rec('shielded_activity_observed'));
    expect(s.unavailable).toBe(false);
    expect(s.detail).not.toMatch(/no recipient viewing key/i);
  });

  it('does not claim unavailability when the key presence is null', () => {
    const s = summarizeVerification(rec('shielded_activity_observed'), { keyConfigured: null });
    expect(s.unavailable).toBe(false);
  });

  it('does not mark a verified settlement unavailable even without a configured key flag', () => {
    const verified = rec('shielded_recipient_verified', {
      keyVerified: true,
      recipientVerified: true,
      amountVerified: true,
    });
    const s = summarizeVerification(verified, { keyConfigured: false });
    expect(s.unavailable).toBe(false);
    expect(s.verified).toBe(true);
  });
});

describe('summarizeVerification — malformed / unknown records', () => {
  it('treats a record with an unrecognised state as composition-unknown, never verified', () => {
    const bogus = {
      ...rec('observed'),
      state: 'something_new',
    } as unknown as ShieldedVerificationRecord;
    const s = summarizeVerification(bogus);
    expect(s.verified).toBe(false);
    expect(s.facts.recipient).toBe('unverified');
    expect(s.facts.amount).toBe('unverified');
  });
});

describe('verificationDisclosure', () => {
  it('states that a shielded transfer cannot be cryptographically attributed', () => {
    const text = verificationDisclosure(rec('shielded_activity_observed'));
    expect(text).toMatch(/cannot cryptographically prove the sender/i);
  });

  it('does not add the shielded caveat to a public settlement', () => {
    const text = verificationDisclosure(rec('transparent_settlement'));
    expect(text).not.toMatch(/cannot cryptographically prove the sender/i);
  });
});
