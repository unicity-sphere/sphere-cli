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
| `sphere trader` | **DM-native (live)** | ACP-0: create-intent, cancel-intent, list-intents, list-deals, portfolio, set-strategy, status. Mirrors canonical [`trader-ctl`](https://github.com/vrogojin/trader-service) |
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

# DM-native trader example (talks directly to a running trader tenant)
sphere trader status --tenant @trader-alice
sphere trader create-intent --tenant @trader-alice \
  --direction sell --base UCT --quote USDC \
  --rate-min 95 --rate-max 100 --volume-min 10 --volume-total 100
sphere trader list-deals --tenant @trader-alice --state active
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

## UX — canonical conventions (issue #32)

Every `sphere` command follows the same input/output rules so muscle memory
transfers across the surface.

### Asset input — `<amount> <coin>` (two positional tokens)

```bash
sphere payments send @bob 100.5 UCT
sphere invoice  create --target @alice --asset 1000000 UCT
sphere invoice  create --target @alice --asset 1000000 UCT --asset 500000 USDU
sphere invoice  return <id> --recipient @bob --asset 100000 UCT
sphere swap     propose --to @bob --offer 10 UCT --want 5 USDU
```

`--asset`, `--offer`, and `--want` each consume the **next two argv tokens**
(amount, then coin). No quoted compound form (`--asset "10 UCT"`) is accepted
— that legacy shape has been removed.

### Output — human-readable by default, `--json` for scripts

```bash
sphere invoice status <id>          # labelled block, easy to read
sphere invoice status <id> --json   # raw JSON (machine-parseable)
```

`--json` is a global flag that any command honours.

### Help — `--help` works for every command and subcommand

```bash
sphere --help                       # top-level usage summary
sphere help                         # same
sphere help send                    # detailed help for one command
sphere wallet --help                # namespace-level help
sphere wallet create --help         # sub-subcommand help
sphere invoice deliver --help
```

On invalid input (missing flag, bad value, unknown subcommand) the CLI prints
`Error: <message>` followed by the full help block for the closest command —
never a one-line `Usage:` stub.

## Shell completion

`sphere completions <bash|zsh|fish>` emits a completion script. Pick the
install path that matches your environment:

```bash
# Bash, no-sudo (recommended)
mkdir -p ~/.local/share/bash-completion/completions
sphere completions bash > ~/.local/share/bash-completion/completions/sphere

# Bash, system-wide (requires sudo)
sudo sh -c "sphere completions bash > /etc/bash_completion.d/sphere"

# Zsh
mkdir -p ~/.zsh/completions
sphere completions zsh > ~/.zsh/completions/_sphere
# Add to ~/.zshrc:
#   fpath=(~/.zsh/completions $fpath)
#   autoload -Uz compinit && compinit

# Fish
sphere completions fish > ~/.config/fish/completions/sphere.fish
```

Re-source your shell rc (`source ~/.bashrc`) or open a new terminal to pick
up the completions. The completion script is regenerated from the same
command table the CLI dispatcher uses; an internal test
(`legacy-cli-ux.test.ts`) keeps the two in lockstep.

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
