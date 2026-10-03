# Architecture

BLINK is a monorepo with a clear separation of concerns: a standards-focused
payment-request core, an authoritative Zcash engine, an API that owns state, and
a web client that owns the experience.

```mermaid
flowchart LR
    subgraph Client
        WEB[apps/web<br/>Next.js]
    end
    subgraph Server
        API[apps/api<br/>Fastify]
        ENGINE[crates/blink-zcash<br/>Rust axum]
    end
    subgraph Data
        DB[(PostgreSQL)]
    end
    subgraph Network
        ZRPC[Zcash node /<br/>lightwalletd]
    end

    WEB -->|HTTP JSON| API
    API -->|HTTP JSON| ENGINE
    API --> DB
    API -->|observe only| ZRPC
```

## Components

### `packages/payment-request`

The ZIP 321 core. Pure functions, no I/O.

- `buildZip321Uri` / `buildSinglePaymentUri` — build `zcash:` URIs.
- `parseZip321` / `parseSinglePayment` — parse and validate.
- `base64urlEncode` / `base64urlDecode` — ZIP 321 memo encoding.
- `encodeQchar` / `decodeQchar` — per-parameter escaping rules.

### `packages/zcash`

Address parsing and classification.

- `parseAddress` — returns the address family and network.
- `addressFingerprint` — a truncated hash for display/debugging.
- `InvalidAddressError`.
- Sprout is deliberately **not** a supported family.

### `packages/shared`

Cross-cutting types and rules.

- `ZcashNetwork` (`testnet` | `mainnet`).
- `AddressKind` — transparent / sapling / unified.
- Money math and formatting.
- `PaymentStatus` and the transition table enforced by the API.

### `crates/blink-zcash`

The authoritative engine, built on the **official** Zcash Rust crates
(`zip321`, `zcash_address`, `zcash_protocol`). Serves address inspection and URI
building over HTTP so the TypeScript API can defer to it. Stateless; no keys, no
database.

### `apps/api`

Fastify service that owns request state.

- Creates and stores payment requests (address encrypted at rest).
- Owns short codes, events, idempotency and the state machine.
- Delegates authoritative validation to the Rust engine.
- Runs the verification layer, which is the only writer of blockchain-derived
  fields.

### `apps/web`

Next.js 15 + React 19 client. Home, request, pay, confirmation, status, activity
and receipt screens. QR codes encode the ZIP 321 URI itself.

## Data model

```mermaid
erDiagram
    users ||--o{ payment_requests : owns
    payment_requests ||--o{ payment_events : logs
    payment_requests ||--o{ transactions : observes
    users ||--o{ sessions : has
```

- `payment_requests` holds user-supplied metadata and the encrypted recipient
  address.
- `transactions` holds blockchain-observed state, written only by the verification
  layer.
- `payment_events` is an append-only log.

The split between `payment_requests` and `transactions` is what makes it
impossible for a client to forge a confirmation.

## Request lifecycle (API surface)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Service, network and provider status |
| `POST` | `/v1/payment-requests` | Create a request |
| `GET` | `/v1/payment-requests/:shortCode` | Public view (no raw address) |
| `GET` | `/v1/payment-requests/:shortCode/payment-details` | Amount/recipient/memo for the payer |
| `POST` | `/v1/payment-requests/:shortCode/initiate` | Mark payment initiated |
| `POST` | `/v1/payment-requests/:shortCode/transactions` | Report a claimed txid |
| `POST` | `/v1/payment-requests/:shortCode/verify` | Run the verification layer |
| `POST` | `/v1/payment-requests/:shortCode/cancel` | Cancel (management token required) |
| `GET` | `/v1/payment-requests/:shortCode/receipt` | Receipt, only if confirmed |
| `GET` | `/v1/activity` | Recent requests |
| `GET` | `/v1/meta/expiry-options` | Allowed expiry values |
