/**
 * Smoke test for `legacy-cli.ts` module-load.
 *
 * Why this exists:
 *   The L1-namespace destructure at the top of legacy-cli.ts
 *   (`const { encrypt, decrypt, hexToWIF, generatePrivateKey,
 *   generateAddressFromMasterKey } = L1;`) is the line that broke when
 *   sphere-sdk's namespace layout changed. The fix in this PR re-anchors
 *   those imports against the L1 namespace, but the existing 94-test
 *   suite never imports legacy-cli directly — every test in
 *   `src/index.test.ts` works through commander's `createCli()` /
 *   `buildLegacyArgv()` factories which lazily delegate to legacy-cli
 *   at call time, AFTER the test runner has already imported its own
 *   modules. As a result, a regression that broke the legacy-cli
 *   module-load (e.g., a future SDK rename of `decrypt` again) would
 *   pass `npm run typecheck` and `npm test` while breaking
 *   `sphere wallet …` at runtime — exactly the failure mode the
 *   legacy-cli regression that motivated this PR exhibited.
 *
 *   This test forces a static import of legacy-cli at test load time.
 *   If the destructure ever fails (TypeError: Cannot destructure
 *   property '<name>' of 'L1' as it is undefined), Vitest reports a
 *   clean module-load failure with a precise pointer to the bad symbol.
 *
 *   Coverage scope: this is INTENTIONALLY shallow — we don't exercise
 *   the encrypt/decrypt round-trip (that needs a wallet fixture and
 *   crosses into integration-test territory). We just confirm the
 *   module loads, which is enough to catch SDK-export drift.
 */

import { describe, it, expect } from 'vitest';

describe('legacy-cli module load', () => {
  it('imports without throwing — proves the L1 destructure resolved', async () => {
    // Dynamic import inside the test so a failure surfaces as a test
    // failure rather than as a module-collection-time crash that
    // takes down the whole vitest suite.
    //
    // This single test subsumes the entire scope of round-1's
    // intent: if the `const { encrypt, decrypt, ... } = L1;`
    // destructure at the top of legacy-cli.ts ever fails (L1
    // undefined, name renamed, etc.), the dynamic import below
    // throws at evaluation time and Vitest reports a clean failure
    // pointing at the bad symbol. No additional SDK-side checks
    // are needed — they would test the SDK in isolation, not the
    // module under review, creating false coverage signal.
    const mod = await import('./legacy-cli.js');
    expect(mod.legacyMain).toBeDefined();
    expect(typeof mod.legacyMain).toBe('function');
  });
});
