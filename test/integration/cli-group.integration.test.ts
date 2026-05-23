/**
 * Integration test: `sphere group ...` — GroupChatModule CLI surface
 * (NIP-29 group chat).
 *
 * Backstop for the CLI extraction: the group surface was lost binary-
 * level coverage when the in-tree sphere-sdk CLI was deleted. SDK-level
 * tests exist (sphere-sdk `tests/relay/groupchat-relay.test.ts` runs
 * against a Dockerized NIP-29 relay), but they don't exercise the CLI
 * binary's namespace bridge → dispatcher → GroupChatModule glue.
 *
 * Two layers of pins (this file):
 *
 *   1. **Help-shape pins (offline)** — `sphere payments help <legacy-name>`
 *      for all 9 group-* commands. Pins the documented usage line + key
 *      flags / positionals so a doc-drop or flag-rename flips this red.
 *
 *   2. **Arg-validation pins (offline)** — Every command except
 *      `group-list` and `group-my` requires a positional (groupId,
 *      groupName, or message). Bare invocation MUST exit non-zero
 *      with a usage hint BEFORE the wallet load — pinning prevents
 *      a refactor from reordering the check below getSphere().
 *
 * Live group lifecycle (create → invite → join → send → messages →
 * leave roundtrip against a real NIP-29 relay) is intentionally NOT
 * in this file. The sphere-sdk `tests/relay/groupchat-relay.test.ts`
 * already covers that pipeline at the SDK layer with a Dockerized
 * relay. Re-running the same scenario at the CLI binary level adds
 * dependency on `wss://sphere-relay.unicity.network` (the default
 * NIP-29 relay) being live, or on a separate Dockerized NIP-29 relay
 * compatible with the moderation event set the module emits — neither
 * of which trader-service's `local-infra/docker-compose.yml` provides.
 *
 * If a future PR wires up a NIP-29-capable local relay (and the SDK
 * proves stable against it), the e2e tier can be added here following
 * the cli-swap-e2e pattern.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  type SphereEnv,
} from './helpers.js';

/**
 * Subcommands of `sphere group <sub>` and the legacy command name they
 * bridge to. The namespace bridge (src/index.ts:128) prefixes the
 * subcommand with `group-` and forwards to the legacy dispatcher.
 *
 * Each entry pins the load-bearing Usage line + at least one
 * documented flag or positional. Help dispatch is via the unified
 * `payments help <legacy>` form (commander strips `payments`, the
 * help router looks up HELP_TEXT[legacy]).
 */
const GROUP_SUBCOMMANDS: ReadonlyArray<{
  /** Legacy command name (also HELP_TEXT key). */
  readonly legacy: string;
  /** Regex(es) that MUST appear in help output. */
  readonly mustMatch: RegExp[];
}> = [
  { legacy: 'group-create',   mustMatch: [/<name>/, /--description/, /--private/] },
  { legacy: 'group-list',     mustMatch: [/Usage:.*group-list/] },
  { legacy: 'group-my',       mustMatch: [/Usage:.*group-my/] },
  { legacy: 'group-join',     mustMatch: [/<groupId>/, /--invite/] },
  { legacy: 'group-leave',    mustMatch: [/<groupId>/] },
  { legacy: 'group-send',     mustMatch: [/<groupId>/, /<message>/, /--reply/] },
  { legacy: 'group-messages', mustMatch: [/<groupId>/, /--limit/] },
  { legacy: 'group-members',  mustMatch: [/<groupId>/] },
  { legacy: 'group-info',     mustMatch: [/<groupId>/] },
];

describe('sphere-cli — group command shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('group-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { legacy, mustMatch } of GROUP_SUBCOMMANDS) {
    it(`\`sphere payments help ${legacy}\` lists documented usage + key flags`, () => {
      const r = runSphere(env, ['payments', 'help', legacy], { timeoutMs: 15_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`Usage:.*${legacy}`));
      for (const re of mustMatch) {
        expect(r.stdout, `${legacy} help missing ${re}`).toMatch(re);
      }
    });
  }
});

describe('sphere-cli — group arg validation (offline)', () => {
  // Every group-* command EXCEPT group-list and group-my validates a
  // positional BEFORE getSphere() (see src/legacy/legacy-cli.ts:3139+).
  // Missing positional → usage hint + non-zero exit, no wallet load.
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('group-args'); });
  afterAll(() => { destroySphereEnv(env); });

  it.each([
    ['create',   'group-create'],
    ['join',     'group-join'],
    ['leave',    'group-leave'],
    ['send',     'group-send'],
    ['messages', 'group-messages'],
    ['members',  'group-members'],
    ['info',     'group-info'],
  ])('`sphere group %s` with no args prints usage and exits non-zero', (sub, legacyName) => {
    const r = runSphere(env, ['group', sub], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(new RegExp(`Usage:\\s*${legacyName}|usage:\\s*${legacyName}`, 'i'));
  });

  it('`sphere group send <groupId>` (missing message) prints usage and exits non-zero', () => {
    // group-send requires TWO positionals; missing the second also
    // hits the pre-getSphere() guard.
    const r = runSphere(env, ['group', 'send', '00deadbeef'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/Usage:\s*group-send|usage:\s*group-send/i);
  });
});
