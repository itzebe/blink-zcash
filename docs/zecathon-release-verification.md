# ZECATHON release verification

Release-readiness evidence for the settlement-verification fix and the
viewing-key support that followed it. Read this before quoting any claim about
BLINK settlement.

## What shipped

| Commit | Change |
| --- | --- |
| `0d2be8f` (PR #28) | Settlement verification: only recipient+amount evidence can settle a request; a receipt is issued only from that evidence. |
| `5cd9560` (PR #29) | Accept all four ZIP 316 viewing-key prefixes (R0 `uivk…`/`uview…`, R2 `uvi…`/`uvf…`). |
| `c39e2a4` (PR #30) | Documentation corrections so operator text matches the gating above. |

## The gate (why depth alone cannot settle)

`isSettlementEvidence` (`packages/shared/src/privacy.ts`) is the single source of
truth. It is true only when the stored record is `shielded_recipient_verified`
or `recipient_verified` **and** `amountVerified` is true:

- `payment-service.ts` — a mined transaction at full depth with no such record
  becomes `OBSERVED`, never `CONFIRMED`.
- `routes/index.ts` — `/v1/payment-requests/:code/receipt` returns `409` unless
  the row is `CONFIRMED` **and** `isSettlementEvidence(record)` is true. A legacy
  or malformed `null` record cannot be laundered into a receipt.

Consequence: with no `BLINK_RECIPIENT_VIEWING_KEY`, a shielded request can never
be promoted to `CONFIRMED` and can never produce a receipt.

## Automated evidence (CI, on the merged heads)

PR #29 and PR #30 each passed all three required checks on their exact head SHA:

- `Rust — engine`
- `TypeScript — lint, typecheck, build, test`
- `Playwright end-to-end`

## End-to-end settlement proof (real stack, no funds moved)

The gate is exercised end to end against a **cryptographically-real** Orchard
mainnet transaction built with the same official Zcash crates the engine uses,
driven through the **real** `LightwalletdProvider` (only the gRPC transport is
stubbed, because no funded mainnet note exists for a fixture), the **real** Rust
engine over HTTP, the **real** Fastify app and a **real** PostgreSQL database.
The recipient viewing key is the real UIVK/UFVK for that note.

| Scenario | Result |
| --- | --- |
| Correct UIVK + exact recipient + exact amount | `recipientVerified:true`, `amountVerified:true` → API `CONFIRMED`, receipt `200` |
| Correct UFVK (`uvf…`) for the same account | verifies identically |
| Wrong recipient (same key, different address) | `recipientVerified:false` |
| Underpayment (expected amount + 1 zatoshi) | `recipientVerified:true`, `amountVerified:false` |
| No viewing key (full depth, 11 confirmations) | no `shieldedVerification`; API stays `OBSERVED`, receipt `409` |
| Malformed key | HTTP `422 invalid_viewing_key` |

This is the strongest evidence obtainable without sending real funds: it proves
that confirmation depth alone cannot settle, that only recipient+amount evidence
can, and that wrong or missing evidence fails closed. It is **not** a real
mainnet payment — no funds were sent.

Supporting suites (all green, run locally against the merged head):

- Rust engine, real Zcash crates: `17 passed` (trial-decrypt, wrong recipient,
  underpayment, wrong txid, wrong key, wrong network).
- API integration, real PostgreSQL: `221 passed`.
- Real mainnet read-only decode through a live lightwalletd (`zec.rocks`):
  `15/15` checks, no broadcast.

## Independently observed production behaviour

Read-only. No funds moved, no payment created, no settings changed.

```bash
API=https://blink-api-j75b.onrender.com
ENG=https://blink-engine-4em8.onrender.com

# Liveness + effective configuration (presence-only; never the key itself).
curl -s $API/health
#  -> network=mainnet, verificationProvider=lightwalletd, priceProvider=coinmarketcap

# Readiness (database + engine), separate from liveness.
curl -s $API/ready

# Authoritative network + presence-only viewing-key metadata.
curl -s $API/v1/meta/network
#  -> recipientViewingKeyConfigured:false  (no viewing key is set in production)

# Engine liveness.
curl -s $ENG/health

# Revision marker: an R2 UFVK (`uvf…`) now parses. Pre-fix it was rejected with
# "Unrecognized Bech32m human-readable prefix". Post-fix the error advances past
# key parsing to transaction decoding.
curl -s -X POST $ENG/v1/transaction/verify-shielded -H 'content-type: application/json' \
  -d '{"data":"00","network":"testnet","viewing_key":"<an R2 uvftest… key>","expected_address":"u1invalid"}'
#  -> {"error":"invalid transaction: could not decode…"}  (key parsed)

# Fail closed on a malformed key.
curl -s -X POST $ENG/v1/transaction/verify-shielded -H 'content-type: application/json' \
  -d '{"data":"00","network":"testnet","viewing_key":"not-a-key","expected_address":"u1invalid"}'
#  -> {"kind":"invalid_viewing_key"}  HTTP 422

# Receipt gate fails closed for an unknown request.
curl -s $API/v1/payment-requests/zzzzzz/receipt
#  -> 404 not_found
```

## What is NOT verified

- No production payment was created or sent. The engine revision marker proves
  the new binary is serving; it does not prove a settlement end to end.
- `recipientViewingKeyConfigured` is `false` in production. No viewing key is
  provisioned, so on mainnet today a shielded request settles only to `OBSERVED`
  and **no receipt can be issued**. This is the fail-closed design, not a fault.
- A configured viewing key would be a precondition for receipt issuance, not
  proof of settlement on its own.
- The operator-reported payment/receipt is not evidence of cryptographic
  recipient-and-amount verification. Such verification requires a configured
  viewing key and a real trial-decrypt; neither is present in production now.

## To enable receipt-issuing settlement on mainnet

Set `BLINK_RECIPIENT_VIEWING_KEY` (a recipient Unified viewing key, server-side
only, in the Render Dashboard) on `blink-api`. The key is never logged, never
returned by any route and never stored. This is an operator action.

The variable is declared in `render.yaml` (`sync: false`), so the requirement is
visible in infrastructure-as-code and a rebuilt Blueprint prompts for it, while
its value lives only in the Render Dashboard. Set it in the Dashboard; do not
commit it. Per Render's Blueprint docs, `sync: false` values are not included in
preview environments and are ignored on Blueprint updates, so the Dashboard value
is the source of truth.

### Exact key format (ZIP 316)

A Unified viewing key's human-readable prefix encodes its revision and kind
([ZIP 316](https://zips.z.cash/zip-0316)):

| Revision | Incoming (detects deposits) | Full (in + out) |
| --- | --- | --- |
| R0 | `uivk…` | `uview…` |
| R2 | `uvi…` | `uvf…` |

On mainnet use the bare prefix; on testnet the prefix carries a `test` suffix
(`uvitest…`, `uvftest…`, …). Either kind works for BLINK (a full viewing key is
accepted and behaves identically for incoming detection), and the boot guardrail
in `config.ts` rejects a key whose prefix does not match `ZCASH_NETWORK`.

Official export path: Zallet exposes `z_exportviewingkey` (Unified Address →
`uview…`; add `ivk=true` → `uivk…`); see the
[Zallet RPC reference](https://github.com/zcash/zallet/blob/main/book/src/rpc/methods.md).
BLINK requires a **viewing** key, never a spending key.

### Confirm it took effect

```bash
curl -s https://blink-api-j75b.onrender.com/v1/meta/network
#  -> recipientViewingKeyConfigured:true
```
