# Shielded payments and the payer-facing address limit

This document states, precisely and with evidence, what BLINK does and does not
protect, and why "hide the recipient address from the sender" is not achievable
with any standard Zcash payment protocol today. It is written so the claim can be
checked rather than trusted.

## The four distinct properties

These are easy to conflate. They are not the same thing.

| Property | Meaning | BLINK status |
| --- | --- | --- |
| Protected at rest | The recipient address is encrypted in the database | **Yes** — AES-256-GCM under `BLINK_ENCRYPTION_KEY` |
| Omitted from the public link | The share link carries no address | **Yes** — the link is `/pay/<shortCode>` only |
| Not displayed in BLINK's interface | BLINK does not print the address as text | **Yes** — the address appears only inside the optional "View details" ZIP 321 disclosure on the payer page |
| Hidden from the payer's wallet | The payer cannot learn the destination | **No** — the payer's wallet receives the address to build the payment |

Only the first three are implemented. The fourth is not, and no standard Zcash
protocol provides it.

## Why a ZIP 321 request exposes the destination to the payer

ZIP 321 defines a `zcash:` URI whose recipient address is part of the URI itself
(the `hier-part`, or an `address=` parameter for multi-recipient requests). The
sender's wallet parses that URI to learn **who** to pay and **how much**. The
address is not a hint the wallet can ignore: it is the payment destination.

The protocol makes this necessary, not incidental. A shielded output is encrypted
to the recipient with ChaCha20-Poly1305 using a key derived by ephemeral-static
ECDH between an ephemeral secret and the **recipient's address**. To produce that
output, the sender's wallet must know the recipient's address and derive the
shared secret from it. A wallet cannot send to a destination it cannot see.

So a shielded transaction hides the parties from **public observers**, but the
payer (and the payer's wallet) always knows the destination by construction.

Evidence:

- ZIP 321 — Payment Request URIs, <https://zips.z.cash/zip-0321> (the address is
  in the URI; the `label` key is a display name shown "as well as the associated
  address").
- Zcash Community Forum, "Can shielded transaction values be unmasked via
  practical brute forcing?" — the note encryption key is derived "using
  ephemeral-static ECDH from the recipient's address and an ephemeral secret";
  the recipient's address "is not published in the transaction" (public privacy)
  but is required by the sender to build the output (payer knowledge).
- Zcash documentation, "Addresses and Value Pools" — recipients do not learn the
  sender's address; the converse, the sender hiding the recipient from itself,
  is not a protocol feature.

## What was investigated, and why each is not a solution

| Approach | Reality | Meets "hide destination from payer"? |
| --- | --- | --- |
| Standard ZIP 321 URI | Address is in the URI the wallet parses | No |
| Shielded (Sapling/Orchard) recipient | Hides parties from **public** observers; sender still needs the address | No |
| Unified Address (ZIP 316) | Lets the wallet pick the most private receiver; the payer still receives the UA and its receivers | No |
| Reusable payment codes / stealth addresses (BIP 47, BIP 352) | Bitcoin standards; no maintained Zcash implementation, no Zcash wallet support | Not applicable to Zcash today |
| Monero-style stealth addresses | Native to Monero, not Zcash | Not applicable |
| "ZecAuth" | A community **proposal** (forum post) for authenticated payment interaction; not a finalized ZIP, no wallet implementation | Not available |
| Custodial forwarding / omnibus wallet | BLINK would receive the payer's funds and forward them | Rejected: breaks non-custodial design |

The only architecture that would fully hide the destination from the payer is one
where the payer pays an intermediary that BLINK (or a third party) controls and
the intermediary forwards to the recipient. That is a custodial/forwarding model.
BLINK explicitly rejects it: it would take control of funds, add an omnibus
wallet and spending keys, and turn a non-custodial interface into a custodian.

## The capability that would be required

To hide the recipient from the payer without custody, the Zcash ecosystem would
need a standardized, wallet-supported **indirect payment** primitive: a way for
the payer's wallet to construct a valid shielded output to the recipient without
being told the recipient's address — for example a payment code the sender can
blind, or a recipient-run endpoint that returns a per-payment one-time address.
No such primitive is standardized for Zcash today (as of the 2025-2026 ZIP set),
and no mainstream wallet implements one. Until one exists, BLINK cannot deliver
payer-side address confidentiality and must not claim it.

## What BLINK does instead

- Encrypts the recipient address at rest and reconstructs the ZIP 321 URI on
  demand; the plaintext URI is never persisted.
- Keeps the address out of the share link and out of public API projections,
  event payloads and logs.
- Refuses any recipient that could settle transparently (a bare transparent
  address, or a Unified Address that also exposes a transparent receiver), so a
  compatible wallet cannot silently choose a transparent receiver and expose the
  payment on-chain.
- States the payer-facing limit in the interface itself, in the litepaper, and in
  the security model, so the product never implies more privacy than it provides.
