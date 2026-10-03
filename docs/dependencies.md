# Third-party dependencies and licenses

BLINK is MIT-licensed. It does not copy Zcash source code. Runtime reliance on
Zcash functionality is through the **official** Zcash Rust crates, which are
themselves open source.

This is a summary for the MVP, not legal advice. Always confirm the exact license
text shipped with each dependency.

## Zcash-specific dependencies (Rust, authoritative engine)

| Crate | Used for | License |
| --- | --- | --- |
| `zip321` | ZIP 321 payment request URIs | MIT / Apache-2.0 |
| `zcash_address` | Transparent / Sapling / Unified address parsing | MIT / Apache-2.0 |
| `zcash_protocol` | `Zatoshis`, `MemoBytes`, consensus types | MIT / Apache-2.0 |
| `zcash_primitives` | Authoritative transaction decoding and txid derivation | MIT / Apache-2.0 |
| `bech32`, `bs58`, `f4jumble`, `blake2b_simd` | Address encoding primitives (pulled in transitively) | permissive (MIT/Apache-2.0) |

These are maintained under the `zcash` GitHub organisation. BLINK pins specific
versions in `crates/blink-zcash/Cargo.toml` and relies on their published
implementations rather than reimplementing cryptography.

## Node / TypeScript dependencies

| Package | Used for | License |
| --- | --- | --- |
| `next` | Web framework | MIT |
| `react`, `react-dom` | UI | MIT |
| `qrcode` | QR generation (encodes the ZIP 321 URI) | MIT |
| `fastify` | API framework | MIT |
| `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit` | HTTP hardening | MIT |
| `drizzle-orm` | Database access | Apache-2.0 |
| `pg` | PostgreSQL driver | MIT |
| `zod` | Schema validation | MIT |
| `@noble/hashes` | Hashing primitives | MIT |
| `@scure/base` | Base encoding primitives | MIT |
| `@grpc/grpc-js`, `@grpc/proto-loader` | lightwalletd gRPC client | Apache-2.0 |

## Development / test tooling

| Package | License |
| --- | --- |
| `typescript` | Apache-2.0 |
| `vitest` | MIT |
| `@playwright/test` | Apache-2.0 |
| `eslint` | MIT |
| `prettier` | MIT |
| `concurrently` | MIT |

## Policy

- Prefer official or well-known libraries over bespoke implementations.
- Pin versions and review licenses before adding a dependency.
- Do not add a dependency whose license is incompatible with MIT distribution
  without an explicit decision recorded here.
