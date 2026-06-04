/**
 * Sphere initialisation for the `sphere host` namespace.
 *
 * Loads `.sphere-cli/config.json` (matching legacy-cli defaults) and initialises
 * Sphere from the existing wallet — never auto-creates. Modules not needed by
 * HMCP (market, swap, accounting, groupChat) are left disabled to keep startup
 * fast and failures isolated to the DM transport.
 */

import * as fs from 'node:fs';
import { Sphere } from '@unicitylabs/sphere-sdk';
import type { NetworkType } from '@unicitylabs/sphere-sdk';
import {
  buildSphereProviders,
  detectWalletKind,
} from '../shared/sphere-providers.js';

// All paths are CWD-relative by design — matches legacy-cli behaviour so the
// same wallet is visible whether invoked via `sphere wallet …` (legacy) or
// `sphere host …` (this namespace). Callers that need a fixed wallet location
// should chdir before invocation or set `dataDir` in config.json to an absolute
// path.
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
    process.stderr.write(`sphere: failed to parse ${CONFIG_FILE}: ${String(e)}. Using defaults.\n`);
  }
  return { network: 'testnet', dataDir: DEFAULT_DATA_DIR, tokensDir: DEFAULT_TOKENS_DIR };
}

export async function initSphere(): Promise<Sphere> {
  const config = loadConfig();

  // Issue #23 — same gate as the legacy CLI bootstrap. Host commands
  // cannot operate against a pre-migration wallet because the new
  // Profile-backed token storage would start empty and silently miss
  // every token the user has on the legacy IPNS-pointer path. Surface
  // the migration step explicitly instead of silently mis-routing.
  const kind = detectWalletKind(config.dataDir);
  if (kind === 'legacy') {
    throw new Error(
      `Legacy wallet detected at ${config.dataDir} (file storage + IPNS sync).\n` +
        '`sphere host` requires the new Profile storage. Migrate via:\n' +
        '  sphere wallet migrate           # dry-run summary first\n' +
        '  sphere wallet migrate --apply   # commit the import\n' +
        'See GitHub sphere-cli#23 for context.',
    );
  }

  const providers = buildSphereProviders({
    network:   config.network,
    dataDir:   config.dataDir,
    tokensDir: config.tokensDir,
  });

  const exists = await Sphere.exists(providers.storage);
  if (!exists) {
    throw new Error(
      `No wallet found in ${config.dataDir}. Run \`sphere wallet init\` before using \`sphere host\`.`,
    );
  }

  const { sphere } = await Sphere.init({
    storage:      providers.storage,
    tokenStorage: providers.tokenStorage,
    transport:    providers.transport,
    oracle:       providers.oracle,
    network:      config.network,
    autoGenerate: false,
    // sphere-sdk #394 — pass through the UXF CID-delivery wiring so
    // sends of > RELAY_SAFE_CAP_BYTES bundles can promote to CID.
    ...(providers.publishToIpfs ? { publishToIpfs: providers.publishToIpfs } : {}),
    ...(providers.cidFetchGateways ? { cidFetchGateways: providers.cidFetchGateways } : {}),
  });

  return sphere;
}

export function resolveManagerAddress(opts: { manager?: string }): string {
  const address = opts.manager ?? process.env['SPHERE_HOST_MANAGER'];
  if (!address || address.trim() === '') {
    throw new Error(
      'No host manager address. Pass --manager <@nametag|DIRECT://hex|hex> or set SPHERE_HOST_MANAGER.',
    );
  }
  return address.trim();
}
