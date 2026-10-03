# AGENTS.md — BLINK repository guide

Persistent notes for agents working in this repo.

## What this is

BLINK: a non-custodial Zcash payment-request app built on ZIP 321. Monorepo
(npm workspaces) plus a Rust crate.

## Layout

- `packages/shared` — types (`ZcashNetwork`, `AddressKind`, `PaymentStatus`),
  money math, and the enforced payment state-machine transition table.
- `packages/zcash` — address parsing/validation (`parseAddress`,
  `addressFingerprint`, `InvalidAddressError`). Sprout is intentionally excluded.
- `packages/payment-request` — ZIP 321 URI build/parse (`buildZip321Uri`,
  `buildSinglePaymentUri`, `parseSinglePayment`, `parseZip321`, `Zip321Error`,
  `base64urlEncode/Decode`, `encodeQchar/decodeQchar`).
- `packages/ui` — presentational components (React peer dep `^18.3.1 || ^19`).
- `apps/api` — Fastify + Postgres/Drizzle. `server.ts` builds the app
  (`buildApp({config, provider, crypto, now})` → `{app, service, config, db,
  crypto}`). Routes in `routes/index.ts`. Services: `payment-service.ts`,
  `short-code.ts`, `zcash-engine.ts`, `verification-provider.ts`. Migrations in
  `db/migrate.ts`.
- `apps/web` — Next.js 15 / React 19. Pages under `src/app/`. QR encodes the
  ZIP 321 URI (see `components/QrCode.tsx`).
- `crates/blink-zcash` — authoritative Rust engine on official crates
  (`zip321`, `zcash_address`, `zcash_protocol`). Serves `/v1/address/inspect`
  and `/v1/zip321/build`.
- `tests/e2e` — Playwright.

## Build & test commands

```bash
npm run build          # packages + api + web
npm test               # packages + api (vitest)
npm run test:rust      # cd crates/blink-zcash && cargo test
npm run test:e2e       # needs api+web running
npm run lint           # eslint flat config (eslint 9 + typescript-eslint 8)
npm run typecheck
```

Rust checks used in CI: `cargo fmt --all -- --check`,
`cargo clippy --all-targets -- -D warnings`, `cargo test`.

## Environment specifics in this sandbox

- Postgres at `127.0.0.1:5432`, user `blink`, pass `blink_dev_pw`, dbs `blink`
  and `blink_test`.
- Rust toolchain via `export PATH="$HOME/.cargo/bin:$PATH"`.
- API runs on 4000, web on 3000, Rust engine on 8080.

## Invariants — do not regress

1. Never accept/store/log seed phrases or private spending keys.
2. Never fabricate txid/confirmations/broadcast. `claimed_txid` (client claim)
   must stay separate from `txid` (verification-layer only).
3. Only confirmed after a real provider observation ≥ `BLINK_CONFIRMATIONS_REQUIRED`.
4. Raw recipient addresses: AES-256-GCM at rest, never in public projections or
   share links.
5. Short codes: CSPRNG, non-sequential.
6. Network isolation: mainnet vs testnet addresses rejected on mismatch; mainnet
   is opt-in and, in production, requires a configured verification provider.
7. ZIP 321 only; no custom payment URI format. Sprout rejected.

## Gotchas

- `@blink/ui` peerReact was bumped to `^18.3.1 || ^19.0.0` to avoid a React 18/19
  `useContext` prerender crash in Next 15. Keep it compatible with 19.
- API `tsconfig` excludes tests; `buildApp` is the test entry point.
- `.env` is git-ignored; `.env.example` has placeholders only.

## Repo

Target GitHub: `itzebe/blink-zcash` (MIT).
