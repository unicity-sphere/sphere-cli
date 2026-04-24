#!/usr/bin/env node
/**
 * Sphere CLI entry-point shim.
 *
 * Prefers the compiled `dist/index.js` when present (production install).
 * Falls back to `tsx src/index.ts` for development (monorepo root, pre-build).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(__dirname, '../dist/index.js');
const srcEntry = resolve(__dirname, '../src/index.ts');

if (existsSync(distEntry)) {
  const mod = await import(distEntry);
  const code = await mod.main(process.argv);
  // Always exit explicitly so open handles (Nostr sockets, timers) don't keep
  // the process alive after the command finishes. Daemon commands manage their
  // own keep-alive via event loop references and never return from main().
  process.exit(code);
} else if (existsSync(srcEntry)) {
  // Dev mode: resolve tsx from local node_modules to avoid PATH injection.
  const { spawn } = await import('node:child_process');
  const tsxBin = resolve(__dirname, '../node_modules/.bin/tsx');
  const tsxEntry = existsSync(tsxBin) ? tsxBin : 'npx tsx';
  const [cmd, ...cmdArgs] = tsxEntry.includes(' ')
    ? ['npx', 'tsx']
    : [tsxBin];
  const child = spawn(cmd, [...cmdArgs, srcEntry, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  // Use 'close' (not 'exit') so all child stdio flushes before we exit.
  child.on('close', (code) => process.exit(code ?? 0));
} else {
  process.stderr.write('sphere: no entry found. Did you run `npm run build`?\n');
  process.exit(1);
}
