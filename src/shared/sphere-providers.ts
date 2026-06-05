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
import {
  createNodeProviders,
  createUxfCarPublisher,
  DEFAULT_IPFS_GATEWAYS,
  type PublishToIpfsCallback,
} from '@unicitylabs/sphere-sdk/impl/nodejs';
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
 *   - `legacy`:  `${dataDir}/wallet.json` has *substantive* content
 *     (at least one key) AND no `orbitdb/`. The wallet was minted
 *     with the deprecated `IpfsStorageProvider` bootstrap. The
 *     migrate command moves its token state into OrbitDB-backed
 *     Profile storage.
 *   - `fresh`:   no orbitdb/ AND no wallet.json — OR a wallet.json
 *     that's an empty `{}` placeholder. The CLI's `sphere wallet use`
 *     flow constructs a `FileStorageProvider` whose `connect()` writes
 *     an empty `wallet.json` as a side-effect before any wallet data
 *     exists, so the placeholder must NOT trip the migration gate
 *     (regression caught by `manual-test-full-recovery.sh §1`). A
 *     wallet.json that fails to parse is treated as `legacy` — its
 *     content is unknown, route it through migrate triage rather than
 *     silently bootstrapping a Profile on top.
 */
export function detectWalletKind(dataDir: string): WalletKind {
  if (!fs.existsSync(dataDir)) return 'fresh';
  if (fs.existsSync(path.join(dataDir, 'orbitdb'))) return 'profile';
  const walletJsonPath = path.join(dataDir, 'wallet.json');
  if (!fs.existsSync(walletJsonPath)) return 'fresh';
  // Distinguish the empty `{}` placeholder (a connect()-time side-effect
  // of the legacy FileStorageProvider) from a real legacy wallet that
  // carries actual key/value entries.
  try {
    const raw = fs.readFileSync(walletJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed as Record<string, unknown>).length === 0
    ) {
      return 'fresh';
    }
    return 'legacy';
  } catch {
    // Unreadable / unparseable wallet.json — be conservative: route
    // through migrate triage instead of clobbering with a fresh
    // Profile boot. Operator can inspect or delete the file.
    return 'legacy';
  }
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
  /**
   * IPFS gateway URLs for outgoing UXF CID-delivery + incoming CID
   * fetch. Defaults to `DEFAULT_IPFS_GATEWAYS` (which honors the
   * `SPHERE_IPFS_GATEWAY` env override at module load time). Pass an
   * empty array to disable the publisher entirely — large bundles
   * will then throw `INLINE_CAR_TOO_LARGE` again.
   *
   * Sphere-sdk issue #394 — the CLI wires `publishToIpfs` +
   * `cidFetchGateways` so the auto-CID promotion path
   * (`AUTOMATED_CID_DELIVERY_ENABLED = true` post-#394, triggered at
   * `RELAY_SAFE_CAP_BYTES = 96 KiB`) has a working publisher behind
   * it. Without this wiring the SDK throws on multi-hop bundles
   * that exceed the relay event ceiling.
   */
  readonly ipfsGateways?: readonly string[];
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
  /**
   * Outgoing UXF CID-delivery callback (sphere-sdk issue #394). Wired
   * from `createUxfCarPublisher(ipfsGateways)`; passed through to
   * `Sphere.init` so the SDK's `delivery: { kind: 'auto' }` path can
   * promote bundles > `RELAY_SAFE_CAP_BYTES` (96 KiB) to CID-over-Nostr.
   */
  readonly publishToIpfs?: PublishToIpfsCallback;
  /**
   * IPFS gateway URLs for the recipient pipeline's stream-fetch of
   * incoming `uxf-cid` bundles. Without this, every `uxf-cid` event
   * is silently dropped on receive.
   */
  readonly cidFetchGateways?: readonly string[];
}

/**
 * Build the merged provider bundle for sphere-cli.
 *
 * The Profile factory receives the legacy bundle's `oracle` so the
 * aggregator-pointer layer's `RootTrustBase` is the same instance the
 * rest of Sphere uses (SPEC §8.4.2 H6).
 *
 * `tokenSync.ipfs` (the deprecated IPNS-based wallet-storage flag) is
 * NOT passed to `createNodeProviders` — Profile + aggregator pointer +
 * IPFS CAR replaced that wallet-storage path. The outgoing UXF
 * bundle publisher (`publishToIpfs`) is a SEPARATE concern that
 * survives the migration: bundles still need to be pinnable for the
 * CID-by-reference (`uxf-cid`) Nostr delivery path. Sphere-sdk
 * issue #394 closes the wiring here by importing the canonical
 * `createUxfCarPublisher` from `@unicitylabs/sphere-sdk/impl/nodejs`
 * directly, avoiding the deprecated `IpfsStorageProvider` tail that
 * `tokenSync.ipfs.enabled: true` would otherwise also activate.
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
    // tokenSync.ipfs deliberately omitted — Profile replaces the
    // deprecated IpfsStorageProvider wallet-storage path. The UXF
    // bundle publisher below is wired independently.
  });

  const profile = createNodeProfileProviders({
    network: config.network,
    dataDir: config.dataDir,
    oracle:  legacy.oracle,
  });

  // Sphere-sdk issue #394 — wire the UXF CID-delivery publisher and
  // the recipient's fetch-gateway list. The default gateway list
  // honors the `SPHERE_IPFS_GATEWAY` env override at module load.
  // Empty array disables — sends > 96 KiB will throw
  // `INLINE_CAR_TOO_LARGE` if the kill-switch is also off.
  const ipfsGateways: readonly string[] =
    config.ipfsGateways ?? [...DEFAULT_IPFS_GATEWAYS];
  const publishToIpfs: PublishToIpfsCallback | undefined =
    ipfsGateways.length > 0 ? createUxfCarPublisher(ipfsGateways) : undefined;

  return {
    storage:      profile.storage,
    tokenStorage: profile.tokenStorage,
    transport:    legacy.transport,
    oracle:       legacy.oracle,
    l1:           legacy.l1,
    price:        legacy.price,
    market:       legacy.market,
    groupChat:    legacy.groupChat,
    publishToIpfs,
    cidFetchGateways: ipfsGateways.length > 0 ? ipfsGateways : undefined,
  };
}
