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
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import type { NetworkType } from '@unicitylabs/sphere-sdk';

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
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<CliConfig>;
      return {
        network: raw.network ?? 'testnet',
        dataDir: raw.dataDir ?? DEFAULT_DATA_DIR,
        tokensDir: raw.tokensDir ?? DEFAULT_TOKENS_DIR,
        currentProfile: raw.currentProfile,
      };
    }
  } catch {
    // Fall through to defaults.
  }
  return { network: 'testnet', dataDir: DEFAULT_DATA_DIR, tokensDir: DEFAULT_TOKENS_DIR };
}

export async function initSphere(): Promise<Sphere> {
  const config = loadConfig();

  const providers = createNodeProviders({
    network: config.network,
    dataDir: config.dataDir,
    tokensDir: config.tokensDir,
  });

  const exists = await Sphere.exists(providers.storage);
  if (!exists) {
    throw new Error(
      `No wallet found in ${config.dataDir}. Run \`sphere wallet init\` before using \`sphere host\`.`,
    );
  }

  const { sphere } = await Sphere.init({
    storage: providers.storage,
    transport: providers.transport,
    oracle: providers.oracle,
    network: config.network,
    autoGenerate: false,
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
