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
- `packages/ui` — **REMOVED.** Nothing imported `@blink/ui`; the web app uses
  its own `apps/web/src/components`. Do not re-add a workspace package nothing
  consumes.
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

- **React 18/19 prerender.** `@blink/ui` (removed) once hit a React 18/19
  `useContext` prerender crash in Next 15. The web app is React 19 only; keep any
  shared React component compatible with 19.
- **Toolchain versions are load-bearing.** `vitest` is pinned to the v4 line
  (v5 requires Node ≥ 22.12, which the Render image does not guarantee) and the
  root `package.json` `overrides` force `shell-quote ^1.12` and Next's `postcss`
  to `^8.5.29`. `npm audit` is clean; keep it that way. Re-run `npm ci` (not just
  `npm install`) after changing overrides, or the nested copy is not re-resolved.
- API `tsconfig` excludes tests; `buildApp` is the test entry point.
- `.env` is git-ignored; `.env.example` has placeholders only.
- **NU7 decode.** Zcash testnet activates NU7 (consensus branch `0x77190AD9`) in
  October 2026. No *stable* `zcash_protocol` release defines that branch id, so
  the engine pins the `0.11.0-pre.0` line (`zcash_primitives 0.31.0-pre.0`,
  `zcash_address 0.14.0-pre.0`, `zip321 0.10.0-pre.0`). A stable-line engine
  rejects live transactions and verification silently returns `observed: false`.
  Verify with `node scripts/live-testnet-proof.mjs`.
- **Network-aware lightwalletd check.** `verification-provider.ts` compares
  `GetLightdInfo.chainName` against the provider's bound network via
  `expectedChainName()` (`mainnet → "main"`, `testnet → "test"`). Do NOT hard-code
  `'test'`: a mainnet-configured provider then rejects its own endpoint and every
  payment silently stays unconfirmed. Mainnet readiness is verified against real
  mainnet data without sending funds (engine decode + a real mainnet tx observed
  through a real mainnet lightwalletd endpoint).
- **Deploy wiring.** The web app calls `/v1/*` same-origin; `next.config.mjs`
  rewrites it to `API_BASE_URL` (server-side). Do NOT set `NEXT_PUBLIC_API_BASE_URL`
  on Render: it inlines a cross-origin URL at build time and reintroduces CORS
  failures. The API's `BLINK_ALLOWED_ORIGINS` is only a fallback.
- **Live production (Render).** `blink-web` / `blink-api` / `blink-engine` are the
  services that deploy from `main`. The API reports its effective providers at
  `/health` and its authoritative network at `/v1/meta/network`; `/health` also
  exposes `priceKeyConfigured` (a boolean, never the key). The web app no longer
  trusts the build-time `NEXT_PUBLIC_NETWORK`: `ConnectionProvider` polls
  `/v1/meta/network` at runtime and only hard-stops on a **genuine** disagreement
  (a mis-set env var or a stale build). While the API is still starting it renders
  the app and a non-blocking status strip, and keeps payment controls locked until
  the network is confirmed. `/ready` reports readiness (DB + engine) separately
  from `/health` liveness.
  On mainnet, `BLINK_PRICE_PROVIDER=coinmarketcap` degrades to `none` **only when
  `COINMARKETCAP_API_KEY` is empty in the running process** — the observed
  `priceProvider: none` therefore means the key did not reach the process, not a
  code fault. Verify the fix with `/health` (`priceProvider: coinmarketcap`,
  `priceKeyConfigured: true`) and `/v1/price/zec-usd`. The key lives only in the
  Render Dashboard env (never `NEXT_PUBLIC_*`, never in source); the CMC request
  sends it in the `X-CMC_PRO_API_KEY` header, never the URL. There is no Render
  API token in this environment, so that env var can only be set in the Dashboard.
- **Cold starts are tolerated, not treated as failures.** The free plan spins a
  service down after ~15 min idle; the next request waits tens of seconds.
  `ConnectionMonitor` (`apps/web/src/lib/connection.ts`) probes the API with
  backoff (1s → 10s cap) and reports `connecting` until the network is confirmed;
  it never turns a 502/transport error into a `mismatch`. The API's
  `EngineUnavailableError` carries a `reason` (`unreachable` vs `rejected`): a
  transient engine problem is retried and then reported as
  `engine_unavailable` (503), so a waking engine can never make a valid address
  look invalid; only a real 4xx rejection is `invalid_address`. `BLINK_ZCASH_TIMEOUT_MS`
  (default 10000) must exceed the engine cold-start time. A keep-warm workflow
  (`.github/workflows/keep-warm.yml`) pings `/ready` + `/health` every 10 min.
- **Never store a browser global on an instance and call it as a method.** A bare
  `setTimeout` assigned to a field (`this.setTimeoutImpl = setTimeout`) throws
  `Illegal invocation` when invoked as `this.setTimeoutImpl(...)`, because the
  receiver is the instance, not `window`. This silently killed the connection
  retry timer (the app stayed "connecting" forever after any failed probe).
  Always wrap: `(handler, ms) => setTimeout(handler, ms)`.
- **Memos are plaintext** (stored, shown, and encoded in the ZIP 321 URI). Only
  the recipient address is encrypted at rest. Never claim memos are encrypted.
- **Local `npm ci` needs `NODE_ENV=development`** (or `--include=dev`); the shell
  here exports `NODE_ENV=production`, which skips vitest/eslint. `unset NODE_ENV`
  before `next build`, or the prerender fails with a misleading `<Html>` error.
- **USD-denominated requests.** A request may be denominated in USD, but ZIP 321
  `amount` is always ZEC. The API converts server-side with exact BigInt math
  (`packages/shared/src/money.ts`, `convertUsdToZec`) and snapshots
  `usd_amount` / `zec_usd_price` / `price_provider` on the row so a later market
  move cannot change a created request. USD rarely maps to a whole zatoshi, so
  `settledZecAmount` rounds UP to the next zatoshi (over-ask < 1 zatoshi); both
  the API and the web preview call it, so they always agree. The live rate comes
  from `BLINK_PRICE_PROVIDER` (auto-selected: `coinmarketcap` when
  `COINMARKETCAP_API_KEY` is set, else the keyless `auto` chain (Coinbase, then
  CoinGecko); `none` disables USD
  with a 503 while ZEC still works; `coinmarketcap` needs
  `COINMARKETCAP_API_KEY`, server-side only, never returned by the API). Never
  let a failed conversion fall through as a ZEC amount. On mainnet in production
  the provider MUST be `coinmarketcap` (with a key) or `none`; the API refuses to
  boot with a keyless provider so a mainnet USD request is never priced from an
  unconfigured source. A missing `COINMARKETCAP_API_KEY` in production degrades
  to `none` (USD requests 503) rather than crashing the API, so ZEC keeps
  working; adding the key re-enables USD with no code redeploy.
- **CoinMarketCap integration is shape-sensitive.** The live v3 Quotes Latest
  endpoint returns `data` as an ARRAY and `quote` as an ARRAY of per-currency
  quotes; the code also accepts the legacy id-keyed object shape. The provider
  asserts the entry is ZEC (id `1437`, NOT `328` which is Monero) and the quote
  is USD, and refuses otherwise. Tests use the real array shape — a fabricated
  object payload previously hid the wrong id and an AttributeError on live data.
- **Payment `purpose` is presentation metadata.** `invoice` (default), `payroll`,
  `remittance`, `subscription`, `point_of_sale`. Stored on the row, echoed in
  `toPublic` and the receipt, and used to frame the UI. It NEVER changes how a
  request settles: every request is the same ZIP 321 payment in ZEC. Do not let a
  purpose imply a fabricated transaction or autonomous recurring charge.
- **The memo privacy fact is `public` by design.** `PrivacyCapability.memo` is
  always `'public'` and the UI renders it as "Plaintext". A shielded memo is
  encrypted on-chain, but BLINK stores/shows/encodes it in the clear; only the
  recipient *address* is encrypted at rest. Never label the memo protected.
- **`/v1/activity` and `resolveOwner` are gone.** There is no server-side account
  system; per-device history came from `localStorage`, and that page is removed.
  Do not reintroduce an owner-scoped route without a real auth model.
- **Production requires an explicit `DATABASE_URL`.** `loadConfig` throws in
  production if `DATABASE_URL` is unset/blank, so the API can never silently boot
  against the localhost development default.

## Deployment

- Production services (Render): `blink-web-bgkz`, `blink-api-j75b`,
  `blink-engine-4em8` on `*.onrender.com`. They auto-deploy from `main`. The
  `render.yaml` blueprint names the services `blink-web`/`blink-api`/
  `blink-engine`, so the live names carry a Render-appended suffix.
- Production runs **mainnet**: `ZCASH_NETWORK=mainnet` on all three services,
  mainnet lightwalletd (`https://zec.rocks:443`), and
  `BLINK_PRICE_PROVIDER=coinmarketcap`. `COINMARKETCAP_API_KEY` is a
  `sync: false` secret set in the Render Dashboard (never in git).
- No Render API key is available from the sandbox, so Render actions are done
  through the blueprint + git auto-deploy, not the Render API.

## Repo

Target GitHub: `itzebe/blink-zcash` (MIT).
