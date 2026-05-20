/**
 * Integration test: `sphere swap ...` — live escrow lifecycle.
 *
 * End-to-end pin for the swap CLI surface against a real escrow. Spins up:
 *   - Local Nostr relay (Docker)         — see ./local-infra/docker-compose.yml
 *   - Agentic-hosting escrow container   — see ./local-infra/escrow.ts
 *
 * …then provisions two sphere-cli wallets (alice = proposer, bob = acceptor)
 * via the public testnet faucet, registers fresh nametags, and exercises the
 * swap roundtrip end-to-end through the CLI binary.
 *
 * Gates:
 *   - `SKIP_INTEGRATION=1`  — skip all integration tests (CI fast tier).
 *   - `E2E_RUN_SWAP=1`      — opt in to this suite. Default skipped because:
 *       * needs Docker + escrow image (`ghcr.io/vrogojin/agentic-hosting/escrow:v0.1`)
 *       * faucet round-trips consume testnet tokens
 *       * full setup takes 3-6 minutes
 *
 * The "happy-path completion" tier (full deposit → completed roundtrip with
 * both parties depositing through the escrow) is split into a separate
 * `describe.skipIf(!FULL_SETTLEMENT)` block, opt-in via `E2E_RUN_SWAP_FULL=1`.
 * The default `E2E_RUN_SWAP=1` tier covers the offline-impossible CLI paths
 * (swap-ping reaches a real escrow, swap-propose mints a real proposal,
 * swap-cancel terminates a proposal before deposits) — enough to catch
 * regressions in the namespace-bridge → SwapModule → Nostr-DM glue without
 * paying the full deposit-settlement cost on every CI run.
 *
 * Source pattern: mirrors /home/vrogojin/trader-service/test/e2e-live/ but
 * collapsed to a single test file (no host-manager, no trader-ctl driver).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  runSphereAsync,
  integrationSkip,
  PUBLIC_TESTNET,
  type SphereEnv,
} from './helpers.js';
import { bootEscrow, type EscrowHandle } from './local-infra/escrow.js';

const RUN_SWAP_E2E = process.env['E2E_RUN_SWAP'] === '1';
const RUN_SWAP_FULL = process.env['E2E_RUN_SWAP_FULL'] === '1';

/**
 * Why we DON'T use a local Nostr relay here, despite the local-infra/
 * helpers shipping with this PR:
 *
 *   1. The faucet (`https://faucet.unicity.network/api/v1/faucet/request`)
 *      gift-wraps tokens via the public testnet relay only.
 *   2. Adding a local relay to the wallet's SPHERE_NOSTR_RELAYS list
 *      (alongside testnet) caused the faucet gift-wrap NOT to land in
 *      the wallet's inbox — observed across multiple boot-test runs.
 *      The root cause is somewhere in the relay-set's inbox subscription
 *      replay; isolating it is its own debugging exercise.
 *   3. The simpler architecture — everyone (escrow + wallets + faucet)
 *      shares the public testnet relay — gives a clean 5-minute test
 *      without the local-infra knot, at the cost of putting our swap
 *      DMs on the same relay as the broader testnet.
 *
 * The local-infra/relay.ts helper is still committed alongside this file
 * because group-* and market-* tests (NIP-29 chat / NIP-23 long-form)
 * will need a Docker-controlled relay. Keeping it ready avoids re-porting
 * it. For swap, the public testnet relay is the simplest path that
 * actually works end-to-end against the latest sphere-sdk + escrow image.
 */

/**
 * Provision one wallet end-to-end:
 *   1. createSphereEnv with SPHERE_NOSTR_RELAYS pointed at local + testnet
 *   2. `wallet init` (autogenerates mnemonic on first run)
 *   3. `nametag register it_<hex>` so the faucet has someone to gift-wrap to
 *   4. `faucet <amount> <coin>` for the wallet's offering side
 *   5. Poll `payments tokens` until the coin lands (faucet is async)
 *
 * Returns the env + the resolved directAddress + the registered nametag.
 */
interface ProvisionedWallet {
  env: SphereEnv;
  directAddress: string;
  nametag: string;
}

async function provisionWallet(opts: {
  label: string;
  faucetCoin: 'UCT' | 'USDU';
  faucetAmount: number;
}): Promise<ProvisionedWallet> {
  // NO SPHERE_NOSTR_RELAYS override — wallet uses the network's default
  // testnet relay set. The faucet sends gift-wraps to that same relay
  // so the wallet's inbox subscription picks them up. The escrow also
  // connects to the same testnet relay (set via UNICITY_RELAYS in
  // bootEscrow) so swap DMs flow over the shared relay.
  const env = createSphereEnv(opts.label);

  // Wallet init. Sphere init does aggregator + nametag-binding publish;
  // give it generous timeout.
  const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 180_000 });
  if (init.status !== 0) {
    throw new Error(
      `[${opts.label}] wallet init failed (status=${init.status}). ` +
      `stderr: ${init.stderr.slice(0, 800)}`,
    );
  }
  const addrMatch = init.stdout.match(/"directAddress":\s*"(DIRECT:\/\/[0-9a-fA-F]+)"/);
  if (!addrMatch) {
    throw new Error(`[${opts.label}] directAddress not found in init output`);
  }
  const directAddress = addrMatch[1]!;

  // Fresh nametag — `it_` prefix + 4-byte hex avoids collisions across
  // concurrent CI runs. Mints an on-chain nametag token.
  const nametag = `it_${randomBytes(4).toString('hex')}`;
  const reg = runSphere(env, ['nametag', 'register', nametag], { timeoutMs: 180_000 });
  if (reg.status !== 0) {
    throw new Error(
      `[${opts.label}] nametag register failed:\n${reg.stderr.slice(0, 800)}`,
    );
  }

  // Faucet request — uses the symbol-mapped faucet name. UCT → unicity,
  // USDU → unicity-usd (per legacy-cli.ts FAUCET_COIN_MAP).
  //
  // IMPORTANT: the faucet handler exits 0 even on API failure (see
  // legacy-cli.ts ~3005-3007: "✗ Failed: <message>" then falls through).
  // We MUST inspect stdout for the "✓ Received" marker — a 0 exit alone
  // does NOT mean the gift-wrap was queued.
  const fc = runSphere(env, ['faucet', String(opts.faucetAmount), opts.faucetCoin], {
    timeoutMs: 60_000,
  });
  if (fc.status !== 0) {
    throw new Error(`[${opts.label}] faucet request failed:\n${fc.stderr.slice(0, 800)}`);
  }
  if (!/Received\s+\d+\s+\S+/i.test(fc.stdout)) {
    // "Failed" branch from the handler — surface for debugging.
    throw new Error(
      `[${opts.label}] faucet did not confirm "Received": stdout=${fc.stdout.slice(-400)}`,
    );
  }

  // Poll `payments tokens` until the coin shows up. Faucet delivery is
  // async (gift-wrap arrives via Nostr) and can take 30-60s in practice.
  // We deliberately allow this to be slow — under concurrent provisioning,
  // testnet relay queues can spike to 90s+ before delivery.
  const TOKEN_POLL_TIMEOUT_MS = 240_000;
  const TOKEN_POLL_INTERVAL_MS = 5_000;
  const deadline = Date.now() + TOKEN_POLL_TIMEOUT_MS;
  let lastTokensSnippet = '';
  while (Date.now() < deadline) {
    const tokens = runSphere(env, ['payments', 'tokens'], { timeoutMs: 60_000 });
    if (tokens.status === 0 && tokens.stdout.includes(opts.faucetCoin)) {
      break;
    }
    lastTokensSnippet = tokens.stdout.slice(-300);
    await new Promise((r) => setTimeout(r, TOKEN_POLL_INTERVAL_MS));
  }
  if (Date.now() >= deadline) {
    throw new Error(
      `[${opts.label}] faucet ${opts.faucetAmount} ${opts.faucetCoin} did not land within ` +
      `${TOKEN_POLL_TIMEOUT_MS}ms. Last 'payments tokens' tail: ${lastTokensSnippet}`,
    );
  }

  return { env, directAddress, nametag };
}

describe.skipIf(integrationSkip || !RUN_SWAP_E2E)(
  'sphere-cli integration — swap e2e (Docker escrow + local relay + faucet)',
  () => {
    let escrow: EscrowHandle | null = null;
    let alice: ProvisionedWallet | null = null;
    let bob: ProvisionedWallet | null = null;

    beforeAll(async () => {
      // 1. Boot the escrow against the public testnet relay. The escrow
      //    will publish its own nametag-binding event on this relay so
      //    alice/bob can resolve its direct address via the same relay.
      escrow = await bootEscrow({
        relayUrl: PUBLIC_TESTNET.nostrRelay,
        network: 'testnet',
        readyTimeoutMs: 180_000,
      });

      // 3. Provision wallets SEQUENTIALLY. Parallel provisioning trips
      // the testnet faucet's per-IP rate limit (observed: bob's USDU
      // gift-wrap never arrives when both alice + bob hit the faucet
      // back-to-back). The HTTP request returns 200 either way — the
      // failure is downstream, in the gift-wrap delivery queue — which
      // is why the test must explicitly serialize this phase.
      //
      // Cost: ~2-3 extra minutes vs parallel. Net runtime ~5-7min.
      // Each path does: init → register nametag → faucet → poll for
      // token arrival.
      alice = await provisionWallet({ label: 'swap-alice', faucetCoin: 'UCT',  faucetAmount: 2 });
      bob   = await provisionWallet({ label: 'swap-bob',   faucetCoin: 'USDU', faucetAmount: 2 });
    }, 600_000);

    afterAll(async () => {
      // Tear down in reverse order. Each step is best-effort — a single
      // failure shouldn't block the others.
      if (alice) { try { destroySphereEnv(alice.env); } catch { /* best effort */ } }
      if (bob)   { try { destroySphereEnv(bob.env);   } catch { /* best effort */ } }
      if (escrow) { try { await escrow.stop(); } catch { /* best effort */ } }
    }, 120_000);

    it('alice can `swap ping` the escrow and receive a pong', () => {
      // swap-ping pins the most basic escrow protocol: alice's wallet
      // sends a `swap.ping` DM, escrow replies with `swap.pong`. If the
      // wallet can't reach the escrow at all (relay misconfig, NIP-17
      // gift-wrap unwrap failure, escrow not subscribed), this is the
      // earliest signal in the swap lifecycle that something's wrong.
      const r = runSphere(alice!.env, ['swap', 'ping', escrow!.address], { timeoutMs: 60_000 });
      if (r.status !== 0) {
        console.error('swap ping failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Escrow is online/i);
    }, 90_000);

    it('alice proposes a UCT-for-USDU swap, bob sees it, alice cancels it', async () => {
      // Phase 1: alice proposes 1 UCT for 1 USDU, addressed to bob's
      // nametag, escrowed by the running container.
      const propose = runSphere(
        alice!.env,
        [
          'swap', 'propose',
          '--to', `@${bob!.nametag}`,
          '--offer', '1 UCT',
          '--want', '1 USDU',
          '--escrow', escrow!.address,
          '--message', 'integration test',
        ],
        { timeoutMs: 90_000 },
      );
      if (propose.status !== 0) {
        console.error('swap propose failed', { stdout: propose.stdout, stderr: propose.stderr });
      }
      expect(propose.status).toBe(0);
      // Output shape from legacy-cli.ts swap-propose block:
      //   "Swap proposed:" then JSON.stringify({ swap_id, counterparty, ... })
      expect(propose.stdout).toMatch(/Swap proposed/i);
      const idMatch = propose.stdout.match(/"swap_id":\s*"([0-9a-fA-F]{64})"/);
      expect(idMatch, `swap_id not found in:\n${propose.stdout}`).toBeTruthy();
      const swapId = idMatch![1]!;

      // Phase 2: bob's wallet should observe the proposal. swap-list runs
      // ensureSync('nostr') first, which catches up on any pending swap
      // proposals delivered via NIP-17 gift-wrap. Allow up to 60s — the
      // proposal DM is async.
      let bobSawSwap = false;
      const listDeadline = Date.now() + 60_000;
      while (Date.now() < listDeadline) {
        const list = runSphere(bob!.env, ['swap', 'list'], { timeoutMs: 60_000 });
        if (list.status === 0 && list.stdout.includes(swapId.slice(0, 8))) {
          bobSawSwap = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
      expect(bobSawSwap, `bob did not observe swap ${swapId.slice(0, 8)} within 60s`).toBe(true);

      // Phase 3: alice cancels the swap (before bob accepts). swap-cancel
      // is the "rescue hatch" for a mis-addressed or stale proposal —
      // legacy-cli.ts ~4828.
      const cancel = runSphere(alice!.env, ['swap', 'cancel', swapId], { timeoutMs: 60_000 });
      if (cancel.status !== 0) {
        console.error('swap cancel failed', { stdout: cancel.stdout, stderr: cancel.stderr });
      }
      expect(cancel.status).toBe(0);
      expect(cancel.stdout).toMatch(/cancelled/i);

      // Phase 4: confirm the swap is gone from the default (open) list.
      // `swap-list` without `--all` filters out terminal states; a
      // successfully cancelled swap MUST disappear from this view. This
      // pin survives both possible SDK implementations:
      //   (a) cancellation removes the swap entirely from local storage
      //   (b) cancellation keeps the record but flips progress→cancelled
      // — in either case, the open-list filter excludes it.
      //
      // We don't separately re-query `swap-status` for the cancelled
      // swap because the legacy CLI's status handler throws on a
      // missing record (case (a) above), which makes the assertion
      // path SDK-implementation-dependent. The open-list disappearance
      // is the cleanest cross-implementation signal.
      const finalList = runSphere(alice!.env, ['swap', 'list'], { timeoutMs: 60_000 });
      expect(finalList.status).toBe(0);
      // The swap_id-prefix should NOT be in the default (open) list.
      // It WAS there before cancel (proven by Phase 2's polling loop on
      // the same swap).
      expect(
        finalList.stdout.includes(swapId.slice(0, 8)),
        `cancelled swap ${swapId.slice(0, 8)} still appears in default open list`,
      ).toBe(false);
    }, 240_000);

    // ── Full deposit-settlement tier (opt-in) ──────────────────────────
    // Restructured #163 item 1 (was: known-fragile, "stalls at depositing").
    //
    // Previous shape failed because bob's `swap accept --deposit --no-wait`
    // returned after submitting the deposit but BEFORE the on-chain
    // transfer to the escrow's deposit invoice completed. By the time
    // alice's separate `swap deposit` ran and we started polling status,
    // bob's deposit was often still in-flight; the escrow can only
    // conclude after seeing BOTH deposits, so settlement stalled at
    // `depositing` on alice's view, exhausting the 300s budget.
    //
    // New shape:
    //   1. bob accepts WITHOUT --deposit (announces the swap; cheap).
    //   2. Both deposits run IN PARALLEL via runSphereAsync — each
    //      `swap deposit` BLOCKS until the on-chain transfer is
    //      confirmed, so when Promise.all resolves we know both
    //      deposits have actually landed.
    //   3. We then poll alice's status for `completed`; the escrow's
    //      payout construction + per-party verification typically
    //      finishes in 30-120s once both deposits are visible.
    //
    // Budget bumped 300s → 600s as a defensive safety net for slow
    // testnet days. Outer test timeout 900s.
    //
    // Gated behind `E2E_RUN_SWAP_FULL=1` so the default e2e tier (ping
    // + propose/list/cancel) stays green and quick.
    describe.skipIf(!RUN_SWAP_FULL)(
      'full deposit settlement (E2E_RUN_SWAP_FULL=1)',
      () => {
        it('alice proposes, bob accepts, both deposit in parallel, swap reaches completed', async () => {
          // Use fresh amounts so this scenario is independent of the
          // cancelled one above (re-uses faucet-funded balances).
          const propose = runSphere(
            alice!.env,
            [
              'swap', 'propose',
              '--to', `@${bob!.nametag}`,
              '--offer', '1 UCT',
              '--want', '1 USDU',
              '--escrow', escrow!.address,
            ],
            { timeoutMs: 90_000 },
          );
          expect(propose.status).toBe(0);
          const idMatch = propose.stdout.match(/"swap_id":\s*"([0-9a-fA-F]{64})"/);
          expect(idMatch).toBeTruthy();
          const swapId = idMatch![1]!;

          // Step 1: bob accepts (announces the swap). NO --deposit here —
          // we'll drive both parties' deposits explicitly in parallel below.
          const accept = runSphere(bob!.env, ['swap', 'accept', swapId], {
            timeoutMs: 120_000,
          });
          if (accept.status !== 0) {
            console.error('bob accept failed', { stdout: accept.stdout, stderr: accept.stderr });
          }
          expect(accept.status).toBe(0);

          // Step 2: parallel deposits. Each `swap deposit` blocks until
          // the on-chain transfer is confirmed (the SDK waits for
          // inclusion proof + escrow ack). When Promise.all resolves
          // both deposits are observable to the escrow — eliminating
          // the original race where one was still in-flight at poll
          // start.
          const [aliceDep, bobDep] = await Promise.all([
            runSphereAsync(alice!.env, ['swap', 'deposit', swapId], { timeoutMs: 300_000 }),
            runSphereAsync(bob!.env, ['swap', 'deposit', swapId], { timeoutMs: 300_000 }),
          ]);
          if (aliceDep.status !== 0) {
            console.error('alice deposit failed', { stdout: aliceDep.stdout, stderr: aliceDep.stderr });
          }
          if (bobDep.status !== 0) {
            console.error('bob deposit failed', { stdout: bobDep.stdout, stderr: bobDep.stderr });
          }
          expect(aliceDep.status).toBe(0);
          expect(bobDep.status).toBe(0);

          // Step 3: poll alice's status for `completed`. Settlement
          // pipeline (post both deposits):
          //   - escrow detects both deposits     → swap:deposits_covered
          //   - escrow constructs payouts        → swap:payout_received
          //   - both parties verify their payout → swap:completed
          // Typically 30-120s. Budget 600s = 10x slack for slow testnet.
          let completed = false;
          const settleDeadline = Date.now() + 600_000;
          let lastSeenProgress: string | null = null;
          while (Date.now() < settleDeadline) {
            const status = runSphere(alice!.env, ['swap', 'status', swapId], { timeoutMs: 60_000 });
            if (status.status === 0) {
              const m = status.stdout.match(/"progress":\s*"([a-z_]+)"/i);
              lastSeenProgress = m?.[1] ?? lastSeenProgress;
              if (m?.[1] === 'completed') { completed = true; break; }
              if (m?.[1] === 'failed' || m?.[1] === 'cancelled') {
                throw new Error(`swap reached terminal failure state: ${m[1]}`);
              }
            }
            await new Promise((r) => setTimeout(r, 5_000));
          }
          expect(
            completed,
            `swap ${swapId.slice(0, 8)} did not complete within 600s (last seen progress: ${lastSeenProgress})`,
          ).toBe(true);
        }, 900_000);
      },
    );
  },
);
