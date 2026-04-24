# sphere-cli

The unified CLI for the Sphere SDK and agentic-hosting control — DM-native.

## Status

**Phase 2 — legacy bridge + live host commands.** The full wallet / balance /
payments / dm / market / swap / invoice / nametag / crypto / util / faucet /
daemon / config / completions surface is wired via the legacy sphere-sdk
dispatcher. The DM-native `sphere host` namespace (HMCP-0 over Sphere DMs) is
live and production-ready. Phase 4 (`sphere tenant` — ACP over DMs) remains
stubbed and exits with a pointer to the migration schedule.

See [`docs/SPHERE-CLI-EXTRACTION-PLAN.md`](https://github.com/unicity-sphere/sphere-sdk/blob/refactor/extract-cli-to-sphere-cli/docs/SPHERE-CLI-EXTRACTION-PLAN.md)
for the full migration plan (same doc lives in `agentic-hosting` under the
parallel refactor branch).

### What works today

| Namespace | Status | Notes |
|---|---|---|
| `sphere wallet` | legacy bridge | list, use, create, current, delete, init, status |
| `sphere balance` / `payments` / `dm` / `group` | legacy bridge | |
| `sphere market` / `swap` / `invoice` | legacy bridge | |
| `sphere nametag` / `crypto` / `util` / `faucet` | legacy bridge | |
| `sphere daemon` / `config` / `completions` | legacy bridge | |
| `sphere host` | **DM-native (live)** | HMCP-0: spawn, list, stop, start, inspect, remove, pause, resume, help, cmd |
| `sphere tenant` | Phase 4 (stub) | Exits with scheduled message |

## Install

```bash
npm install -g @unicity-sphere/cli
```

## Quickstart

```bash
sphere --help
sphere --version

# Legacy bridge example
sphere wallet init --network testnet

# DM-native host example
sphere host list --manager @myhostmanager
sphere host spawn --manager @myhostmanager --template tpl-1 mybot
```

## Development

```bash
npm ci
npm run build
npm test
npm run check             # lint + typecheck + unit tests
npm run test:integration  # end-to-end tests against real public testnet
```

### Integration tests

The `test/integration/` suite exercises the built CLI against real public
infrastructure:

- Nostr relay  — `wss://nostr-relay.testnet.unicity.network`
- Aggregator   — `https://goggregator-test.unicity.network`
- IPFS gateway — `https://unicity-ipfs1.dyndns.org`

Each test creates a throwaway wallet in `/tmp` so runs are fully isolated and
never touch real funds. Skip with `SKIP_INTEGRATION=1` when offline.

## Design principles

1. **DM-native.** All controller → manager and controller → tenant traffic goes
   over NIP-17 encrypted Nostr DMs. No HTTP bridge, no test-only fallback.
2. **Host-agnostic tenants.** `sphere tenant` addresses tenants by their own
   nametag or pubkey, not by `(host, instance_id)` coordinates. Tenants may
   migrate between hosts in the future without changing how you address them.
3. **Sync-by-default CLI semantics.** Every command waits for causally-implied
   effects (aggregator commit, Nostr relay ack, IPFS upload) before returning.
   `--skip-<subsystem>` flags and `--timeout <ms>` allow explicit opt-out.
4. **One binary, many namespaces.** `sphere host`, `sphere wallet`, `sphere
   swap`, `sphere tenant`, etc. share one config, one identity layer, one
   relay pool.

## License

MIT — see [`LICENSE`](./LICENSE).
