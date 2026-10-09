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
 * Coarse privacy tier of a route, from most to least private. Only two tiers
 * exist: a route is shielded or it is not. There is deliberately no
 * "partially-shielded" tier — it would imply a guarantee BLINK cannot make about
 * a specific transaction.
 */
export type PrivacyLevel = 'shielded' | 'transparent';

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
  /**
   * A receiver of a typecode BLINK does not recognise is present. When a known
   * shielded receiver is absent, an unknown receiver must not be treated as a
   * confirmed shielded capability.
   */
  unknown?: boolean;
}

/**
 * The receiver composition a payer may be handed. Structurally identical to
 * `UnifiedReceivers`, but only ever populated for an address that satisfies the
 * shielded-only policy (no transparent receiver). Kept as a distinct name so a
 * reader — or a future change — cannot mistake a mixed (transparent-bearing)
 * Unified Address for a shielded-only one.
 */
export type ShieldedReceivers = UnifiedReceivers & { transparent: false };

/**
 * Whether a parsed address satisfies BLINK's shielded-first recipient policy.
 *
 * BLINK only hands a payer an address whose *only* receivers are shielded. This
 * refuses, in the primary flow:
 *   - a bare transparent address, and
 *   - a Unified Address that also exposes a transparent receiver, because ZIP 321
 *     lets the payer's wallet settle into that transparent receiver, which would
 *     make the recipient and amount public on-chain.
 *
 * `receivers` is the actual, decoded ZIP 316 receiver composition — never the
 * `u…` prefix. When `receivers` is absent (an older engine that did not report
 * composition) or unknown (an unrecognised receiver typecode), the policy fails
 * **closed**: an unconfirmable address is not handed out.
 */
export function shieldedOnlyPolicy(
  receivers: UnifiedReceivers | null | undefined,
):
  | { ok: true; receivers: ShieldedReceivers }
  | { ok: false; reason: 'transparent_recipient' | 'shielded_receiver_unconfirmed' } {
  if (!receivers) return { ok: false, reason: 'shielded_receiver_unconfirmed' };
  if (receivers.transparent) return { ok: false, reason: 'transparent_recipient' };
  if (!receivers.sapling && !receivers.orchard) {
    // No known shielded receiver: either transparent-only, or only an
    // unrecognised receiver is present.
    return { ok: false, reason: 'shielded_receiver_unconfirmed' };
  }
  if (receivers.unknown) {
    // A known shielded receiver exists, but an unrecognised receiver also does.
    // We cannot fully account for the composition, so we cannot confirm it is
    // shielded-only. Fail closed.
    return { ok: false, reason: 'shielded_receiver_unconfirmed' };
  }
  return {
    ok: true,
    receivers: {
      transparent: false,
      sapling: receivers.sapling,
      orchard: receivers.orchard,
    },
  };
}

/**
 * What BLINK could actually establish about a shielded payment's settlement.
 *
 * These states are deliberately narrower than "paid". From public transaction
 * bytes a third party can establish that a transaction exists, is mined, and
 * which pools it touches — but for a shielded recipient it cannot establish who
 * was paid or how much. The states below never conflate those.
 *
 *  - `observed`                    — a mined transaction matching the claim was
 *                                    seen, but its pool composition could not be
 *                                    decoded (or it is not yet at depth). No
 *                                    public contradiction was found.
 *  - `shielded_activity_observed`  — the transaction touches a shielded pool and
 *                                    does not pay the recipient's transparent
 *                                    receiver. The shielded settlement is
 *                                    plausible; the recipient and amount remain
 *                                    unprovable from public data.
 *  - `recipient_verified`          — the recipient exposes a transparent receiver
 *                                    and the transaction provably pays it. This
 *                                    is the only state in which the requested
 *                                    recipient and amount are independently
 *                                    verified, and it only arises for a
 *                                    transparent-capable recipient (not the
 *                                    primary shielded-only flow).
 *  - `transparent_settlement`      — the transaction touches no shielded pool, so
 *                                    the settlement is public. This contradicts a
 *                                    shielded request and is never confirmed as
 *                                    a shielded payment.
 *  - `contradictory`               — the transaction pays the recipient's
 *                                    transparent receiver, contradicting the
 *                                    shielded-only request.
 */
export const SHIELDED_VERIFICATION_STATES = [
  'observed',
  'shielded_activity_observed',
  'recipient_verified',
  'transparent_settlement',
  'contradictory',
] as const;

export type ShieldedVerificationState = (typeof SHIELDED_VERIFICATION_STATES)[number];

/** Public facts a verification provider could establish about a transaction. */
export interface TxPoolReport {
  transparent: boolean;
  sapling: boolean;
  orchard: boolean;
  shielded: boolean;
}

/** The persisted, honest result of verifying a shielded-payment settlement. */
export interface ShieldedVerificationRecord {
  state: ShieldedVerificationState;
  txid: string;
  pools: TxPoolReport | null;
  /** Whether the requested recipient's transparent receiver was paid, and how much. */
  transparentRecipientZatoshis: number | null;
  /** Whether the requested recipient and amount were independently verified. */
  recipientVerified: boolean;
  amountVerified: boolean;
  /** Provider that produced this evidence. */
  source: string;
  observedAt: string;
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
  /**
   * How private the memo is. A Zcash shielded memo is encrypted on-chain, but
   * BLINK stores, shows and encodes it in plaintext, so the honest answer is
   * `public` (and the UI labels it "Plaintext"). Present so the privacy of the
   * memo is stated by the same layer that classifies the route, never inferred
   * per component.
   */
  memo: PrivacyFact;
  /** A short, human label for the route, e.g. "Shielded recipient". */
  routeLabel: string;
  /**
   * Coarse capability tier used for styling and ordering, from most to least
   * private. Not a guarantee about any specific transaction.
   */
  level: PrivacyLevel;
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
   * shielded-only Unified Address. `null` otherwise. A mixed Unified Address
   * (one exposing a transparent receiver) never satisfies the shielded-only
   * policy, so it is never recorded here either.
   */
  receivers: ShieldedReceivers | null;
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
        // A memo is stored/displayed/encoded in plaintext by BLINK.
        memo: 'public',
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
        // A memo is stored/displayed/encoded in plaintext by BLINK.
        memo: 'public',
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
        // A memo is stored/displayed/encoded in plaintext by BLINK.
        memo: 'public',
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
 *
 * Kept total and composition-safe: any receiver shape maps to an honest
 * capability. The acceptance decision itself lives in `shieldedOnlyPolicy`, so
 * this projection can also render a mixed or unconfirmable address truthfully
 * (for a defensive display) without ever labelling it a shielded payment.
 */
export function withUnifiedReceivers(
  capability: PrivacyCapability,
  receivers: UnifiedReceivers,
): PrivacyCapability {
  if (capability.recipientKind !== 'unified') return capability;

  const best = receivers.orchard ? 'Orchard' : receivers.sapling ? 'Sapling' : null;
  if (!best) {
    const onlyTransparent = receivers.transparent && !receivers.unknown;
    return {
      ...capability,
      receivers: null,
      recipient: 'public',
      amount: 'public',
      level: 'transparent',
      routeLabel: onlyTransparent
        ? 'Unified Address (transparent receiver only)'
        : 'Unified Address (no confirmed shielded receiver)',
      summary: onlyTransparent
        ? 'This Unified Address exposes only a transparent receiver, so payments to it are publicly visible on-chain.'
        : 'BLINK could not confirm a shielded receiver in this Unified Address, so it cannot claim the payment is shielded.',
      recipientStatement: onlyTransparent
        ? 'The recipient address and the paid amount are publicly visible on the Zcash blockchain.'
        : 'BLINK could not confirm a shielded receiver, so the recipient and amount cannot be claimed as protected.',
    };
  }

  if (receivers.transparent || receivers.unknown) {
    // A shielded receiver exists, but so does a transparent (or unrecognised)
    // one. BLINK's shielded-only policy refuses such an address in the primary
    // flow because a wallet could settle into the transparent receiver. If a
    // capability is nonetheless rendered, it must name the public exposure and
    // must not record the receivers as a "shielded-only" composition.
    return {
      ...capability,
      receivers: null,
      level: 'transparent',
      routeLabel: `Unified Address (shielded possible: ${best}, but a transparent receiver is present)`,
      summary:
        'This Unified Address exposes a transparent receiver alongside a shielded one, so a payment to it may be publicly visible on-chain.',
      recipientStatement: `A ${best} receiver is present, but so is a transparent receiver: unless the payer's wallet chooses ${best}, the recipient and amount are publicly visible.`,
    };
  }

  return {
    ...capability,
    receivers: {
      transparent: false,
      sapling: receivers.sapling,
      orchard: receivers.orchard,
    },
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
    // A memo is always plaintext in BLINK: shown as "Plaintext" rather than the
    // generic "Public" so the wording is unmistakable.
    { label: 'Memo', value: capability.memo === 'public' ? 'Plaintext' : fact(capability.memo), fact: capability.memo },
  ];
}

/**
 * A short, plain-language status for the whole payment, for people who have
 * never used Zcash. Deliberately two words: "Shielded payment" or "Public
 * payment". It never claims the *sender* is hidden, because BLINK cannot know
 * which pool the payer spends from.
 */
export function privacyHeadline(capability: PrivacyCapability): string {
  return capability.level === 'shielded' ? 'Shielded payment' : 'Public payment';
}

/**
 * One sentence explaining the headline to a non-expert, in terms of what a
 * stranger can and cannot see on the public blockchain. It states the protocol
 * fact only — the BLINK application-level caveat is a separate note.
 */
export function privacyHeadlineSentence(capability: PrivacyCapability): string {
  return capability.level === 'shielded'
    ? 'Zcash protects the recipient and the amount on the public blockchain. Whether the sender is visible depends on the wallet the payer uses.'
    : 'On a public route, the recipient and the amount are visible to anyone on the Zcash blockchain. Privacy comes only from the payer using a shielded wallet.';
}

/**
 * The one thing Zcash protocol privacy does NOT cover: information BLINK itself
 * handles. Stated wherever privacy is explained, so the app never implies the
 * whole request is private. The recipient address is encrypted at rest and kept
 * out of the link, but the memo is plaintext and the request itself is a BLINK
 * record.
 */
export const BLINK_APP_PRIVACY_NOTE =
  'Zcash keeps the payment private on-chain. BLINK itself still stores this request: ' +
  'the recipient address is encrypted at rest and never appears in the share link, ' +
  'but the memo is stored and shown in plaintext. BLINK never holds your funds or keys.';
