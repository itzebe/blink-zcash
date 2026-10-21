# Mainnet verification record

This document records the evidence behind BLINK's mainnet status. It exists so a
reader can check each claim rather than trust it, and so the line between
**user-reported facts**, **independently observed facts**, and **automated test
results** is never blurred.

It complements [`live-testnet-verification.md`](live-testnet-verification.md)
(which covers the testnet flow) and
[`security-model.md`](security-model.md) (which describes the verification
design).

## Evidence classes

| Class                  | Meaning                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| User-reported          | The operator states a transaction completed. No artifact is held by this repository.                |
| Independently observed | Reproduced by BLINK code against real network data, with commands recorded below.                   |
| Automated test         | Exercised by the test suite against a stub provider; proves code paths, not real-network behaviour. |
| Unverified             | No evidence establishes the claim.                                                                  |

## 1. Mainnet transaction completed

**Class: user-reported.** The operator has confirmed that a real Zcash **mainnet**
transaction was completed successfully. This is recorded as a user-reported fact.

- No transaction id, recipient, amount, or date is recorded here. None was
  supplied with a reproducible artifact, and this document does not invent one.
- A transaction id is deliberately **not** committed: a mainnet txid is a public
  record that can link a BLINK request to on-chain activity. If a redacted
  artifact is later provided, it can be summarised here without publishing
  wallet or recipient details.

## 2. Independent read-only mainnet evidence

**Class: independently observed.** Reproduced in this environment against real
mainnet data. No funds were sent, and nothing was signed or broadcast.

Endpoint: a public mainnet lightwalletd (`GetLightdInfo.chainName == "main"`).
Command:

```bash
BLINK_LIGHTWALLETD_URL=https://<mainnet-lightwalletd-host>:443 \
BLINK_ZCASH_SERVICE_URL=http://127.0.0.1:8080 \
node scripts/mainnet-readonly-check.mjs 40
```

Result — **15/15 checks passed** (observed at mainnet tip 3525530):

- The provider reports mainnet identity (`chainName=main`, ECC LightWalletD
  `v0.5.3`, consensus branch `37a5165b`).
- A genuine mined mainnet transaction carrying **Orchard/shielded** activity was
  fetched and decoded by the authoritative Rust engine; the decoded txid matched
  the requested txid byte for byte (txid binding).
- A shielded-pool transaction exposes **no transparent amount** for a shielded
  recipient (`recipientHasTransparent=false`, `transparentRecipientZatoshis=null`).
- Negative controls reject: unknown txid, a mismatched txid, a wrong-network
  claim, and a malformed recipient.
- The shielded-only receiver policy rejects a transparent-only address and a
  mixed transparent+shielded Unified Address, and accepts a shielded-only
  address.
- Confirmation depth is derived from chain state (no broadcast).

This establishes that BLINK's observe/decode/verify path and its shielded-only
policy behave correctly against **real mainnet data**. It does **not** establish
a settled payment to a specific recipient (see the matrix below).

## 3. Verification matrix

Each row is marked from the evidence actually held. "User-reported" is not the
same as "independently verified".

| Claim                                                              | Status                     | Basis                                                                                                |
| ------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Mainnet transaction completed                                      | **User-reported**          | Operator confirmation; no artifact in-repo                                                           |
| BLINK observes/decodes a real mainnet (shielded) transaction       | **Independently observed** | `mainnet-readonly-check.mjs` 15/15 (section 2)                                                       |
| Shielded-only policy holds on mainnet (transparent/mixed rejected) | **Independently observed** | Same run, policy controls                                                                            |
| Mainnet address/ZIP 321 handling and network isolation             | **Independently observed** | Same run, negative controls                                                                          |
| Shielded recipient independently verified                          | **Unverified**             | Requires a recipient viewing key trial-decrypt of the specific tx (section 4)                        |
| Payment amount independently verified                              | **Unverified**             | Same — no viewing key evidence held                                                                  |
| BLINK settlement logic verified against _that_ transaction         | **Unverified**             | The specific txid was not supplied as an artifact                                                    |
| Receipt issued and validated under the evidence policy             | **Unverified**             | A receipt requires `CONFIRMED` + settlement evidence; no such evidence held for the reported payment |

A transaction existing is **not** a settlement. BLINK marks a request `OBSERVED`
(never `CONFIRMED`, never a receipt) unless recipient-and-amount evidence is
established.

## 4. The viewing-key gate

The only path that can assert a **shielded** recipient and amount is
`BLINK_RECIPIENT_VIEWING_KEY` (a recipient viewing key, server-side only). When
set, the provider trial-decrypts the observed transaction's shielded outputs via
the engine's `/v1/transaction/verify-shielded` endpoint and attributes a note to
the recipient only when the recovered address is byte-for-byte the requested one
and the decoded bytes match the claimed txid; the amount match is reported
separately.

The API exposes presence-only state on `/v1/meta/network`
(`recipientViewingKeyConfigured: true|false`) so the client can name a missing
key without ever returning its value.

**Production note (read-only observation, no secret accessed).** At the time of
this record, production (`blink-api-j75b`) reported
`verificationProvider: lightwalletd`, `priceProvider: coinmarketcap`,
`priceKeyConfigured: true`, `network: mainnet`. Its `/v1/meta/network` did **not**
include `recipientViewingKeyConfigured` because production currently runs `main`,
which predates that field. Whether a production viewing key is configured is
therefore **not yet observable** and remains an open gate. A missing declaration
in `render.yaml` is **not** proof that the deployed environment lacks the key.

## 5. Closing the remaining gates

| Gate                                                         | What would close it                                                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shielded recipient + amount verified against the reported tx | Configure a recipient viewing key whose address matches the request, then re-run the flow; the provider trial-decrypts the tx and the request reaches `CONFIRMED` |
| Production viewing-key configuration                         | Read `recipientViewingKeyConfigured` from `/v1/meta/network` **after** a deploy that includes this field (deploy is out of scope for this record)                 |
| Funded mainnet shielded-payment, end to end                  | A controlled real mainnet payment to a shielded-only request with a matching viewing key, producing a `CONFIRMED` request and a valid receipt                     |

None of these is closed by the evidence held here. Do not describe a mainnet
shielded payment as independently verified until a viewing key trial-decrypts the
transaction to the exact requested address and amount.
