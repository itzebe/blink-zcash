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

## What is and is not encrypted at rest

Only the **recipient address** is encrypted at rest. The recipient address is
AES-256-GCM under `BLINK_ENCRYPTION_KEY`, and the ZIP 321 URI — which embeds that
address — is **not persisted**: it is reconstructed on demand from the encrypted
address when the payer opens the request. BLINK does not claim that all request
data is encrypted.

The **memo is plaintext**. ZIP 321 memos are plaintext on-chain, and BLINK
stores, displays and encodes the memo in the clear. A shielded memo is encrypted
on the Zcash blockchain by the protocol, but BLINK itself holds no viewing key
and stores the memo unencrypted. Do not put a secret in a memo.

## What BLINK does not hide from the payer

BLINK does **not** hide the recipient address from the payer. A ZIP 321 request
delivers the recipient address to the payer's wallet, because the payer's wallet
must know the destination to construct the payment. Anyone who opens the payment
link, or scans the QR code, can read the recipient address in the request, even
though:

- the address never appears in the share link (the link carries only a short code),
- the address is encrypted at rest, and
- a transparent-capable recipient is rejected.

These four properties are distinct and must never be conflated:

| Property | BLINK status |
| --- | --- |
| Address protected at rest | Yes (AES-256-GCM) |
| Address omitted from the public share link | Yes (short code only) |
| Address not displayed as text in BLINK's own interface | Yes (shown only in the optional "View details" disclosure) |
| Address hidden from the payer's wallet | **No** — the payer's wallet receives it to pay |

No standard Zcash payment protocol hides the destination from the party who
authorizes the payment; see `docs/shielded-payment-limits.md`.

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
