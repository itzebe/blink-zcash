# BLINK security model

This document complements [`SECURITY.md`](../SECURITY.md) and describes what
BLINK protects, what it does not, and why.

## Actors

| Actor | Trust |
| --- | --- |
| Recipient | Chooses its own address; controls its own keys |
| Payer | Pays from its own wallet; BLINK never sees its keys |
| BLINK API | Non-custodial; stores request metadata and encrypted addresses |
| blink-zcash engine | Authoritative address / ZIP 321 validator; stateless |
| Verification provider | The only source of blockchain truth |

## Assets

| Asset | Where it lives | Protection |
| --- | --- | --- |
| Recipient address | Database, encrypted | AES-256-GCM under `BLINK_ENCRYPTION_KEY` |
| ZIP 321 URI (embeds the address) | **Not persisted** | Reconstructed on demand from the encrypted address |
| Memo | Database, **plaintext** | Not encrypted; shown and encoded in the clear (ZIP 321 memos are plaintext) |
| Private keys / seed phrases | **Nowhere** | BLINK never receives them |
| Management token | Recipient's browser only | Hash-compared server-side; required to cancel |
| Short link | Public | 64 bits CSPRNG; safe to share |
| Payment status / txid | Database | Written only by the verification layer |

## Key invariants

1. **No secret ever reaches BLINK.** There is no endpoint, form field or log line
   for a seed phrase or private spending key.
2. **BLINK cannot move funds.** It has no spending capability, by construction.
3. **Blockchain state is observed, never invented.** The default provider returns
   nothing and BLINK reports `UNKNOWN`.
4. **Client claims are separated from verified facts.** `claimed_txid` is a
   claim; `txid` is written only by the verification layer.
5. **Public projections omit raw addresses.** The public and share surfaces never
   include the address or the full URI.
6. **Network isolation.** A mainnet address is not accepted on testnet and vice
   versa; the check is duplicated locally and in the Rust engine.

## Threat model

### Addressed

- **Tampering with amounts or recipients.** The request is built once,
  server-side, and the URI is authoritative. The API never silently rewrites an
  amount or address.
- **Forged confirmations.** There is no client-writable path to `txid`,
  `confirmations` or `broadcast`. A client can only *claim* a txid, which cannot
  confirm a payment on its own.
- **Address disclosure via links.** Short links reference a server-side request;
  the raw address never appears in the link, the QR page URL, or shared text.
- **Link enumeration.** 64-bit CSPRNG short codes over a 32-character alphabet
  make guessing infeasible; there is no sequential id.
- **Double payment.** A confirmed request refuses further fulfilment
  (`already_paid`), and transaction ids are uniquely indexed.
- **Mainnet accidents.** Mainnet is opt-in, must match `NEXT_PUBLIC_NETWORK`, and
  in production requires a configured verification provider.
- **Secret leakage in logs.** RPC credentials are never logged; encryption keys
  never leave the process.

### Not addressed (and stated plainly)

- **The payer can read the recipient address.** A ZIP 321 request hands the
  recipient address to the payer's wallet, because the payer's wallet must know
  the destination to build the payment. BLINK keeps the address out of the share
  link, stores it encrypted at rest, and refuses a transparent-capable recipient,
  but it does **not** hide the recipient address from the payer. Hiding the
  destination from the party who authorizes the payment is a distinct property
  that no standard Zcash payment protocol currently provides. BLINK must never
  claim it.
- **Shielded-payment proof.** For shielded recipients, sender, amount and
  recipient are private. BLINK cannot prove them from public data. Without a
  recipient viewing key, BLINK can only confirm that a reported transaction has
  been mined to the required depth. With one, it can additionally trial-decrypt
  the transaction and establish that a shielded note pays the exact requested
  address, and whether the recovered amount matched — reported separately, and
  never as a claim about the sender.
- **A malicious recipient.** A recipient could publish a request for an address
  they do not control. BLINK cannot verify address ownership; it validates
  format, kind and network only.
- **Endpoint compromise.** If the API host is compromised, stored messages and
  timing metadata could be read. Addresses remain encrypted at rest.
- **Denial of service.** Basic rate limiting is present; it is not a complete DoS
  defence.

## Verification design

The verification layer (`apps/api/src/services/verification-provider.ts`) is
deliberately narrow:

- It can only **observe**. It cannot create, sign or broadcast a transaction.
- It returns either what it saw or `null`. It never synthesizes an observation.
- Observations are stored in a separate `transactions` table with the provider
  name and a redacted raw payload for audit.

Providers:

- `none` (default): reports `UNKNOWN`, honestly.
- `node-rpc`: queries a zcashd JSON-RPC endpoint for a claimed txid.
- `lightwalletd`: uses the lightwalletd `CompactTxStreamer` gRPC API. It confirms
  the endpoint serves the configured network, fetches the reported transaction,
  derives the real txid from the returned bytes with the authoritative Zcash
  engine (rejecting the observation unless it matches the claim), and computes
  confirmations from the chain tip. It requires `BLINK_LIGHTWALLETD_URL` and
  `BLINK_ZCASH_SERVICE_URL`, and reports nothing when either is missing or
  unreachable.

### Key-based shielded recipient verification

When `BLINK_RECIPIENT_VIEWING_KEY` is configured, the provider additionally
trial-decrypts the observed transaction's shielded outputs with that key via the
engine's `/v1/transaction/verify-shielded` endpoint. This is the **only** path
that can assert a *shielded* recipient was paid. The engine attributes a note to
the recipient only when the recovered address is byte-for-byte the requested one
**and** the decoded bytes match the claimed txid, and reports the amount match
separately. The resulting state is `shielded_recipient_verified`, distinct from
the public `recipient_verified` route.

The verification is fail-closed: a wrong-network key, a malformed key, bytes the
engine cannot decode, an engine timeout, or a malformed engine response all
report *no* shielded verification (never a fabricated match). A transaction being
mined, or merely carrying a shielded bundle, never independently establishes
recipient verification. Confirmation depth remains a separate requirement.

## Why BLINK does not weaken privacy for verification

It would be easy to make verification simpler by asking recipients to publish
viewing keys publicly or to use transparent addresses. BLINK refuses both.
Verification is designed around what a wallet/payment integration can
legitimately observe: an operator-provisioned, server-side, non-spending viewing
key that is never stored or exposed, or wallet-side mechanisms.
