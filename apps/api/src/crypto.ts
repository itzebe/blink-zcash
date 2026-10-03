/**
 * Encryption of recipient addresses at rest.
 *
 * A recipient address is the only sensitive field BLINK stores. It is encrypted
 * with AES-256-GCM under a key supplied via `BLINK_ENCRYPTION_KEY`. The key
 * never leaves the process and is never logged.
 *
 * BLINK never stores, requests or logs seed phrases or private spending keys. It
 * does not hold funds. This module exists solely to protect recipient addresses
 * (which are public on-chain but need not be publicly enumerable from BLINK's
 * database).
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

export interface Crypto {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

function parseKey(hex: string): Buffer {
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new EncryptionKeyError('encryption key must be exactly 32 bytes (64 hex characters)');
  }
  return key;
}

/**
 * Build a Crypto instance. In non-production environments, when no key is
 * configured, an ephemeral random key is generated so local development works
 * without shipping a secret. Such ciphertext is not decryptable across restarts,
 * which is intentional: it prevents ephemeral keys from looking production-ready.
 */
export function createCrypto(keyHex: string, isProduction: boolean): Crypto {
  let key: Buffer;
  if (keyHex) {
    key = parseKey(keyHex);
  } else if (isProduction) {
    throw new EncryptionKeyError('BLINK_ENCRYPTION_KEY is required in production');
  } else {
    key = randomBytes(KEY_LENGTH);
  }

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      // version.byte || iv || tag || ciphertext
      return Buffer.concat([Buffer.from([1]), iv, tag, ciphertext]).toString('base64url');
    },

    decrypt(payload: string): string {
      const raw = Buffer.from(payload, 'base64url');
      if (raw.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new EncryptionKeyError('ciphertext is malformed');
      }
      const version = raw[0];
      if (version !== 1) {
        throw new EncryptionKeyError(`unsupported ciphertext version: ${version}`);
      }
      const iv = raw.subarray(1, 1 + IV_LENGTH);
      const tag = raw.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + AUTH_TAG_LENGTH);
      const ciphertext = raw.subarray(1 + IV_LENGTH + AUTH_TAG_LENGTH);
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}

/** Generate a new random 32-byte key, hex encoded, for use as a secret. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LENGTH).toString('hex');
}

/** Compare two strings without leaking length-independent timing. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
