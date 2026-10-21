import { describe, expect, it } from 'vitest';

import {
  purposeLabel,
  statusIsSettled,
  statusIsVerified,
  statusLabel,
  statusTone,
} from './status.js';

describe('purposeLabel', () => {
  it('labels each known purpose', () => {
    expect(purposeLabel('invoice')).toBe('Private invoice');
    expect(purposeLabel('payroll')).toBe('Private payroll');
    expect(purposeLabel('remittance')).toBe('Private remittance');
    expect(purposeLabel('subscription')).toBe('Private subscription');
    expect(purposeLabel('point_of_sale')).toBe('Point of sale');
  });

  it('falls back to a private invoice for an unknown purpose', () => {
    expect(purposeLabel('charity')).toBe('Private invoice');
  });
});

describe('status helpers', () => {
  it('treats CONFIRMED, CONFIRMING and OBSERVED as provider-observed', () => {
    expect(statusIsVerified('CONFIRMED')).toBe(true);
    expect(statusIsVerified('CONFIRMING')).toBe(true);
    expect(statusIsVerified('OBSERVED')).toBe(true);
    expect(statusIsVerified('BROADCAST')).toBe(false);
    expect(statusIsVerified('WAITING_FOR_PAYMENT')).toBe(false);
  });

  it('maps a known status to a label and tone', () => {
    expect(statusLabel('CONFIRMED')).toBe('Confirmed');
    expect(statusTone('CONFIRMED')).toBe('ok');
  });

  it('labels OBSERVED as observed but not a settled payment', () => {
    // Observed means a transaction was seen, so it is not "waiting"; but it is
    // not a settlement either. The two questions must stay separate.
    expect(statusIsVerified('OBSERVED')).toBe(true);
    expect(statusIsSettled('OBSERVED')).toBe(false);
    expect(statusIsSettled('CONFIRMED')).toBe(true);
    expect(statusLabel('OBSERVED')).toMatch(/not verified/i);
    expect(statusTone('OBSERVED')).not.toBe('ok');
  });

  it('degrades gracefully for an unknown status', () => {
    expect(statusLabel('WEIRD')).toBe('WEIRD');
    expect(statusTone('WEIRD')).toBe('neutral');
  });
});
