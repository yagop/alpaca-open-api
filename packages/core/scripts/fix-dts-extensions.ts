/**
 * Post-process the emitted declarations so the published package type-resolves
 * under Node-style module resolution (`node16`/`nodenext`).
 *
 * `tsc` emits `dist/**\/*.d.ts` preserving the source's extensionless relative
 * specifiers (e.g. `export { API_ROUTING } from './api-routing'`). Under
 * `moduleResolution: node16`/`nodenext` - the standard for Node ESM consumers -
 * those are a hard error (TS2834: relative imports need explicit extensions). The
 * runtime `dist/index.js` is a single bundle and has no such imports, so this is
 * purely a types-path fix. We rewrite each relative specifier to its emitted
 * target: `./x` -> `./x.js` for a file, `./x` -> `./x/index.js` for a directory.
 * Handles both `from '...'` and inline `import('...')` type specifiers.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Resolve an extensionless relative specifier to its emitted `.js` target. */
function withExtension(fileDir: string, spec: string): string {
  if (!spec.startsWith('.')) return spec; // bare / external - leave as-is
  if (/\.(js|json)$/.test(spec)) return spec; // already explicit
  const base = resolve(fileDir, spec);
  if (existsSync(`${base}.d.ts`)) return `${spec}.js`;
  if (existsSync(join(base, 'index.d.ts'))) return `${spec}/index.js`;
  return spec; // unresolved - leave it; the dts-check gate will surface it
}

// Matches `from '<spec>'` and `import('<spec>')` for relative specifiers (start with '.').
const SPEC_RE = /(from\s*|import\s*\(\s*)(['"])(\.[^'"]*)\2/g;

let changed = 0;
for (const file of walk(distDir)) {
  const fileDir = dirname(file);
  const src = readFileSync(file, 'utf8');
  const out = src.replace(SPEC_RE, (_m, kw: string, q: string, spec: string) => `${kw}${q}${withExtension(fileDir, spec)}${q}`);
  if (out !== src) {
    writeFileSync(file, out);
    changed++;
  }
}

process.stderr.write(`fix-dts-extensions: rewrote relative specifiers in ${changed} .d.ts files\n`);
