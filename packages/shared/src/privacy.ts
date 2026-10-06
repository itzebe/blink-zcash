/**
 * Privacy capability model.
 *
 * BLINK's core promise is honest privacy. A payment request names a recipient
 * address, and that address's *kind* determines what the Zcash protocol actually
 * protects. This module turns an address kind into a factual description of the
 * route so the UI can never claim more privacy than the transaction delivers.
 *
 * What the protocol does and does not hide
 * ----------------------------------------
 * Zcash transparency is a property of the *address pools* involved, not of the
 * app that made the request. For a payment from a transparent (t-address) sender
 * to a shielded recipient, the sender, the amount and the transparent inputs are
 * public on-chain; only the recipient's note (and, for Orchard, the shielded
 * value transfer) is protected. BLINK therefore states exactly that, rather than
 * calling the whole payment "anonymous".
 *
 * The sender side is not knowable at request time: BLINK never sees the payer's
 * wallet. So the sender fields describe what the *recipient type* implies about a
 * typical route, and the wording says "may be" where the sender's pool is not
 * determined by the request itself. A shielded recipient never makes a
 * transparent sender private, and BLINK says so.
 */

import type { AddressKind } from './index.js';

/** Whether a particular fact is protected, public, or simply not knowable. */
export type PrivacyFact = 'protected' | 'public' | 'varies';

/**
 * The receiver pools a Unified Address exposes. `null` means "not applicable"
 * for a non-Unified address. When known, the most private available receiver is
 * listed first so the UI can state the best case the recipient can actually
 * receive into.
 */
export interface UnifiedReceivers {
  transparent: boolean;
  sapling: boolean;
  orchard: boolean;
}

export interface PrivacyCapability {
  /** Address kind the recipient provided. */
  recipientKind: AddressKind;
  /** How private the recipient is. Always `protected` for shielded kinds. */
  recipient: PrivacyFact;
  /** How private the amount is, for this recipient kind. */
  amount: PrivacyFact;
  /**
   * How private the sender is. `varies` when the request cannot determine the
   * payer's pool (a transparent sender stays public even to a shielded
   * recipient).
   */
  sender: PrivacyFact;
  /** A short, human label for the route, e.g. "Shielded recipient". */
  routeLabel: string;
  /**
   * Coarse capability tier used for styling and ordering, from most to least
   * private. Not a guarantee about any specific transaction.
   */
  level: 'shielded' | 'partially-shielded' | 'transparent';
  /** One-sentence, protocol-accurate summary. */
  summary: string;
  /**
   * A precise statement of what the sender's wallet can leak. Never says
   * "anonymous"; names the pool that is public when one is.
   */
  senderStatement: string;
  /** A precise statement about recipient and amount privacy. */
  recipientStatement: string;
  /**
   * The strongest receiver pool this recipient can be paid into, when it is a
   * Unified Address. `null` otherwise.
   */
  receivers: UnifiedReceivers | null;
  /** True when a memo can be attached (shielded recipients only). */
  supportsMemo: boolean;
}

/**
 * Describe the privacy capability of a payment to the given address kind.
 *
 * This is derived purely from the address type, which is a public fact about the
 * recipient. It deliberately makes no claim about the payer's wallet.
 */
export function privacyCapability(recipientKind: AddressKind): PrivacyCapability {
  switch (recipientKind) {
    case 'unified':
      return {
        recipientKind,
        recipient: 'protected',
        amount: 'protected',
        sender: 'varies',
        routeLabel: 'Shielded recipient (Unified Address)',
        level: 'shielded',
        summary:
          'The recipient and amount are shielded. A shielded payer also hides the sender; a transparent payer remains public on-chain.',
        senderStatement:
          'A payer sending from a shielded wallet is private. A payer sending from a transparent address is visible on-chain; the shielded recipient does not hide the sender.',
        recipientStatement:
          'The recipient address and the paid amount are protected by Zcash shielded pools (Sapling and/or Orchard).',
        receivers: null,
        supportsMemo: true,
      };
    case 'sapling':
      return {
        recipientKind,
        recipient: 'protected',
        amount: 'protected',
        sender: 'varies',
        routeLabel: 'Shielded recipient (Sapling)',
        level: 'shielded',
        summary:
          'The recipient and amount are shielded by the Sapling pool. A shielded payer also hides the sender; a transparent payer remains public on-chain.',
        senderStatement:
          'A payer sending from a shielded wallet is private. A payer sending from a transparent address is visible on-chain; the shielded recipient does not hide the sender.',
        recipientStatement:
          'The recipient address and the paid amount are protected by the Sapling shielded pool.',
        receivers: null,
        supportsMemo: true,
      };
    case 'transparent':
      return {
        recipientKind,
        recipient: 'public',
        amount: 'public',
        sender: 'varies',
        routeLabel: 'Transparent recipient',
        level: 'transparent',
        summary:
          'A transparent recipient, address and amount are publicly visible on-chain. Privacy comes only from a shielded payer.',
        senderStatement:
          'A payer sending from a shielded wallet keeps their own side private, but the recipient and the amount they receive remain public.',
        recipientStatement:
          'The recipient address and the paid amount are publicly visible on the Zcash blockchain.',
        receivers: null,
        supportsMemo: false,
      };
    default: {
      // Exhaustiveness guard: a new AddressKind must be classified deliberately.
      const never: never = recipientKind;
      throw new Error(`unclassified recipient kind: ${String(never)}`);
    }
  }
}

/**
 * Refine a Unified Address's capability once its receivers are known, so the UI
 * can name the best pool the recipient can actually receive into instead of
 * implying Orchard when only a transparent receiver is present.
 */
export function withUnifiedReceivers(
  capability: PrivacyCapability,
  receivers: UnifiedReceivers,
): PrivacyCapability {
  if (capability.recipientKind !== 'unified') return capability;

  const best = receivers.orchard ? 'Orchard' : receivers.sapling ? 'Sapling' : null;
  if (!best) {
    // A Unified Address with only a transparent receiver is effectively
    // transparent: say so rather than overstating privacy.
    return {
      ...capability,
      receivers,
      recipient: 'public',
      amount: 'public',
      level: 'transparent',
      routeLabel: 'Unified Address (transparent receiver only)',
      summary:
        'This Unified Address exposes only a transparent receiver, so payments to it are publicly visible on-chain.',
      recipientStatement:
        'The recipient address and the paid amount are publicly visible on the Zcash blockchain.',
    };
  }
  return {
    ...capability,
    receivers,
    routeLabel: `Shielded recipient (Unified, ${best})`,
    recipientStatement: `The recipient address and the paid amount are protected by the Zcash shielded pool (best available: ${best}).`,
  };
}

/** A single ordered line for a receipt or details panel. */
export interface PrivacyLine {
  label: string;
  value: string;
  fact: PrivacyFact;
}

/** Render the capability as ordered, presentable lines. */
export function privacyLines(capability: PrivacyCapability): PrivacyLine[] {
  const fact = (f: PrivacyFact): string =>
    f === 'protected' ? 'Protected' : f === 'public' ? 'Public' : 'Depends on payer';
  return [
    { label: 'Recipient', value: fact(capability.recipient), fact: capability.recipient },
    { label: 'Amount', value: fact(capability.amount), fact: capability.amount },
    { label: 'Sender', value: fact(capability.sender), fact: capability.sender },
  ];
}
