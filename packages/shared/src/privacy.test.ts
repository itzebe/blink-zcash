import { describe, expect, it } from 'vitest';
import { privacyCapability, privacyLines, withUnifiedReceivers } from './privacy.js';

describe('privacyCapability', () => {
  it('treats a Unified Address recipient as shielded', () => {
    const p = privacyCapability('unified');
    expect(p.level).toBe('shielded');
    expect(p.recipient).toBe('protected');
    expect(p.amount).toBe('protected');
    // The sender is never claimed to be protected: a transparent payer stays public.
    expect(p.sender).toBe('varies');
    expect(p.supportsMemo).toBe(true);
  });

  it('treats a Sapling recipient as shielded', () => {
    const p = privacyCapability('sapling');
    expect(p.level).toBe('shielded');
    expect(p.recipient).toBe('protected');
    expect(p.amount).toBe('protected');
    expect(p.supportsMemo).toBe(true);
  });

  it('treats a transparent recipient as fully public', () => {
    const p = privacyCapability('transparent');
    expect(p.level).toBe('transparent');
    expect(p.recipient).toBe('public');
    expect(p.amount).toBe('public');
    expect(p.supportsMemo).toBe(false);
  });

  it('never says "anonymous" or over-claims in any statement', () => {
    for (const kind of ['unified', 'sapling', 'transparent'] as const) {
      const p = privacyCapability(kind);
      const text = [p.summary, p.senderStatement, p.recipientStatement, p.routeLabel]
        .join(' ')
        .toLowerCase();
      expect(text).not.toContain('anonymous');
      expect(text).not.toContain('untraceable');
      expect(text).not.toContain('fully private');
    }
  });

  it('states that a transparent sender is not hidden by a shielded recipient', () => {
    const p = privacyCapability('sapling');
    expect(p.senderStatement.toLowerCase()).toContain('transparent');
    expect(p.senderStatement.toLowerCase()).toContain('visible');
  });
});

describe('withUnifiedReceivers', () => {
  it('names the best shielded pool available', () => {
    const p = withUnifiedReceivers(privacyCapability('unified'), {
      transparent: false,
      sapling: false,
      orchard: true,
    });
    expect(p.level).toBe('shielded');
    expect(p.routeLabel).toContain('Orchard');
    expect(p.recipientStatement).toContain('Orchard');
  });

  it('falls back to Sapling when Orchard is absent', () => {
    const p = withUnifiedReceivers(privacyCapability('unified'), {
      transparent: true,
      sapling: true,
      orchard: false,
    });
    expect(p.routeLabel).toContain('Sapling');
  });

  it('downgrades to transparent when only a transparent receiver exists', () => {
    const p = withUnifiedReceivers(privacyCapability('unified'), {
      transparent: true,
      sapling: false,
      orchard: false,
    });
    expect(p.level).toBe('transparent');
    expect(p.recipient).toBe('public');
  });

  it('leaves non-Unified capabilities untouched', () => {
    const base = privacyCapability('sapling');
    const p = withUnifiedReceivers(base, { transparent: false, sapling: false, orchard: true });
    expect(p).toBe(base);
  });
});

describe('privacyLines', () => {
  it('renders ordered, factual lines', () => {
    const lines = privacyLines(privacyCapability('unified'));
    expect(lines.map((l) => l.label)).toEqual(['Recipient', 'Amount', 'Sender']);
    expect(lines[0]!.value).toBe('Protected');
    expect(lines[2]!.value).toBe('Depends on payer');
  });
});
