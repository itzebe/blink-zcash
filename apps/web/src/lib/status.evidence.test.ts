import { describe, expect, it } from 'vitest';

import {
  isPayableStatus,
  statusDetail,
  statusEvidence,
  statusIsVerified,
  statusLabel,
  statusTone,
} from './status.js';

describe('statusEvidence', () => {
  it('treats a payer-reported transaction id as claimed, not observed', () => {
    expect(statusEvidence('TRANSACTION_CREATED')).toBe('claimed');
    expect(statusEvidence('BROADCAST')).toBe('claimed');
  });

  it('only CONFIRMING and CONFIRMED are observed evidence', () => {
    expect(statusEvidence('CONFIRMING')).toBe('observed');
    expect(statusEvidence('CONFIRMED')).toBe('observed');
  });

  it('reports no evidence for an untouched request', () => {
    expect(statusEvidence('CREATED')).toBe('none');
    expect(statusEvidence('WAITING_FOR_PAYMENT')).toBe('none');
    expect(statusEvidence('PAYMENT_INITIATED')).toBe('none');
  });

  it('marks terminal failures as final', () => {
    expect(statusEvidence('FAILED')).toBe('final');
    expect(statusEvidence('EXPIRED')).toBe('final');
    expect(statusEvidence('CANCELLED')).toBe('final');
  });

  it('fails safe to "none" for an unknown status', () => {
    expect(statusEvidence('SOMETHING_ELSE')).toBe('none');
  });
});

describe('statusDetail', () => {
  it('never describes a claimed id as confirmed', () => {
    const detail = statusDetail('TRANSACTION_CREATED');
    expect(detail).toMatch(/not observed/i);
    expect(detail).toMatch(/not proof/i);
  });

  it('explains observed vs awaiting depth', () => {
    expect(statusDetail('CONFIRMING')).toMatch(/required confirmation depth/i);
    expect(statusDetail('CONFIRMED')).toMatch(/required confirmation depth/i);
  });
});

describe('isPayableStatus', () => {
  it('is true for non-terminal states', () => {
    expect(isPayableStatus('WAITING_FOR_PAYMENT')).toBe(true);
    expect(isPayableStatus('CONFIRMING')).toBe(true);
  });

  it('is false for every terminal state', () => {
    for (const s of ['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED']) {
      expect(isPayableStatus(s)).toBe(false);
    }
  });
});

describe('existing helpers still hold', () => {
  it('labels and tones are unchanged for CONFIRMED', () => {
    expect(statusLabel('CONFIRMED')).toBe('Confirmed');
    expect(statusTone('CONFIRMED')).toBe('ok');
    expect(statusIsVerified('CONFIRMED')).toBe(true);
    expect(statusIsVerified('BROADCAST')).toBe(false);
  });
});
