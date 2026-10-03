/**
 * Short code generation.
 *
 * Short codes are the only thing that appears in a shareable BLINK link. They
 * must be cryptographically random and unguessable: never sequential, never
 * derived from a database id or timestamp.
 *
 * We generate 8 bytes (64 bits) of CSPRNG output and encode it with a
 * Crockford-style base32 alphabet that omits visually ambiguous characters
 * (0/O, 1/I/L). 64 bits of entropy keeps the link unguessable while staying
 * short enough to read aloud.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 31 chars, no 0/O/1/I/L
const CODE_LENGTH = 13; // ceil(64 / log2(31)) ~= 13

/**
 * Generate a short code. Rejection sampling removes modulo bias so every code is
 * equally likely.
 */
export function generateShortCode(length = CODE_LENGTH): string {
  const out: string[] = [];
  const max = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (const byte of bytes) {
      if (byte >= max) continue;
      out.push(ALPHABET[byte % ALPHABET.length]!);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/** Validate the shape of a short code before hitting the database. */
export function isValidShortCode(code: string): boolean {
  if (code.length < 6 || code.length > 32) return false;
  return [...code].every((ch) => ALPHABET.includes(ch));
}
