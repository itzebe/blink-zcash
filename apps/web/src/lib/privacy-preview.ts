import {
  privacyCapability,
  shieldedOnlyPolicy,
  withUnifiedReceivers,
  type PrivacyCapability,
} from '@blink/shared';
import { parseAddress } from '@blink/zcash';

export interface RecipientPreview {
  /** The route's privacy capability, when the address is accepted. */
  privacy: PrivacyCapability | null;
  /** True when BLINK's shielded-only policy refuses the address. */
  rejected: boolean;
  /** The address network when it parsed, so a mismatch can be surfaced. */
  network: 'testnet' | 'mainnet' | null;
  /** A parse error, when the address is not a valid Zcash address at all. */
  error: string | null;
}

/**
 * Best-effort client-side preview of the recipient route.
 *
 * The server recomputes and stores the authoritative capability at creation;
 * this exists so a merchant sees, before submitting, whether BLINK's
 * shielded-only policy would accept the address. It applies the exact same
 * policy as the API, so a mixed (transparent-bearing) or unconfirmable address is
 * shown as rejected rather than described as shielded. It never invents an
 * acceptance the server would not also grant.
 */
export function previewRecipient(
  address: string,
  network: 'testnet' | 'mainnet' | null,
): RecipientPreview {
  const value = address.trim();
  if (!value) return { privacy: null, rejected: false, network: null, error: null };
  try {
    const parsed = parseAddress(value);
    if (network && parsed.network !== network) {
      return {
        privacy: null,
        rejected: false,
        network: parsed.network,
        error: `This address is for ${parsed.network}, but this app is configured for ${network}.`,
      };
    }
    const verdict = shieldedOnlyPolicy(parsed.receivers);
    if (!verdict.ok) return { privacy: null, rejected: true, network: parsed.network, error: null };
    return {
      privacy: withUnifiedReceivers(privacyCapability(parsed.kind), verdict.receivers),
      rejected: false,
      network: parsed.network,
      error: null,
    };
  } catch (err) {
    return {
      privacy: null,
      rejected: false,
      network: null,
      error: err instanceof Error ? err.message : 'Address could not be validated.',
    };
  }
}
