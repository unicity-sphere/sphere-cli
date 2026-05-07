/**
 * `sphere pointer` Commander subcommand tree.
 *
 * Surfaces the aggregator-pointer layer's status, publish, and recover
 * paths to the CLI so e2e tests (sphere-sdk's pointer-N* shell scripts)
 * and operators can drive the layer end-to-end.
 *
 * Three commands:
 *
 *   sphere pointer status    — print Reachable / Blocked / Probe FP
 *   sphere pointer flush     — force a save + pointer publish round-trip
 *   sphere pointer recover   — print "Recovered v=N cid=…" or "No pointer
 *                              anchor published yet"
 *
 * All three operate on a Profile-mode wallet (OrbitDB + IPFS storage
 * + aggregator pointer layer). Legacy file-mode wallets have no pointer
 * layer; the commands exit non-zero with a diagnostic in that case.
 *
 * Exit codes:
 *   0   — operation succeeded (recover-with-no-anchor is a SUCCESS, not
 *         a failure — fresh wallets legitimately have no anchor; tests
 *         distinguish via output text).
 *   1   — operation failed (publish error, RPC failure, etc.)
 *   2   — wallet state invalid (no Profile storage, pointer layer not
 *         wired, etc.)
 */

import { Command } from 'commander';
import {
  initSphereWithProfile,
  getPointerLayer,
  ProfileSdkMissingError,
} from './sphere-init.js';

/**
 * Wrap a pointer-command body so a missing Profile module from the
 * installed SDK turns into a precise exit-2 with diagnostic, instead
 * of a generic uncaught exception. Other errors propagate so
 * Commander's normal error path runs.
 */
async function withProfileSdk(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProfileSdkMissingError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

// =============================================================================
// status
// =============================================================================
//
// Prints THREE invariant lines that the pointer-N* tests grep for:
//
//   Reachable: <yes|no>
//   Blocked:   <yes|no>
//   Probe FP:  <hex|empty>
//
// Where:
//   - Reachable: did at least one recent aggregator probe round-trip
//                successfully? (read from the layer's lastProbeVersions
//                cache; if empty, fall through to a fresh discoverLatest
//                call so a freshly-loaded wallet still gets a verdict).
//   - Blocked:   is the layer in a sticky-error state (UNREACHABLE_RECOVERY_
//                BLOCKED, REJECTED, MARKER_CORRUPT, …)? Surfaced via the
//                ProfileStorageProvider's `getPointerSkipReason()`.
//   - Probe FP:  short fingerprint of the most recent probe response. Used
//                by tests to assert "the layer is alive AND its responses
//                are stable across runs". Computed as the first 16 hex of
//                sha256(JSON.stringify(lastProbeVersions)) when available;
//                empty string when the layer has never probed.
async function pointerStatus(): Promise<void> {
  const sphere = await initSphereWithProfile();
  try {
    const layer = getPointerLayer(sphere);
    if (!layer) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const storage = (sphere as any)._storage as
        | { getPointerSkipReason?: () => string | null }
        | undefined;
      const skipReason = storage?.getPointerSkipReason?.() ?? null;
      process.stderr.write(
        `pointer status: pointer layer not wired (skip reason: ${skipReason ?? 'unknown'}).\n` +
          `Profile-mode wallet is required; legacy file-mode wallets have no pointer layer.\n`,
      );
      process.stderr.write(`Reachable: no\nBlocked:   yes\nProbe FP:  \n`);
      process.exitCode = 2;
      return;
    }

    // Trigger a fresh discover to get a verdict on reachability. This
    // doesn't publish; it only walks the aggregator commit chain to
    // find the latest VALID version. Errors are caught and folded into
    // "Reachable: no".
    let reachable = false;
    let blocked = false;
    let probeFp = '';
    let validV = 0;
    try {
      const discovery = await layer.discoverLatestVersion();
      validV = discovery.validV ?? 0;
      reachable = true;
      // Layer-internal cache from the last probe (if any) — fingerprint
      // it for the test assertion. The layer exposes this via
      // `_lastProbeVersions` (private) or via `getProbeHistory()` if
      // exposed; fall back to the validV scalar when neither is available.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const probeHistory = (layer as any).getProbeHistory?.() ?? null;
      const fingerprintInput = probeHistory
        ? JSON.stringify(probeHistory)
        : String(validV);
      const { createHash } = await import('node:crypto');
      probeFp = createHash('sha256').update(fingerprintInput).digest('hex').slice(0, 16);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reachable = false;
      // Sticky errors → blocked = yes.
      blocked = /UNREACHABLE_RECOVERY_BLOCKED|REJECTED|TRUST_BASE_STALE|MARKER_CORRUPT|CORRUPT_STREAK|UNTRUSTED_PROOF|SECURITY_ORIGIN_MISMATCH/.test(msg);
      process.stderr.write(`pointer status: probe error: ${msg}\n`);
    }

    process.stdout.write(`Reachable: ${reachable ? 'yes' : 'no'}\n`);
    process.stdout.write(`Blocked:   ${blocked ? 'yes' : 'no'}\n`);
    process.stdout.write(`Probe FP:  ${probeFp}\n`);
    process.stdout.write(`Latest valid v: ${validV}\n`);
  } finally {
    await sphere.destroy();
  }
}

// =============================================================================
// flush
// =============================================================================
//
// Forces a save + pointer publish round-trip. We don't have a direct
// "publish only" hook on the SDK, but `payments.sync()` triggers the
// flush scheduler which:
//   1. Pins the latest CAR to IPFS.
//   2. Writes the bundle ref to OrbitDB.
//   3. Calls `publishAggregatorPointerBestEffort(cid)` — the actual
//      pointer publish.
//
// On success: prints `Pointer flush succeeded (v=N cid=…)` and exits 0.
// On failure: prints the error message and exits 1.
async function pointerFlush(): Promise<void> {
  const sphere = await initSphereWithProfile();
  try {
    const layer = getPointerLayer(sphere);
    if (!layer) {
      process.stderr.write(
        `pointer flush: pointer layer not wired (Profile-mode wallet required).\n`,
      );
      process.exitCode = 2;
      return;
    }

    // `payments.sync()` in Profile mode runs the full save → pin →
    // bundle-ref → pointer publish chain. Returns when the chain
    // settles (success or transient failure caught by best-effort
    // publish).
    try {
      const syncResult = await sphere.payments.sync();
      // The pointer publish is the last hop. Read the layer's most
      // recent version after the sync to surface a useful confirmation.
      let postVersion = 0;
      try {
        const after = await layer.discoverLatestVersion();
        postVersion = after.validV ?? 0;
      } catch {
        // discover failed but flush itself didn't error — likely a
        // transient probe issue. Surface the sync result anyway.
      }
      process.stdout.write(
        `Pointer flush succeeded (added=${syncResult.added}, removed=${syncResult.removed}, v=${postVersion})\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Pointer flush failed: ${msg}\n`);
      process.exitCode = 1;
    }
  } finally {
    await sphere.destroy();
  }
}

// =============================================================================
// recover
// =============================================================================
//
// Calls `recoverLatest()` and prints either:
//   "Recovered v=N cid=<bafkrei…>"   (success — pointer-N tests grep this)
//   "No pointer anchor published yet"  (fresh wallet — also a SUCCESS)
//
// On RPC errors, exits 1 with a clear stderr message.
async function pointerRecover(): Promise<void> {
  const sphere = await initSphereWithProfile();
  try {
    const layer = getPointerLayer(sphere);
    if (!layer) {
      process.stderr.write(
        `pointer recover: pointer layer not wired (Profile-mode wallet required).\n`,
      );
      process.exitCode = 2;
      return;
    }

    try {
      const recovered = await layer.recoverLatest();
      if (!recovered) {
        process.stdout.write(`No pointer anchor published yet\n`);
        return;
      }
      // recovered.cid is Uint8Array — re-encode to a CID string for the
      // operator-facing line. The CID library is exposed by the SDK as
      // a transitive dep; import lazily to avoid pulling it into the
      // host/trader hot start path.
      const { CID } = await import('multiformats/cid');
      const cidString = CID.decode(recovered.cid).toString();
      process.stdout.write(`Recovered v=${recovered.version} cid=${cidString}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pointer recover: ${msg}\n`);
      process.exitCode = 1;
    }
  } finally {
    await sphere.destroy();
  }
}

// =============================================================================
// Public entry — Commander tree
// =============================================================================

export function createPointerCommand(): Command {
  const pointer = new Command('pointer')
    .description('aggregator pointer-layer commands (Profile-mode wallets only)');

  pointer
    .command('status')
    .description('print pointer-layer Reachable / Blocked / Probe FP status')
    .action(async () => {
      await withProfileSdk(pointerStatus);
    });

  pointer
    .command('flush')
    .description('force a save + pointer publish round-trip')
    .action(async () => {
      await withProfileSdk(pointerFlush);
    });

  pointer
    .command('recover')
    .description('print the latest published pointer anchor (or "no anchor")')
    .action(async () => {
      await withProfileSdk(pointerRecover);
    });

  return pointer;
}
