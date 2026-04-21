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
  if (code !== 0) process.exit(code);
} else if (existsSync(srcEntry)) {
  // Dev mode: delegate to tsx (must be installed).
  const { spawn } = await import('node:child_process');
  const child = spawn('npx', ['tsx', srcEntry, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  console.error('sphere: no entry found. Did you run `npm run build`?');
  process.exit(1);
}
