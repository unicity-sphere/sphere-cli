# Changelog

All notable changes to `@unicity-sphere/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Phase 1 scaffold: `package.json`, `tsconfig.json`, `tsup.config.ts`,
  `vitest.config.ts`, `eslint.config.js`, CI workflows.
- `bin/sphere.mjs` entry shim that prefers compiled `dist/index.js`,
  falls back to `tsx src/index.ts` for dev.
- `src/index.ts` + `src/version.ts` — commander dispatcher with full
  namespace topology stubbed out (wallet, balance, payments, dm, group,
  market, swap, invoice, nametag, crypto, util, faucet, daemon, host,
  tenant, config, completions).
- `src/index.test.ts` + `src/version.test.ts` — smoke tests verifying
  help output, version string, and unimplemented-namespace behavior.
- `README.md` + `CHANGELOG.md` + `LICENSE` (MIT).
- `.github/workflows/ci.yml` — lint + typecheck + test on push/PR.
- `.github/workflows/release.yml` — tag → `npm publish`.

### Planned
- **Phase 2:** migrate `sphere-sdk/cli/index.ts` (~5,000 lines) into the
  commander tree. Splits monolithic switch/case into per-namespace files.
- **Phase 3:** implement `DmTransport` (NIP-17 over Nostr), extract
  `@unicitylabs/hmcp-protocol` from agentic-hosting, publish per-command
  sync matrix.
- **Phase 4:** migrate `ahctl` commands from agentic-hosting into
  `sphere host` + `sphere tenant` namespaces.
- **Phase 5:** delete legacy CLI code from `sphere-sdk/cli/` and
  `agentic-hosting/src/cli/`. Remove HTTP bridge everywhere.
- **Phase 6:** v0.1.0 stable release.
