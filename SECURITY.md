# Security Policy

BLINK is a non-custodial payment-request layer for Zcash. It is built on one
invariant: **BLINK never holds or touches user funds, and never handles the
secrets that control them.**

## The core security invariants

These are enforced in code and in tests, not just documented:

1. **BLINK never asks for a seed phrase or private spending key.** There is no
   code path that collects, transmits, logs or stores either. The web client has
   no field for them; the API has no endpoint that accepts them.
2. **BLINK never signs or broadcasts a transaction.** Payment happens inside the
   payer's own wallet, using a ZIP 321 payment request URI. BLINK hands off; the
   wallet approves.
3. **BLINK never fabricates blockchain state.** A payment is only reported as
   `CONFIRMED` when a verification provider has actually observed the transaction
   on legitimate Zcash infrastructure. The default provider reports nothing, and
   BLINK reports `UNKNOWN` rather than inventing an answer.
4. **A transaction id reported by a client is a claim, never proof.** It is
   stored in `claimed_txid`, separate from the verified `txid`, and can never by
   itself move a request to `CONFIRMED`.
5. **Raw recipient addresses are not exposed publicly.** They are encrypted at
   rest (AES-256-GCM) and never appear in a shareable BLINK link.
6. **Short links are unguessable.** They use 64 bits of CSPRNG entropy, never
   sequential ids, and are safe to share.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately to
the maintainers (open a GitHub security advisory on the repository, or contact a
maintainer directly). Include:

- what you found,
- how to reproduce it,
- the impact you believe it has.

We will acknowledge receipt and work with you on a coordinated disclosure.

## Threat model

See [`docs/security-model.md`](docs/security-model.md) for the full threat model,
including what BLINK does **not** protect against.

## What BLINK explicitly does not do

- It does not hold funds or act as a custodian or exchange.
- It does not implement custom cryptography.
- It does not implement Zcash transaction construction.
- It does not weaken the privacy of shielded transactions to make verification
  easier.
- It does not claim selective disclosure of shielded payments; it says plainly
  that it cannot cryptographically prove the sender, recipient or amount of a
  shielded transaction.

## Secret handling

- No credential is hard-coded. All configuration comes from the environment.
- `.env` is git-ignored; `.env.example` contains placeholders only.
- `BLINK_ENCRYPTION_KEY` is required in production and must be 32 bytes.
- In production, `ZCASH_NETWORK=mainnet` requires a configured verification
  provider; BLINK refuses to run blind on mainnet.
- RPC credentials are never logged.
