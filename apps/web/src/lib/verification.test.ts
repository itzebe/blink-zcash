import { describe, expect, it } from 'vitest';
import type { ShieldedVerificationRecord } from '@blink/shared';
import { summarizeVerification, verificationDisclosure } from './verification.js';

function rec(state: ShieldedVerificationRecord['state']): ShieldedVerificationRecord {
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
  };
}

describe('summarizeVerification', () => {
  it('reports an unobserved request as neutral, without claiming verification', () => {
    const s = summarizeVerification(null);
    expect(s.level).toBe('unobserved');
    expect(s.tone).toBe('neutral');
    expect(s.detail).toMatch(/has not observed/i);
  });

  it('maps a shielded settlement to the shielded level (not a proof of recipient)', () => {
    const s = summarizeVerification(rec('shielded_activity_observed'));
    expect(s.level).toBe('shielded');
    expect(s.tone).toBe('ok');
    // Must not claim the recipient or amount were proven.
    expect(s.detail).toMatch(/unverified/i);
    expect(s.detail).toMatch(/recipient and amount/i);
  });

  it('names the shielded recipient only when a viewing key verified it', () => {
    const verified = { ...rec('shielded_recipient_verified'), keyVerified: true, recipientVerified: true, amountVerified: true };
    const s = summarizeVerification(verified);
    expect(s.level).toBe('shielded_recipient_verified');
    expect(s.tone).toBe('ok');
    expect(s.detail).toMatch(/viewing key/i);
    // Even a verified shielded recipient must not imply the sender is known.
    expect(s.detail).toMatch(/sender remains private/i);
  });

  it('does not claim the amount when a verified shielded amount did not match', () => {
    const verified = { ...rec('shielded_recipient_verified'), keyVerified: true, recipientVerified: true, amountVerified: false };
    const s = summarizeVerification(verified);
    expect(s.label).toBe('Shielded recipient verified');
    expect(s.detail).toMatch(/amount is unverified/i);
  });

  it('flags a transparent settlement as a contradiction, never "confirmed"', () => {
    const s = summarizeVerification(rec('transparent_settlement'));
    expect(s.level).toBe('contradicted');
    expect(s.tone).toBe('bad');
    expect(s.detail).toMatch(/not confirmed as one|not a shielded payment/i);
  });

  it('flags a transparent-recipient payment as a contradiction', () => {
    const s = summarizeVerification(rec('contradictory'));
    expect(s.level).toBe('contradicted');
    expect(s.tone).toBe('bad');
  });

  it('treats a plain observed transaction as composition-unknown', () => {
    const s = summarizeVerification(rec('observed'));
    expect(s.level).toBe('observed');
    expect(s.detail).toMatch(/could not decode/i);
  });

  it('names the independently verified recipient only for a transparent-capable route', () => {
    const s = summarizeVerification(rec('recipient_verified'));
    expect(s.level).toBe('recipient_verified');
    expect(s.detail).toMatch(/public on-chain/i);
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
