import { describe, expect, it } from 'vitest';
import {
  BLINK_APP_PRIVACY_NOTE,
  privacyCapability,
  privacyHeadline,
  privacyHeadlineSentence,
  privacyLines,
  shieldedOnlyPolicy,
  withUnifiedReceivers,
} from './privacy.js';

describe('shieldedOnlyPolicy', () => {
  it('accepts a Sapling-only Unified Address (no transparent receiver)', () => {
    const v = shieldedOnlyPolicy({ transparent: false, sapling: true, orchard: false });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.receivers).toEqual({ transparent: false, sapling: true, orchard: false });
  });

  it('accepts an Orchard-only Unified Address', () => {
    expect(shieldedOnlyPolicy({ transparent: false, sapling: false, orchard: true }).ok).toBe(true);
  });

  it('accepts a Sapling+Orchard Unified Address', () => {
    expect(shieldedOnlyPolicy({ transparent: false, sapling: true, orchard: true }).ok).toBe(true);
  });

  it('rejects a bare transparent address', () => {
    const v = shieldedOnlyPolicy({ transparent: true, sapling: false, orchard: false });
    expect(v).toEqual({ ok: false, reason: 'transparent_recipient' });
  });

  it('rejects a mixed Unified Address that also exposes a transparent receiver', () => {
    const v = shieldedOnlyPolicy({ transparent: true, sapling: true, orchard: true });
    expect(v).toEqual({ ok: false, reason: 'transparent_recipient' });
  });

  it('rejects a transparent+Orchard Unified Address (mixed)', () => {
    const v = shieldedOnlyPolicy({ transparent: true, sapling: false, orchard: true });
    expect(v).toEqual({ ok: false, reason: 'transparent_recipient' });
  });

  it('fails closed when receiver data is absent', () => {
    expect(shieldedOnlyPolicy(null)).toEqual({ ok: false, reason: 'shielded_receiver_unconfirmed' });
    expect(shieldedOnlyPolicy(undefined)).toEqual({
      ok: false,
      reason: 'shielded_receiver_unconfirmed',
    });
  });

  it('fails closed when only an unrecognised receiver is present', () => {
    const v = shieldedOnlyPolicy({ transparent: false, sapling: false, orchard: false, unknown: true });
    expect(v).toEqual({ ok: false, reason: 'shielded_receiver_unconfirmed' });
  });

  it('fails closed when a known shielded receiver is mixed with an unrecognised one', () => {
    const v = shieldedOnlyPolicy({ transparent: false, sapling: true, orchard: false, unknown: true });
    expect(v).toEqual({ ok: false, reason: 'shielded_receiver_unconfirmed' });
  });
});

describe('privacyCapability', () => {
  it('treats a Unified Address recipient as potentially shielded before receiver inspection', () => {
    // This is the *kind-level* default. The authoritative decision uses the
    // actual ZIP 316 receivers via `withUnifiedReceivers`; a `u…` prefix alone is
    // not proof of a shielded receiver.
    const p = privacyCapability('unified');
    expect(p.level).toBe('shielded');
    expect(p.recipient).toBe('protected');
    expect(p.amount).toBe('protected');
    // The sender is never claimed to be protected: a transparent payer stays public.
    expect(p.sender).toBe('varies');
    // A memo is plaintext in BLINK even for a shielded recipient.
    expect(p.memo).toBe('public');
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

  it('falls back to Sapling when Orchard is absent (shielded-only)', () => {
    const p = withUnifiedReceivers(privacyCapability('unified'), {
      transparent: false,
      sapling: true,
      orchard: false,
    });
    expect(p.level).toBe('shielded');
    expect(p.routeLabel).toContain('Sapling');
  });

  it('does not claim shielded for a mixed UA that carries a transparent receiver', () => {
    const p = withUnifiedReceivers(privacyCapability('unified'), {
      transparent: true,
      sapling: true,
      orchard: true,
    });
    expect(p.level).toBe('transparent');
    expect(p.receivers).toBeNull();
    expect(p.routeLabel.toLowerCase()).toContain('transparent receiver is present');
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

  it('does not claim shielded when no known shielded receiver is present', () => {
    const p = withUnifiedReceivers(privacyCapability('unified'), {
      transparent: false,
      sapling: false,
      orchard: false,
      unknown: true,
    });
    expect(p.level).toBe('transparent');
    expect(p.routeLabel.toLowerCase()).toContain('no confirmed shielded receiver');
  });

  it('leaves non-Unified capabilities untouched', () => {
    const base = privacyCapability('sapling');
    const p = withUnifiedReceivers(base, { transparent: false, sapling: false, orchard: true });
    expect(p).toBe(base);
  });
});

describe('privacyLines', () => {
  it('renders ordered, factual lines including the plaintext memo', () => {
    const lines = privacyLines(privacyCapability('unified'));
    expect(lines.map((l) => l.label)).toEqual(['Recipient', 'Amount', 'Sender', 'Memo']);
    expect(lines[0]!.value).toBe('Protected');
    expect(lines[2]!.value).toBe('Depends on payer');
    expect(lines[3]!.value).toBe('Plaintext');
  });
});

describe('privacyHeadline', () => {
  it('calls a shielded route a shielded payment', () => {
    expect(privacyHeadline(privacyCapability('unified'))).toBe('Shielded payment');
    expect(privacyHeadline(privacyCapability('sapling'))).toBe('Shielded payment');
  });

  it('calls a transparent route a public payment, never shielded', () => {
    expect(privacyHeadline(privacyCapability('transparent'))).toBe('Public payment');
  });

  it('downgrades a Unified Address with only a transparent receiver to public', () => {
    const p = withUnifiedReceivers(privacyCapability('unified'), {
      transparent: true,
      sapling: false,
      orchard: false,
    });
    expect(privacyHeadline(p)).toBe('Public payment');
  });
});

describe('privacyHeadlineSentence', () => {
  it('explains a shielded route without claiming the sender is hidden', () => {
    const s = privacyHeadlineSentence(privacyCapability('sapling')).toLowerCase();
    expect(s).toContain('protects');
    expect(s).toContain('sender');
    expect(s).toContain('depends');
    expect(s).not.toContain('anonymous');
  });

  it('states plainly that a public route is visible to anyone', () => {
    const s = privacyHeadlineSentence(privacyCapability('transparent')).toLowerCase();
    expect(s).toContain('visible');
    expect(s).not.toContain('anonymous');
  });
});

describe('BLINK_APP_PRIVACY_NOTE', () => {
  it('separates protocol privacy from what BLINK itself stores', () => {
    const note = BLINK_APP_PRIVACY_NOTE.toLowerCase();
    // Names the protocol guarantee...
    expect(note).toContain('zcash');
    // ...and the application-level caveat: the memo is plaintext.
    expect(note).toContain('plaintext');
    // Never claims the whole request is private or anonymous.
    expect(note).not.toContain('anonymous');
  });
});
