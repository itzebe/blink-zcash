# Contributing to BLINK

Thanks for helping make private payments simpler. BLINK is a non-custodial Zcash
payment-request layer, so correctness and honesty matter more than features.

## Ground rules

1. **Never handle secrets.** No contribution may ask for, transmit, log or store
   a seed phrase or private spending key.
2. **Never fabricate blockchain state.** Do not add code that reports a
   transaction, confirmation or broadcast status that was not observed on real
   Zcash infrastructure.
3. **Use ZIP 321 correctly.** Do not invent a custom payment URI format.
4. **Keep testnet the default.** Mainnet must remain explicit and opt-in.
5. **Respect licenses.** Do not copy Zcash source code into BLINK; depend on the
   official libraries and record their licenses.

## Repository conventions

- TypeScript across `packages/*` and `apps/*`; Rust for `crates/blink-zcash`.
- Keep the separation of concerns: a package should not reach into another's
  internals. `@blink/payment-request` has no database or network access.
- The Rust engine is authoritative for address and ZIP 321 validation. The
  TypeScript implementations are a fast, structural first pass and must agree.
- No credential, key or endpoint is ever hard-coded. Configuration comes from the
  environment, with placeholders only in `.env.example`.

## Development

```bash
npm install
cp .env.example .env
createdb blink && npm run db:migrate
npm run dev            # API + web
```

Run the Rust engine separately with `cargo run` in `crates/blink-zcash`.

## Before opening a pull request

```bash
npm run build          # packages, API, web must compile
npm test               # packages + API
npm run test:rust      # Rust engine
npm run typecheck
npm run lint
```

Add tests for new behaviour. Security-relevant changes should have an explicit
test asserting the safe outcome (for example, that a claimed txid does not
confirm a payment).

## Commit and PR style

- Small, focused commits with a clear subject line.
- Explain *why* in the body when the change is non-obvious.
- For security-sensitive changes, describe the threat being addressed.
- Do not commit `.env`, keys, wallet files, build output or `node_modules`.

## Reporting security issues

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).
