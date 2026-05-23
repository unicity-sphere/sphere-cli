/**
 * Shared Sphere provider construction for sphere-cli namespaces.
 *
 * Storage + tokenStorage come from `createNodeProfileProviders` (OrbitDB
 * + aggregator pointer + IPFS CAR — the non-deprecated path). Transport,
 * oracle, market, groupChat come from `createNodeProviders`. The
 * deprecated `IpfsStorageProvider` (IPNS-based mutable-pointer sync) is
 * NOT used here — Profile replication replaces it.
 *
 * Used by:
 *   - `src/legacy/legacy-cli.ts` `getSphere()` and the `clear` command
 *   - `src/host/sphere-init.ts`
 *   - `src/pointer/sphere-init.ts` (already aligned; see note below)
 *
 * The pointer namespace's bootstrap pre-dates this helper and uses a
 * dynamic import to support SDKs that pre-date the `profile/node`
 * export. The SDK version pinned in package.json now always ships
 * profile/node, so callers can import it statically — but the pointer
 * namespace keeps its dynamic-import shim for the moment so the diff
 * stays scoped to issue #23. A follow-up can consolidate.
 *
 * @see GitHub issue sphere-cli#23
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createNodeProfileProviders } from '@unicitylabs/sphere-sdk/profile/node';
import type { NetworkType } from '@unicitylabs/sphere-sdk';

/** Wallet storage layout, detected from the on-disk dataDir. */
export type WalletKind =
  | 'profile' // `${dataDir}/orbitdb/` present — already on the Profile path
  | 'legacy'  // `${dataDir}/wallet.json` present but no orbitdb/ — pre-migration
  | 'fresh';  // neither marker present — first-time init, will boot Profile

/**
 * Detect the storage layout of a wallet at `dataDir`.
 *
 * Read-only — never creates directories or files. Safe to call before
 * any provider construction. The result drives `getSphere()`'s decision
 * to either boot Profile straight away or short-circuit with the
 * "run `sphere wallet migrate`" prompt.
 *
 * Detection rules:
 *   - `profile`: `${dataDir}/orbitdb/` exists. Profile providers boot
 *     happily — the local FileStorage cache (`wallet.json`) lives
 *     alongside the OrbitDB subdir, but the OrbitDB subdir is the
 *     authoritative marker that Profile init has run at least once.
 *   - `legacy`:  `${dataDir}/wallet.json` exists AND no `orbitdb/`. The
 *     wallet was minted with the deprecated `IpfsStorageProvider`
 *     bootstrap. The migrate command moves its token state into
 *     OrbitDB-backed Profile storage.
 *   - `fresh`:   neither marker. First-time init — defaults to Profile.
 */
export function detectWalletKind(dataDir: string): WalletKind {
  if (!fs.existsSync(dataDir)) return 'fresh';
  if (fs.existsSync(path.join(dataDir, 'orbitdb'))) return 'profile';
  if (fs.existsSync(path.join(dataDir, 'wallet.json'))) return 'legacy';
  return 'fresh';
}

/** Configuration for `buildSphereProviders`. Mirrors the prior `createNodeProviders` call sites. */
export interface SphereProvidersConfig {
  readonly network: NetworkType;
  readonly dataDir: string;
  readonly tokensDir: string;
  /** Enable the market module. Default false. */
  readonly market?: boolean;
  /** Enable the group-chat module. Default false. */
  readonly groupChat?: boolean;
}

/**
 * Result of `buildSphereProviders`. Shape matches what `Sphere.init`
 * accepts as its provider spread, minus `ipfsTokenStorage` (gone) and
 * minus a few NodeProviders fields the CLI doesn't forward.
 *
 * The structural type comes from the SDK factories — keep this interface
 * loosely typed (via `ReturnType`) so an SDK refactor surfaces here as a
 * compile error at the merge site rather than a silent shape drift.
 */
export interface SphereProvidersBundle {
  readonly storage:      ReturnType<typeof createNodeProfileProviders>['storage'];
  readonly tokenStorage: ReturnType<typeof createNodeProfileProviders>['tokenStorage'];
  readonly transport:    ReturnType<typeof createNodeProviders>['transport'];
  readonly oracle:       ReturnType<typeof createNodeProviders>['oracle'];
  readonly l1?:          ReturnType<typeof createNodeProviders>['l1'];
  readonly price?:       ReturnType<typeof createNodeProviders>['price'];
  readonly market?:      ReturnType<typeof createNodeProviders>['market'];
  readonly groupChat?:   ReturnType<typeof createNodeProviders>['groupChat'];
}

/**
 * Build the merged provider bundle for sphere-cli.
 *
 * The Profile factory receives the legacy bundle's `oracle` so the
 * aggregator-pointer layer's `RootTrustBase` is the same instance the
 * rest of Sphere uses (SPEC §8.4.2 H6).
 *
 * `tokenSync.ipfs` is NOT passed to `createNodeProviders` — that's the
 * deprecated IPNS-based mutable-pointer path that this migration
 * removes. Profile + aggregator pointer + IPFS CAR is the replacement.
 */
export function buildSphereProviders(
  config: SphereProvidersConfig,
): SphereProvidersBundle {
  const legacy = createNodeProviders({
    network:   config.network,
    dataDir:   config.dataDir,
    tokensDir: config.tokensDir,
    market:    config.market ?? false,
    groupChat: config.groupChat ?? false,
    // tokenSync.ipfs deliberately omitted — Profile replaces it.
  });

  const profile = createNodeProfileProviders({
    network: config.network,
    dataDir: config.dataDir,
    oracle:  legacy.oracle,
  });

  return {
    storage:      profile.storage,
    tokenStorage: profile.tokenStorage,
    transport:    legacy.transport,
    oracle:       legacy.oracle,
    l1:           legacy.l1,
    price:        legacy.price,
    market:       legacy.market,
    groupChat:    legacy.groupChat,
  };
}
