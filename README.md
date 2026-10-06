# BLINK

**SEND MONEY. NOT YOUR WALLET ADDRESS.**

BLINK is a radically simple, non-custodial payment-request interface for Zcash.
A recipient creates a payment request; BLINK produces a shareable link and a QR
code. The payer opens the link and pays from their own Zcash wallet. Nobody ever
copies a wallet address.

> **Status: production is Zcash Mainnet.** BLINK does not hold funds and cannot
> move them. It creates ZIP 321 payment requests and reports only what it can
> honestly observe about the resulting transaction through a real lightwalletd
> endpoint. Local development and CI default to testnet; the deployed services
> (see `render.yaml`) run mainnet.

---

## 1. What BLINK is

BLINK turns "send me Zcash" into a link you can put in a chat message.

- A recipient fills in an amount, an optional memo, and their own Zcash address.
- BLINK builds a standards-compliant **ZIP 321** payment request URI and renders
  it as a QR code and a short share link.
- The payer opens the link, sees the amount, recipient and memo, and pays with a
  compatible Zcash wallet.
- The recipient shares a link like `https://blink.app/pay/8K4Q2X` instead of a
  long `u1...` address.

BLINK is **not** a wallet, a custodian, an exchange, or a mixer. It is a
payment-request and payment-experience layer.

## 2. Why it exists

Sending Zcash today typically means: find the recipient's address, select the
whole thing, copy it, send it over some channel, and hope nothing was mangled in
transit. Addresses are long, easy to truncate, and easy to confuse between
networks. The burden is on the human.

Payment links remove that burden. They are a familiar pattern from every payment
app people already use. BLINK brings it to Zcash without weakening Zcash's
privacy guarantees.

## 3. The user problem

| Without BLINK | With BLINK |
| --- | --- |
| Copy a 100+ character address | Share a short link |
| Risk pasting the wrong network | Network is validated server-side |
| No way to state an amount up front | Amount and memo travel with the link |
| No receipt | A verifiable payment status and receipt |
| Address leaks into every message | Address stays private; only a short code is shared |

## 4. How the payment flow works

```mermaid
sequenceDiagram
    participant R as Recipient
    participant W as BLINK Web
    participant A as BLINK API
    participant E as blink-zcash (Rust)
    participant P as Payer Wallet
    participant N as Zcash Network

    R->>W: amount, memo, address
    W->>A: POST /v1/payment-requests
    A->>E: validate address + build ZIP 321 URI
    E-->>A: authoritative URI
    A-->>W: short link + QR (ZIP 321)
    R->>P: share link (WhatsApp, SMS, ...)
    P->>A: GET payment details
    P->>W: open /pay/:code
    W->>P: show amount, recipient, memo
    P->>P: user approves in wallet
    P->>N: broadcast real transaction
    P->>A: report txid (a claim)
    A->>N: verification layer observes
    N-->>A: confirmations
    A-->>W: CONFIRMING / CONFIRMED (only if observed)
```

The backend never needs the payer's or recipient's private spending key to create
a payment request.

## 5. Transaction lifecycle

BLINK does not collapse everything into "SUCCESS". A payment request moves
through an explicit state machine:

```
CREATED → WAITING_FOR_PAYMENT → PAYMENT_INITIATED → TRANSACTION_CREATED
        → BROADCAST → CONFIRMING → CONFIRMED
                            ↘ FAILED / EXPIRED / CANCELLED / UNKNOWN
```

Forward jumps are allowed (a wallet can broadcast before BLINK sees an
"initiate", and a verifier can observe several confirmations at once). Backwards
moves and leaving a terminal state are impossible: the transition table in
`packages/shared` is enforced by the API.

## 6. Why Zcash is necessary

The whole point is a private payment. On a transparent chain, a payment link is
just a public IOU: anyone can watch the amount and the parties. Zcash's shielded
pools let the payment itself stay private while the *request* is shareable. BLINK
is designed around that split — a public, shareable request and a private,
shielded settlement.

## 7. How ZIP 321 is used

[ZIP 321](https://zips.z.cash/zip-0321) defines the `zcash:` payment request URI
that wallets understand. BLINK uses it correctly and does not invent a format:

- **QR codes encode the ZIP 321 URI itself**, not a link to a web page. Scanning
  a BLINK QR with a compatible wallet yields the actual payment request.
- The URI scheme is `zcash:`; parameters include `amount`, `memo` (base64url per
  ZIP 321), and `label` / `message` where appropriate.
- Addresses, amounts, memos and networks are validated before a request is
  accepted.
- Memos are `base64url` encoded exactly as ZIP 321 specifies; memo bytes are
  capped at 512 and memos are rejected for transparent-only recipients, which
  cannot carry one.
- **Testnet and Mainnet are distinguished.** A mainnet address on a testnet
  deployment is rejected, and vice versa.
- Malformed or invalid required parameters are rejected, never silently coerced.
  BLINK never silently changes the amount or the recipient.

Two implementations exist by design:

- `packages/payment-request` — TypeScript, used by the web client and for fast
  structural validation.
- `crates/blink-zcash` — Rust, wrapping the **official** `zip321` and
  `zcash_address` crates. This is the **authoritative** implementation. When
  `BLINK_ZCASH_SERVICE_URL` is set, the API must get an authoritative answer
  before it accepts or returns a URI.

### USD-denominated requests

A recipient may denominate a request in **USD**. This does **not** change what
ZIP 321 carries: the standard requires `amount` in ZEC, so the API converts USD
to ZEC server-side at a live rate and the URI/QR always encode the ZEC amount.

- The conversion uses exact integer math (`packages/shared/src/money.ts`), never
  floating point. Because USD rarely maps to a whole number of zatoshis, the
  exact quotient is rounded **up** to the next zatoshi: the payer is asked for
  at least the USD-equivalent value, and the over-ask is under 1 zatoshi
  (1e-8 ZEC). It is never rounded down and never collapses to the raw USD
  figure.
- The live rate comes from a configurable price source (`BLINK_PRICE_PROVIDER`).
  When it is unset (or blank) the API auto-selects: CoinMarketCap if
  `COINMARKETCAP_API_KEY` is set, otherwise the keyless `auto` chain (Coinbase,
  then CoinGecko). Selecting `auto` builds the same chain: with the key present
  CoinMarketCap is tried first, with the keyless sources behind it. `none`
  refuses USD requests
  while ZEC requests keep working. Production mainnet requires
  `BLINK_PRICE_PROVIDER=coinmarketcap` with a key; the API refuses to boot
  otherwise, so a mainnet USD request can never be priced from a keyless source.
- The original request is snapshotted: `usd_amount`, `zec_usd_price` and
  `price_provider` are stored alongside the ZEC `amount`, so a later market move
  cannot change an already-created request. The payer sees both figures.
- A rate that is unavailable, invalid or zero fails safely with an explicit
  error. A failed
  conversion never falls through as a ZEC amount.
- The price provider's API key is **server-side only**; it is never sent to the
  browser and never returned by the API.

## 8. Architecture

```mermaid
flowchart TD
    USER[User] --> WEB[BLINK Web App<br/>Next.js]
    WEB --> API[Payment Request Service<br/>Fastify API]
    API --> ENGINE[blink-zcash engine<br/>Rust + official crates]
    ENGINE --> URI[ZIP 321 payment URI]
    URI --> QR[QR code / share link]
    QR --> PAYER[Payer]
    PAYER --> WALLET[Compatible Zcash wallet]
    WALLET --> TX[Real Zcash transaction]
    TX --> NET[Zcash network]
    NET --> VERIFY[Verification service]
    VERIFY --> STATUS[BLINK payment status]
    API --> DB[(PostgreSQL)]
    API --> STATUS
```

Repository layout:

```
/
├── apps/
│   ├── web/                  # Next.js 15 + React 19 UI
│   └── api/                  # Fastify API, Postgres/Drizzle, verification layer
├── packages/
│   ├── payment-request/      # ZIP 321 URI builder + parser
│   ├── zcash/                # Address parsing + validation
│   ├── shared/               # Types, money math, status state machine
│   └── ui/                   # Shared presentational components
├── crates/
│   └── blink-zcash/          # Authoritative Rust engine (official Zcash crates)
├── tests/
│   └── e2e/                  # Playwright end-to-end tests
├── docs/                     # Architecture, security model, ZIP 321 notes
├── scripts/                  # Developer helpers
├── .github/workflows/        # CI
├── .env.example
├── README.md
├── SECURITY.md
└── CONTRIBUTING.md
```

## 9. Local setup

Requirements: Node.js >= 20 (npm workspaces), Rust (stable), PostgreSQL 14+,
and optionally a Zcash node for verification.

```bash
git clone https://github.com/itzebe/blink-zcash.git
cd blink-zcash
npm install
cp .env.example .env        # then edit .env (never commit it)
```

## 10. Environment variables

All configuration is via the environment; nothing is hard-coded. See
[`.env.example`](.env.example) for the full list. The important ones:

| Variable | Purpose |
| --- | --- |
| `ZCASH_NETWORK` | `testnet` (default) or `mainnet` |
| `NEXT_PUBLIC_NETWORK` | must match `ZCASH_NETWORK` |
| `DATABASE_URL` | PostgreSQL connection string |
| `APP_BASE_URL` | public web base for share links |
| `BLINK_ENCRYPTION_KEY` | 32-byte hex; encrypts addresses at rest; required in production |
| `BLINK_ZCASH_SERVICE_URL` | URL of the Rust engine |
| `BLINK_VERIFICATION_PROVIDER` | `none` (default), `node-rpc`, or `lightwalletd` |
| `BLINK_LIGHTWALLETD_URL` | lightwalletd gRPC endpoint; required when the provider is `lightwalletd` |
| `BLINK_CONFIRMATIONS_REQUIRED` | confirmations before a payment reads `CONFIRMED` (default `1`) |
| `BLINK_PRICE_PROVIDER` | `coinmarketcap`, `coinbase`, `coingecko`, `auto`, or `none`; enables USD-denominated requests. When unset or blank, auto-selects CoinMarketCap if `COINMARKETCAP_API_KEY` is present, else the keyless `auto` chain (Coinbase, then CoinGecko). `auto` is a resilient chain that tries CoinMarketCap first when the key is present, then the keyless sources. `coinmarketcap` requires the key or the API refuses to start |
| `COINMARKETCAP_API_KEY` | server-side key for the live ZEC/USD rate when the provider is `coinmarketcap`, or preferred inside `auto` (never exposed to the browser) |
| `BLINK_PRICE_CACHE_TTL_MS` / `BLINK_PRICE_TIMEOUT_MS` | price cache window and request timeout (ms) |
| `ZCASH_RPC_URL` / `ZCASH_RPC_USER` / `ZCASH_RPC_PASSWORD` | full-node RPC, if used |
| `NEXT_PUBLIC_API_BASE_URL` | API base for the web app. When unset, the web app calls `/v1/*` same-origin and Next.js rewrites to `API_BASE_URL` |
| `API_BASE_URL` | API base used by the Next.js `/v1/*` rewrite (server-side) |
| `BLINK_ALLOWED_ORIGINS` | comma-separated CORS allowlist for browser calls (default `http://localhost:3000`). A deployed web origin must be added here or every cross-origin browser request is blocked |

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 11. Testnet setup

BLINK defaults to testnet. The safest way to exercise the full flow is to create
a testnet wallet in a Zcash-compatible wallet, fund it from a testnet faucet, and
pay a BLINK request with it. No mainnet configuration is required, and none is
enabled by default.

> **Verification status — read before trusting a status.**
> BLINK's testnet verification path has been exercised end to end against **real
> testnet data**: a real mined transaction was observed through a real
> lightwalletd endpoint, its bytes were decoded by the Rust engine to the
> canonical txid, and confirmations were derived from the chain tip — driving
> `WAITING_FOR_PAYMENT → TRANSACTION_CREATED → CONFIRMING → CONFIRMED`.
> What has **not** been performed in the development environment is a *fresh*
> wallet-to-BLINK payment (a newly signed and broadcast transaction from a funded
> wallet); no funded testnet wallet was available there. The exact evidence and
> the reproducible scripts are recorded in
> [`docs/live-testnet-verification.md`](docs/live-testnet-verification.md).

### Mainnet readiness

The stack is network-aware. Setting `ZCASH_NETWORK=mainnet` (and matching
`NEXT_PUBLIC_NETWORK=mainnet` on the API and web) selects mainnet end to end:
address validation, ZIP 321 requests, the Rust engine, the lightwalletd
provider's chain check, and the confirmation logic. Mainnet remains opt-in; in
production the API refuses to start unless a verification provider is
configured, and the engine refuses to start if `NEXT_PUBLIC_NETWORK` and
`ZCASH_NETWORK` disagree.

Verified against **real mainnet data without sending funds**:

- the engine classifies mainnet addresses and builds/parses mainnet ZIP 321 URIs;
- a **real mainnet transaction**, fetched from a mainnet lightwalletd endpoint,
  decoded to its canonical txid through the deployed engine;
- an API configured `ZCASH_NETWORK=mainnet` observed that real mainnet
  transaction through a real mainnet lightwalletd endpoint and drove
  `WAITING_FOR_PAYMENT → TRANSACTION_CREATED → CONFIRMED`;
- a mainnet-configured API rejects a testnet address (`address is for testnet
  but mainnet was expected`), and a testnet-configured API rejects a mainnet
  address, so the two networks can never be mixed;
- a fabricated txid never confirms (`observed: false`) and a receipt is only
  issued for a `CONFIRMED` request.

What has **not** been performed is a real funded mainnet payment (a newly signed
and broadcast mainnet transaction from a funded wallet). That requires a funded
mainnet wallet on the payer's device; BLINK never holds, signs, or broadcasts
funds. The lightwalletd endpoint must serve the selected network — the provider
checks `GetLightdInfo.chainName` (`test` for testnet, `main` for mainnet) and
refuses to observe otherwise. BLINK does not hard-code or endorse any
third-party endpoint; validate one before relying on it.

Create the database and apply migrations:

```bash
createdb blink          # or use your existing Postgres
npm run db:migrate
```

## 12. Running tests

```bash
# Everything (packages + API)
npm test

# Individual suites
npm run test:packages   # shared + zcash + payment-request (vitest)
npm run test:api        # API integration tests against a real Postgres
npm run test:rust       # Rust engine (cargo test)

# End-to-end (needs the API and web app running; see below)
npm run test:e2e        # Playwright
```

The API integration tests need a database named `blink_test`. Create and migrate
it once:

```bash
createdb blink_test
TEST_DATABASE_URL=postgres://blink:CHANGE_ME@127.0.0.1:5432/blink_test \
  npm run db:migrate -w @blink/api
```

## 13. Running the frontend

```bash
npm run dev -w @blink/web      # http://localhost:3000
```

## 14. Running the backend

Start the Rust engine and the API:

```bash
# Terminal 1 — authoritative Zcash engine (port 8080)
cd crates/blink-zcash && cargo run

# Terminal 2 — API (port 4000)
npm run dev -w @blink/api
```

Both can also be started together with `npm run dev` (API + web).

## 15. Building for production

```bash
npm run build           # packages, API, and web
cargo build --release --manifest-path crates/blink-zcash/Cargo.toml
```

> `next build` must run with the standard production environment. If your shell
> has `NODE_ENV=development` exported (for example after sourcing a `.env`),
> unset it first: `env -u NODE_ENV npm run build`.

Serve the API with `node apps/api/dist/server.js` and the web app with
`next start`. Set `NODE_ENV=production`, a real `BLINK_ENCRYPTION_KEY`, a real
`DATABASE_URL`, and a configured verification provider if you intend to use
mainnet.

## 16. Security model

BLINK is non-custodial and secrets-free by design:

- **Never asks for or stores** seed phrases or private spending keys.
- **Never signs or broadcasts.** Payment happens in the payer's wallet.
- **Never fabricates** transaction ids, confirmations or broadcast status.
- **A client-reported txid is a claim**, stored separately and never sufficient
  for confirmation.
- **Recipient addresses are encrypted at rest** and never placed in share links.
- **Short codes are cryptographically random**, never sequential.
- **Shielded payments are private**, so BLINK does not pretend a public explorer
  can prove sender/recipient/amount. It reports what it can legitimately observe.

Full detail: [`SECURITY.md`](SECURITY.md) and
[`docs/security-model.md`](docs/security-model.md).

## 17. Limitations

- **Verification depends on infrastructure.** BLINK can only confirm a reported
  transaction once it can reach a lightwalletd endpoint (or full node). If none
  is configured or reachable, BLINK reports `UNKNOWN` and never confirms. Even
  then, for shielded payments it can only confirm that the transaction exists and
  is mined to the required depth; it cannot prove amount or parties from public
  data. It says so rather than guessing.
- **`lightwalletd` provider is real but requires an endpoint.** It talks to the
  `CompactTxStreamer` gRPC API, decodes the returned transaction with the
  authoritative Zcash engine to bind the bytes to the claimed txid, and derives
  confirmations from the chain tip. It needs `BLINK_LIGHTWALLETD_URL` and a
  configured `BLINK_ZCASH_SERVICE_URL`; without either it reports nothing.
- **Expiry is a BLINK-layer concept.** A BLINK request expiring does not make a
  blockchain transaction impossible; it only stops BLINK from presenting it as
  payable.
- **No wallet auto-detection yet.** "Pay with Zcash" uses the ZIP 321 URI and a
  wallet handoff; deep links into specific wallets are roadmap work.
- **Testnet only.** Mainnet requires explicit operator configuration and a
  working verification provider.
- **USD requests need a live price source.** A request may be denominated in USD,
  but ZIP 321 carries ZEC, so the API converts at a live rate. When
  `BLINK_PRICE_PROVIDER` is unset or blank, the API auto-selects CoinMarketCap if
  `COINMARKETCAP_API_KEY` is configured, otherwise the keyless `auto` chain
  (Coinbase, then CoinGecko),
  so USD requests work on the deployed demo without a key. Selecting `auto`
  builds that same chain: with the key present CoinMarketCap is tried first, so
  the deployment uses it, and the keyless sources remain as a live fallback. If
  an operator sets
  `BLINK_PRICE_PROVIDER=none`, USD requests are refused with a 503 and only
  native ZEC requests work. The rate is snapshotted at creation, so the ZEC
  figure the payer sees does not track later market moves. A failed price lookup
  is always an explicit error, never a fabricated rate.
- **Engine must understand the current consensus branch.** The Rust engine
  decodes a returned transaction to bind its bytes to the claimed txid. Its
  Zcash dependency must be new enough to parse the transaction version the
  network currently produces. An engine whose decoder does not recognise the
  current consensus branch id rejects the transaction and BLINK reports
  `observed: false` (never a fabricated confirmation). Verify with
  `node scripts/live-testnet-proof.mjs`.
- **Deployment must set `BLINK_ALLOWED_ORIGINS` and enable camera.** A deployed
  API keeps the default `http://localhost:3000` CORS allowlist unless
  `BLINK_ALLOWED_ORIGINS` is set to the deployed web origin. The web app ships
  `Permissions-Policy: camera=(self)` so the `/scan` camera can open; a policy
  of `camera=()` disables it. Both are environment/deploy settings.
- **Memos are not encrypted.** A memo is stored and displayed in plaintext and
  is encoded in the ZIP 321 URI/QR. Only the recipient address is encrypted at
  rest. Do not describe memos as confidential.

## 18. Proof of payment, honestly

BLINK offers **PROVE PAYMENT** as a receipt, but it does not claim selective
disclosure it has not implemented. A receipt states, plainly:

> "This receipt confirms that BLINK observed a confirmed Zcash transaction
> associated with this payment request. BLINK cannot cryptographically prove the
> sender, recipient or amount of a shielded transaction; those details are
> private to the parties involved."

If a real Zcash payment-disclosure mechanism is implemented later (e.g. per the
relevant ZIP), the documentation will say exactly what is disclosed.

## 19. Roadmap

- Viewing-key-based note detection (proving amount/recipient for shielded notes).
- Deep links / detection for specific Zcash wallets.
- Mainnet hardening and a documented enablement checklist.
- Selective disclosure via an official Zcash mechanism, clearly documented.
- Optional recipient identity and request history sync.

## 20. Hackathon information

BLINK was built as a hackathon MVP to demonstrate a genuinely standards-based
private payment experience on Zcash. It targets Zcash Testnet, uses ZIP 321
correctly, delegates address/URI authority to the official Zcash Rust crates, and
refuses to claim anything about a payment it cannot observe. Contributions and
security reports are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE). BLINK does not copy Zcash source code; it depends on the official
open-source Zcash Rust crates. See
[`docs/dependencies.md`](docs/dependencies.md) for third-party licenses.
