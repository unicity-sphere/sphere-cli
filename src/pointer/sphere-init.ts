/**
 * Sphere initialisation for the `sphere pointer` namespace.
 *
 * Loads `.sphere-cli/config.json` (matching legacy-cli defaults) and
 * brings up a Sphere instance backed by Profile providers (OrbitDB +
 * IPFS + aggregator pointer layer) so the pointer namespace can call
 * `getPointerLayer().publish(...)` / `recoverLatest()`.
 *
 * Mirrors `host/sphere-init.ts` but wires `createNodeProfileProviders`
 * INSTEAD of the legacy file-based `createNodeProviders`. Pointer
 * commands without Profile-mode wallets are nonsensical: the pointer
 * layer LIVES inside the Profile storage provider.
 */

import * as fs from 'node:fs';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import type { NetworkType } from '@unicitylabs/sphere-sdk';
import { join } from 'node:path';

/**
 * Dynamic-import handle for `@unicitylabs/sphere-sdk/profile/node`.
 *
 * The Profile module ships in sphere-sdk releases that include the
 * pointer-layer work. To let THIS CLI merge against older SDK
 * versions that predate that release, we resolve the module at
 * runtime via dynamic import — typecheck doesn't need to bind to the
 * missing subpath, and pointer commands fail gracefully with a
 * precise diagnostic when the SDK lacks profile support.
 *
 * Cached as a one-shot promise so the resolution cost is paid once
 * per process. Returns null on a clean ERR_PACKAGE_PATH_NOT_EXPORTED
 * (SDK missing the export); rethrows for other errors so unexpected
 * build issues surface.
 */
type CreateNodeProfileProvidersFn = (
  config: Record<string, unknown>,
) => { storage: unknown; tokenStorage: unknown };

let profileNodeModule:
  | { createNodeProfileProviders: CreateNodeProfileProvidersFn }
  | null
  | undefined;

async function loadProfileNode(): Promise<
  { createNodeProfileProviders: CreateNodeProfileProvidersFn } | null
> {
  if (profileNodeModule !== undefined) return profileNodeModule;
  try {
    // The "as string" cast prevents the TS resolver from binding to
    // the import at compile time. Runtime takes the literal string
    // through Node's normal package-exports gate.
    const mod = (await import(
      '@unicitylabs/sphere-sdk/profile/node' as string
    )) as { createNodeProfileProviders: CreateNodeProfileProvidersFn };
    profileNodeModule = mod;
    return mod;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'ERR_MODULE_NOT_FOUND') {
      profileNodeModule = null;
      return null;
    }
    throw err;
  }
}

const CONFIG_FILE = './.sphere-cli/config.json';
const DEFAULT_DATA_DIR = './.sphere-cli';
const DEFAULT_TOKENS_DIR = './.sphere-cli/tokens';

interface CliConfig {
  network: NetworkType;
  dataDir: string;
  tokensDir: string;
  currentProfile?: string;
}

function loadConfig(): CliConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
      return {
        network:        typeof raw['network']        === 'string' ? raw['network'] as NetworkType : 'testnet',
        dataDir:        typeof raw['dataDir']        === 'string' ? raw['dataDir']                : DEFAULT_DATA_DIR,
        tokensDir:      typeof raw['tokensDir']      === 'string' ? raw['tokensDir']              : DEFAULT_TOKENS_DIR,
        currentProfile: typeof raw['currentProfile'] === 'string' ? raw['currentProfile']         : undefined,
      };
    }
  } catch (e) {
    process.stderr.write(`sphere pointer: failed to parse ${CONFIG_FILE}: ${String(e)}. Using defaults.\n`);
  }
  return { network: 'testnet', dataDir: DEFAULT_DATA_DIR, tokensDir: DEFAULT_TOKENS_DIR };
}

/**
 * Sentinel error thrown when the installed `@unicitylabs/sphere-sdk`
 * predates the Profile-module release. Caller catches and exits with
 * a precise diagnostic (`SDK is too old to support pointer commands`).
 */
export class ProfileSdkMissingError extends Error {
  constructor() {
    super(
      'pointer: installed @unicitylabs/sphere-sdk does not export profile/node. ' +
        'Upgrade to a version that ships the Profile/aggregator-pointer module ' +
        '(see CHANGELOG for the release that adds it).',
    );
    this.name = 'ProfileSdkMissingError';
  }
}

/**
 * Initialise a Sphere wallet with Profile providers.
 *
 * `pointer flush` and `pointer recover` need the OrbitDB-backed Profile
 * storage AND a pointer-layer-aware oracle. We reuse the legacy factory
 * to obtain transport + oracle (so we get the same network-default
 * relays, aggregator URL, and trust base) and override storage +
 * tokenStorage with the Profile providers from `createNodeProfileProviders`.
 *
 * Throws `ProfileSdkMissingError` if the installed SDK predates the
 * Profile-module release. Throws a regular Error if the wallet doesn't
 * exist at the configured dataDir.
 */
export async function initSphereWithProfile(): Promise<Sphere> {
  const config = loadConfig();

  const profileMod = await loadProfileNode();
  if (!profileMod) {
    throw new ProfileSdkMissingError();
  }

  // Legacy providers — for transport (Nostr relays) + oracle
  // (aggregator client + trust base). The Profile factory needs the
  // oracle wired in so its pointer layer can talk to the aggregator.
  const legacy = createNodeProviders({
    network: config.network,
    dataDir: config.dataDir,
    tokensDir: config.tokensDir,
  });

  const profileBundle = profileMod.createNodeProfileProviders({
    network: config.network,
    dataDir: config.dataDir,
    oracle: legacy.oracle,
    profileConfig: {
      orbitDb: {
        privateKey: '', // derived from identity at setIdentity() time
        directory: join(config.dataDir, 'orbitdb'),
      },
      encrypt: true,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exists = await Sphere.exists(profileBundle.storage as any);
  if (!exists) {
    throw new Error(
      `No wallet found in ${config.dataDir}. Run \`sphere init --profile --network ${config.network}\` first.`,
    );
  }

  const { sphere } = await Sphere.init({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storage: profileBundle.storage as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tokenStorage: profileBundle.tokenStorage as any,
    transport: legacy.transport,
    oracle: legacy.oracle,
    network: config.network,
    autoGenerate: false,
  });

  return sphere;
}

/**
 * Extract the pointer layer from a Sphere instance.
 *
 * `getPointerLayer()` lives on `ProfileStorageProvider` (NOT on `Sphere`
 * directly), so we duck-type our way through the public storage handle.
 * Returns null when:
 *   - the wallet uses the legacy file-based StorageProvider (no
 *     `getPointerLayer` method); or
 *   - the Profile provider's pointer build was skipped (no oracle, sticky
 *     skip reason — see `getPointerSkipReason()` for the diagnostic).
 *
 * The pointer namespace's command bodies handle null with a clear
 * "pointer layer not wired" exit code; callers don't need to peek at
 * the skip reason themselves.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPointerLayer(sphere: Sphere): any | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storage = (sphere as any)._storage as { getPointerLayer?: () => unknown } | undefined;
  if (!storage || typeof storage.getPointerLayer !== 'function') return null;
  const layer = storage.getPointerLayer();
  return layer ?? null;
}
