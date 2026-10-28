# BLINK ZECATHON demo — shortest credible path

Everything below runs against the **deployed** application. No funds are sent.
Mainnet only.

- Web: <https://blink-web-bgkz.onrender.com>
- API: `https://blink-api-j75b.onrender.com`
- Engine: `https://blink-engine-4em8.onrender.com`

## What the demo proves (and what it does not)

BLINK turns a Zcash address into a shareable ZIP 321 payment request, then only
marks it **CONFIRMED** and issues a receipt when the settlement is *verified
against the intended recipient and amount* — not merely deep enough.

| Claim | How the demo shows it |
| --- | --- |
| A request is a real ZIP 321 URI (ZIP 321 only) | Create a request; the QR/pay link is a `zcash:` URI |
| Confirmation depth alone cannot settle | A shielded payment with no viewing key stays **OBSERVED**; receipt is refused |
| Only recipient+amount evidence settles | With the recipient viewing key set, a real matching payment becomes **CONFIRMED** |
| Wrong or missing evidence fails closed | Malformed key → rejected; wrong key → rejected; unverified payment → no receipt |
| The recipient address is never exposed | Share link and receipt carry no address; only the payer's own wallet sees it |

Not claimed: BLINK does not hide the address from the payer (no Zcash primitive
exists for that), does not sign or broadcast, and a viewing key is a
*precondition* for verification, never proof by itself.

## Before the demo (one operator action)

The live app reports `recipientViewingKeyConfigured:false`, so no payment can
reach CONFIRMED yet. Set the operator viewing key:

1. Render Dashboard → **blink-api-j75b** → **Environment** → **Add Environment
   Variable**.
2. Key: `BLINK_RECIPIENT_VIEWING_KEY`. Value: the **mainnet recipient Unified
   viewing key** for the demo wallet (R0 `uivk…`/`uview…` or R2 `uvi…`/`uvf…`).
   Export it from the wallet (Zallet: `z_exportviewingkey`, add `ivk=true` for a
   `uivk…`). Never a spending key, never a `…test` key.
3. Save. The API redeploys automatically. Confirm:

   ```bash
   curl -s https://blink-api-j75b.onrender.com/v1/meta/network
   #  -> "recipientViewingKeyConfigured":true
   ```

Never paste the key into chat or a commit; it lives only in the Dashboard.

## Demo script (about 3 minutes)

1. **Open the app** — <https://blink-web-bgkz.onrender.com>. Point out the
   network pill reads **Zcash Mainnet** and the connection status is live.
2. **Create a request** — `/request`. Enter a name, a mainnet shielded recipient
   address (the demo wallet), an amount in ZEC (or USD — show the live ZEC/USD
   conversion), and paste the recipient's viewing key into the optional
   **Viewing key** field. Submit.
3. **Show the share link / QR** — the pay page opens. The QR encodes a `zcash:`
   ZIP 321 URI; the recipient address is **not** shown as text and is absent from
   the share link.
4. **Pay from a wallet** (pre-arranged, small amount, mainnet) to the address in
   the request. Then return to the request and press **Verify**.
5. **Show the honest states:**
   - Before enough confirmation, or before the shielded note is matched:
     **OBSERVED**, `recipientVerified:false` — and the receipt is refused
     (HTTP 409).
   - Once the provider trial-decrypts a note to the exact recipient for the exact
     amount at the required depth: **CONFIRMED**, `recipientVerified:true`,
     `amountVerified:true`, receipt issued (HTTP 200).
6. **Contrast:** create a second request **without** a viewing key and pay it —
   it stays **OBSERVED** forever. Depth is not settlement.

## Read-only evidence commands (run during the demo)

```bash
API=https://blink-api-j75b.onrender.com
ENG=https://blink-engine-4em8.onrender.com

# Which build is live (API and engine must agree).
curl -s $API/health | grep -o '"revision":"[^"]*"'
curl -s $ENG/health | grep -o '"revision":"[^"]*"'

# A malformed key fails closed (422), never "valid".
curl -s -o /dev/null -w '%{http_code}\n' -X POST $ENG/v1/viewing-key/inspect \
  -H 'content-type: application/json' -d '{"viewing_key":"not-a-key"}'

# The receipt gate: refused until settlement evidence exists.
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/payment-requests/<code>/receipt
```

## Fallback if no live payment is possible

Show the recorded evidence in `docs/zecathon-release-verification.md`: the
end-to-end suite drives a **cryptographically-real** Orchard mainnet transaction
through the real engine, provider, app and database, and shows correct
recipient+amount → CONFIRMED while wrong recipient, underpayment, missing key and
depth-only all fail closed. No funds move; it is the strongest evidence
obtainable without a real payment.
