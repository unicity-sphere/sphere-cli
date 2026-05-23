/**
 * Integration test: `sphere daemon {start,stop,status}` — persistent event
 * listener lifecycle.
 *
 * Two layers of pins:
 *
 *   1. **Help-shape (offline, 3 tests)** — `payments help <name>` for
 *      `daemon`, `daemon start`, `daemon status`. Pins the flag surface
 *      (--detach, --event, --action, --log, --pid) so a refactor that
 *      drops a documented flag without updating the help registry fails
 *      red.
 *
 *   2. **Detach lifecycle (network, 1 test)** — end-to-end:
 *        a. `sphere daemon start --detach --event 'transfer:incoming' \
 *           --action auto-receive` returns exit 0 with "Daemon started
 *           in background (PID X)".
 *        b. After a settle delay (~5s), `sphere daemon status` reports
 *           "Daemon is running (PID X)" — NOT "stale PID file".
 *        c. The on-disk daemon.log is non-empty and contains "Daemon
 *           running. Waiting for events." (proves the child reached
 *           the keep-alive Promise — not just the PID-file write).
 *        d. `sphere daemon stop` terminates the child within the
 *           5-second graceful-shutdown deadline.
 *        e. After stop, `sphere daemon status` reports "not running"
 *           and the PID file is gone.
 *
 *      This pin is load-bearing for issue #19 (`daemon start --detach`
 *      exits immediately, leaving a stale PID file) and for the
 *      manual-test-full-recovery.sh §C.3/§C.4 round-trip which depends
 *      on the daemon's event dispatch fire reliably.
 *
 * Why a real-testnet test (not unit / mocked):
 *
 *   The bug fixed by issue #19 was inside `child_process.fork()` +
 *   `process.disconnect()` interaction — semantics that only manifest
 *   when an actual node process is forked with the actual stdio /
 *   IPC-channel configuration. A unit test mocking fork() would not
 *   catch a recurrence. The test therefore spawns real `sphere`
 *   processes and asserts on the resulting on-disk and process state.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

const DAEMON_HELP_PINS: ReadonlyArray<{
  readonly legacy: string;
  readonly mustMatch: RegExp[];
}> = [
  // daemon: top-level subcommand listing
  { legacy: 'daemon',        mustMatch: [/start/, /stop/, /status/] },
  // daemon start: flag surface — the doc is the contract for operators
  { legacy: 'daemon start',  mustMatch: [/--detach/, /--event/, /--action/, /--log/, /--pid/] },
  // daemon status: minimal but must mention PID
  { legacy: 'daemon status', mustMatch: [/[Pp]ID|running/] },
];

describe('sphere-cli — daemon command shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('daemon-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { legacy, mustMatch } of DAEMON_HELP_PINS) {
    it(`\`sphere payments help ${legacy}\` lists documented usage`, () => {
      const r = runSphere(env, ['payments', 'help', legacy], { timeoutMs: 15_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`Usage:.*${legacy}`));
      for (const re of mustMatch) {
        expect(r.stdout, `${legacy} help missing ${re}`).toMatch(re);
      }
    });
  }
});

describe.skipIf(integrationSkip)(
  'sphere-cli integration — daemon detach lifecycle (real testnet)',
  () => {
    // Bug fixed by issue #19: `daemon start --detach` used `stdio: 'ignore'`
    // when forking the child, then unconditionally called
    // `process.disconnect()` in the child. With stdio:'ignore' no IPC
    // channel exists, so disconnect throws "IPC channel is not open" —
    // crashing the child silently with a stale PID file and an empty
    // log file. The fix:
    //   * Parent passes the log fd as the child's stdout/stderr (so any
    //     future startup crash is visible).
    //   * Child guards the disconnect with `if (process.connected)`.
    //
    // This test reproduces the exact sequence from the bug report and
    // asserts the full lifecycle (start → status → log → stop → status)
    // completes cleanly. A regression in either side of the fix flips
    // this red.
    let env: SphereEnv;

    beforeAll(async () => {
      env = createSphereEnv('daemon-detach');
      // Opt into non-TTY mnemonic emission so wallet init succeeds in a
      // headless test; the value is otherwise gated by isatty() to avoid
      // accidental capture into log files / CI artifacts.
      env.env['SPHERE_ALLOW_MNEMONIC_NON_TTY'] = '1';

      const init = runSphere(env, ['init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('wallet init failed', { stdout: init.stdout, stderr: init.stderr });
        throw new Error('wallet init failed — daemon test cannot run without a wallet');
      }
    }, 180_000);

    afterEach(() => {
      // Belt-and-braces cleanup: if a test failed mid-lifecycle the
      // forked daemon would otherwise outlive the test, holding open
      // Nostr WebSocket connections against the testnet relay. Always
      // try to stop; ignore "no daemon running".
      runSphere(env, ['daemon', 'stop'], { timeoutMs: 30_000 });
    });

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('start --detach → status (running) → log non-empty → stop → status (not running) → pid gone', async () => {
      // --- Phase 1: start ---
      // Repro from the issue: --event 'transfer:incoming' --action auto-receive.
      // The action choice is incidental; what matters is that the daemon
      // forks, subscribes, and survives past PID-file write.
      const start = runSphere(
        env,
        [
          'daemon', 'start', '--detach',
          '--event', 'transfer:incoming',
          '--action', 'auto-receive',
        ],
        { timeoutMs: 30_000 },
      );
      if (start.status !== 0) {
        console.error('daemon start failed', { stdout: start.stdout, stderr: start.stderr });
      }
      expect(start.status).toBe(0);
      // The parent prints "Daemon started in background (PID X)" — pin
      // the literal so a wording change is intentional.
      const pidMatch = start.stdout.match(/Daemon started in background \(PID (\d+)\)/);
      expect(pidMatch, `start did not print PID line:\n${start.stdout}`).toBeTruthy();
      const childPid = parseInt(pidMatch![1]!, 10);
      expect(childPid).toBeGreaterThan(0);

      const pidFile = join(env.home, '.sphere-cli', 'daemon.pid');
      const logFile = join(env.home, '.sphere-cli', 'daemon.log');

      // --- Phase 2: settle + status ---
      // Sphere.init takes ~0.5-1.5s; allow 6s before status check so we
      // give "Daemon running. Waiting for events." time to land in the
      // log even on a slow CI runner. Issue #19's repro used 3s but the
      // test budget can afford to be generous.
      await sleep(6_000);

      const status = runSphere(env, ['daemon', 'status'], { timeoutMs: 30_000 });
      if (status.status !== 0 || !/Daemon is running/.test(status.stdout)) {
        const logContent = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(no log file)';
        console.error('daemon status failed', {
          status: status.status,
          stdout: status.stdout,
          stderr: status.stderr,
          logContent,
        });
      }
      expect(status.status).toBe(0);
      // The literal we MUST see — the bug surfaced as "Daemon is not
      // running (stale PID file, process X)" which this regex
      // negative-matches.
      expect(status.stdout).toMatch(new RegExp(`Daemon is running \\(PID ${childPid}\\)`));

      // --- Phase 3: log file populated ---
      expect(existsSync(logFile)).toBe(true);
      expect(statSync(logFile).size).toBeGreaterThan(0);
      const logContent = readFileSync(logFile, 'utf8');
      // The keep-alive marker. If the child only made it to PID write
      // and then crashed (issue #19), this line never lands.
      expect(logContent, `daemon log missing keep-alive marker:\n${logContent}`)
        .toMatch(/Daemon running\. Waiting for events\./);

      // --- Phase 4: stop ---
      const stop = runSphere(env, ['daemon', 'stop'], { timeoutMs: 30_000 });
      if (stop.status !== 0) {
        console.error('daemon stop failed', { stdout: stop.stdout, stderr: stop.stderr });
      }
      expect(stop.status).toBe(0);
      expect(stop.stdout).toMatch(/Daemon stopped/);

      // --- Phase 5: post-stop state ---
      // Give the SIGTERM handler a moment to delete the PID file even
      // if the stop command returned the instant the process died.
      await sleep(500);

      expect(existsSync(pidFile)).toBe(false);
      const status2 = runSphere(env, ['daemon', 'status'], { timeoutMs: 30_000 });
      expect(status2.status).toBe(0);
      expect(status2.stdout).toMatch(/Daemon is not running/);
    }, 180_000);
  },
);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
