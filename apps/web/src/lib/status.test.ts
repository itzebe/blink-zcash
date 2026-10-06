import { describe, expect, it } from 'vitest';

import { purposeLabel, statusIsVerified, statusLabel, statusTone } from './status.js';

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
  it('only treats CONFIRMED and CONFIRMING as provider-verified', () => {
    expect(statusIsVerified('CONFIRMED')).toBe(true);
    expect(statusIsVerified('CONFIRMING')).toBe(true);
    expect(statusIsVerified('BROADCAST')).toBe(false);
    expect(statusIsVerified('WAITING_FOR_PAYMENT')).toBe(false);
  });

  it('maps a known status to a label and tone', () => {
    expect(statusLabel('CONFIRMED')).toBe('Confirmed');
    expect(statusTone('CONFIRMED')).toBe('ok');
  });

  it('degrades gracefully for an unknown status', () => {
    expect(statusLabel('WEIRD')).toBe('WEIRD');
    expect(statusTone('WEIRD')).toBe('neutral');
  });
});
