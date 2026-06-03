/**
 * Post-processing for the Orval-generated MCP output (run right after `orval`).
 *
 * Fix-ups for `@orval/mcp` v8.15 quirks when used with `override.mutator`:
 *  1. The `<api>Mutator` import is emitted into `handlers.ts` (unused) instead of
 *     `http-client.ts` (where it is called) - we add it to http-client so the
 *     bundle resolves at runtime.
 *  2. `server.ts` (its own stdio entry) is unused - `src/mcp.ts` composes all four
 *     APIs onto one server - and references response schemas we disable, so it
 *     does not type-check. We delete it.
 *  3. `handlers.ts` carries occasional arg-ordering bugs for operations that have
 *     both a path param and a body (e.g. `addAssetToWatchlistByName`). It is
 *     generated code, so we mark it `@ts-nocheck` rather than gate our build on
 *     upstream codegen; our authored code (mcp.ts, mutator.ts) stays type-checked.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const generatedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'generated');

const prepend = (file: string, text: string): void => {
  const source = readFileSync(file, 'utf8');
  if (!source.startsWith(text.split('\n')[0])) writeFileSync(file, `${text}${source}`);
};

for (const api of readdirSync(generatedDir)) {
  const apiDir = join(generatedDir, api);

  const server = join(apiDir, 'server.ts');
  if (existsSync(server)) rmSync(server);

  const httpClient = join(apiDir, 'http-client.ts');
  if (existsSync(httpClient)) {
    const importLine = `import { ${api}Mutator } from '../../mutator';`;
    const source = readFileSync(httpClient, 'utf8');
    if (!source.includes(importLine)) writeFileSync(httpClient, `${importLine}\n${source}`);
  }

  const handlers = join(apiDir, 'handlers.ts');
  if (existsSync(handlers)) prepend(handlers, '// @ts-nocheck\n');
}

process.stderr.write('postgen: injected mutator imports, removed unused server.ts, marked handlers @ts-nocheck\n');
