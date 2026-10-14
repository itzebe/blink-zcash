import { describe, expect, it } from 'vitest';

import { previewRecipient } from './privacy-preview.js';

const TEST_SAPLING =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';
const TEST_TRANSPARENT = 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU';
const TEST_UA_SAPLING_ORCHARD =
  'utest1udj294cv9avaz0utlaypnn6cp576nnzm49jq80rutejsq3jqz9pafpy8280hkf73w98n59vr02y37x3x9pzlnmd0m9f0zm7fxjh9humnl4ah77fxjcptakzq29thqhw9gu4n332mlh6868u2g4tsr3pp9qx3nxmsu6ztsaat3u6jhy3k';
const TEST_UA_TRANSPARENT_SAPLING =
  'utest1umlnyxwzc6rgz900aax35m4e5f3p2lfexpmsrkdw9mr48mk9m4twgww9xcwmdzvhr7gsp9r8djhhg8q0dgt0rfa3s95az5vq4x983lu2q070avytpcgrs8a99muv7zk3v6nzw8ylk6a';

describe('previewRecipient', () => {
  it('accepts a Sapling address as a shielded-only recipient', () => {
    const preview = previewRecipient(TEST_SAPLING, 'testnet');
    expect(preview.rejected).toBe(false);
    expect(preview.privacy?.level).toBe('shielded');
    expect(preview.privacy?.receivers).toBeNull(); // Sapling carries no UA receivers
  });

  it('accepts a shielded-only Unified Address and names the best pool', () => {
    const preview = previewRecipient(TEST_UA_SAPLING_ORCHARD, 'testnet');
    expect(preview.rejected).toBe(false);
    expect(preview.privacy?.receivers?.orchard).toBe(true);
  });

  it('rejects a bare transparent address under the shielded-only policy', () => {
    const preview = previewRecipient(TEST_TRANSPARENT, 'testnet');
    expect(preview.rejected).toBe(true);
    expect(preview.privacy).toBeNull();
  });

  it('rejects a Unified Address that also carries a transparent receiver', () => {
    const preview = previewRecipient(TEST_UA_TRANSPARENT_SAPLING, 'testnet');
    expect(preview.rejected).toBe(true);
  });

  it('flags a network mismatch instead of silently accepting it', () => {
    const preview = previewRecipient(TEST_SAPLING, 'mainnet');
    expect(preview.rejected).toBe(false);
    expect(preview.privacy).toBeNull();
    expect(preview.error).toMatch(/testnet/);
  });

  it('reports a parse error for a malformed address', () => {
    const preview = previewRecipient('not-an-address', 'testnet');
    expect(preview.privacy).toBeNull();
    expect(preview.error).toBeTruthy();
  });

  it('does nothing for an empty address', () => {
    expect(previewRecipient('', 'testnet')).toEqual({
      privacy: null,
      rejected: false,
      network: null,
      error: null,
    });
  });
});
