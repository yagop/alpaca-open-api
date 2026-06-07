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
 *  3. `handlers.ts` calls the fetch client with the wrong arg order for operations
 *     that take both a query param and a body: the template emits
 *     `op(args.bodyParams, args.queryParams, ...)`, but the client signature is
 *     `op(queryParams, body, ...)`. Left as-is, a call would send the body as the
 *     query string and the query as the body. We swap the two args so the runtime
 *     call is correct. Because this is the only thing that stopped the handlers
 *     from type-checking, we no longer mask them with `@ts-nocheck` - a future
 *     arg-order regression now fails `tsc` instead of shipping silently.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const generatedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'generated');

/**
 * Swap `(args.bodyParams, args.queryParams,` -> `(args.queryParams, args.bodyParams,`
 * at every handler call site. Targets only the query+body call pattern (path-param
 * handlers already emit the path arg first), and is idempotent: once swapped the
 * source pattern is gone, so re-running is a no-op.
 */
const fixQueryBodyArgOrder = (file: string): void => {
  const source = readFileSync(file, 'utf8');
  const fixed = source.replace(/\(args\.bodyParams, args\.queryParams,/g, '(args.queryParams, args.bodyParams,');
  if (fixed !== source) writeFileSync(file, fixed);
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
  if (existsSync(handlers)) fixQueryBodyArgOrder(handlers);
}

process.stderr.write('postgen: injected mutator imports, removed unused server.ts, fixed query+body arg order\n');
