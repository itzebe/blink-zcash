# Live Zcash testnet verification

This document records how the BLINK verification layer was exercised against
**real Zcash testnet** infrastructure, what was proven, and what was not.

It is reproducible: the two scripts referenced here are in `scripts/` and read
their endpoint only from the environment.

## Endpoint selection

A candidate must be a legitimate lightwalletd-compatible server exposing the
`cash.z.wallet.sdk.rpc.CompactTxStreamer` gRPC API. Each candidate was checked,
in order, with read-only RPCs and no credentials:

1. DNS resolution and TCP/TLS reachability.
2. `GetLightdInfo` responds.
3. `GetLightdInfo.chainName` is `test` (testnet).
4. `GetLatestBlock` responds with a plausible height.
5. `GetTransaction` is implemented (a valid-but-unknown txid returns
   `NOT_FOUND`, not `UNIMPLEMENTED`).

Script: `scripts/live-testnet-proof.mjs` (and the inline probe used during
selection). Several long-documented endpoints
(`lightwalletd.testnet.z.cash`, `testnet.lightwalletd.com`) no longer resolve;
the endpoint used here resolved and passed every check.

The endpoint is supplied **only** via `BLINK_LIGHTWALLETD_URL`. It is never
hard-coded and never committed.

```bash
# .env (gitignored)
ZCASH_NETWORK=testnet
NEXT_PUBLIC_NETWORK=testnet
BLINK_VERIFICATION_PROVIDER=lightwalletd
BLINK_LIGHTWALLETD_URL=https://<testnet-lightwalletd-host>:443
```

## Build prerequisite (important)

The TypeScript API depends on the Rust engine for authoritative transaction
decoding. The running engine binary must be rebuilt after any engine change, or
`/v1/transaction/inspect` will 404 and **every** verification will correctly
return `null`:

```bash
cd crates/blink-zcash && cargo build --release
```

## Reproducing the verification

```bash
# 1. Start the Rust engine (fresh release build)
cd crates/blink-zcash && ./target/release/blink-zcash &

# 2. Start the API with lightwalletd configured (env only)
set -a && . ./.env && set +a && node apps/api/dist/server.js &

# 3. Provider-level proof against a real mined transaction
node scripts/live-testnet-proof.mjs 3

# 4. Full API flow (create -> claim -> verify -> receipt)
BLINK_CONFIRMATIONS_REQUIRED=4 BLINK_BLOCK_OFFSET=0 node scripts/live-flow.mjs
```

## What was observed

All figures below are real values returned by the network at the time of the
run; heights and txids are testnet-only and carry no value.

### Provider-level (`scripts/live-testnet-proof.mjs`)

```
REAL provider.observe() => {
 "txid": "8e861f49067d4fae4317ff9fb3799698e2ae33e0f82939d5231fd074e87948e9",
 "confirmations": 4,          // tip 4450801 - mined 4450798 + 1
 "broadcast": true,
 "blockHeight": 4450798,
 "source": "lightwalletd"
}
mismatched txid  => null (correctly rejected)
wrong network    => null (correctly rejected)
```

The transaction bytes returned by lightwalletd were decoded by the Rust engine
(`zcash_primitives`) to the canonical txid, which matched the claimed id byte for
byte. Confirmations were derived from the network tip, not assumed.

### Full API flow (`scripts/live-flow.mjs`)

With the API configured to require 4 confirmations and a transaction taken from
the newest block:

```
1. CREATE           -> status WAITING_FOR_PAYMENT
2. CLAIM TXID       -> HTTP 202 | status TRANSACTION_CREATED
3. VERIFY (1)       -> observed true | confirmations 1 | status CONFIRMING
   waiting for confirmations (need 4)...
   observed true | confirmations 38 | status CONFIRMED
5. RECEIPT          -> HTTP 200 (only issued once CONFIRMED)
FINAL STATE: CONFIRMED | confirmations: 38
```

The observed state sequence was produced entirely by the verification provider:

```
WAITING_FOR_PAYMENT -> TRANSACTION_CREATED -> CONFIRMING -> CONFIRMED
```

No database field was forced and no confirmation was fabricated. A `verify` call
against an unreachable endpoint yields `observed:false` and leaves the request
unconfirmed.

## What this does and does not prove

Proven:

- A real testnet transaction reported to BLINK is independently observed through
  real lightwalletd infrastructure.
- The canonical txid is derived from the returned transaction bytes and must
  match the claim, so a payer cannot point BLINK at an unrelated transaction.
- Confirmations come from the network tip and drive the state machine.
- Wrong-network and mismatched-txid inputs are rejected.

Not proven, and deliberately not claimed:

- **Amount and recipient matching.** lightwalletd's `GetTransaction` does not, by
  itself, prove that a specific shielded output paid a specific amount to a
  specific address. BLINK verifies that a transaction exists and is confirmed;
  it does not claim `address X sent exactly amount Y to Z` for shielded funds.
  See `security-model.md`.
- **A brand-new broadcast.** A fresh signed transaction was not constructed and
  broadcast from this environment because no funded testnet wallet / signing path
  was available (see below). The live run observed an already-mined testnet
  transaction, which exercises the same observe → confirm code path that a
  freshly broadcast transaction would.

## Missing dependency for a funded end-to-end run

A fully self-produced payment (create a fresh request, fund a wallet, sign, and
broadcast) requires a funded Zcash **testnet** wallet. It was not obtained:

- `zingolib`/`zingo-cli` (the maintained testnet-capable CLI wallet) ships no
  prebuilt binaries and must be built from source; there is no apt package.
- The testnet faucet (`zecfaucet.com`) is a reCAPTCHA-gated SPA whose API is on a
  non-standard port that this environment cannot reach, and automated faucet
  solving is not appropriate.

This is a funding/tooling dependency, not a code dependency. If a funded testnet
wallet (or a funded testnet address plus a signing path) is provided, the same
`scripts/live-flow.mjs` will exercise a freshly broadcast transaction.
