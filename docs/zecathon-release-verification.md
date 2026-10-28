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
