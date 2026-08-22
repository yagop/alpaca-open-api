/**
 * Post-processing for the Orval-generated MCP output (run right after `orval`).
 *
 * Fix-ups for `@orval/mcp` quirks when used with `override.mutator`:
 *  1. The `<api>Mutator` import is emitted into `handlers.ts` (unused) instead of
 *     `http-client.ts` (where it is called) - we add it to http-client so the
 *     bundle resolves at runtime.
 *  2. `server.ts` (its own stdio entry) is unused - `compose.ts` composes all four
 *     APIs onto one server - and references response schemas we disable, so it
 *     does not type-check. We delete it, but first harvest the tool `title`s Orval
 *     put on each `registerTool` call (see below).
 *  3. We emit a `register.ts` per API: a statically-typed `register<Api>Tools`
 *     function with one `server.registerTool` call per operation (handler + Zod
 *     input schemas referenced by name), so `compose.ts` registers tools without
 *     reflecting over module exports or casting. Each tool's description is the
 *     operation's OpenAPI summary - which Orval already extracts as the `title`
 *     in its `server.ts` - falling back to the generic `ctx.describe('<op>')`
 *     when Orval emitted no title.
 *
 * The earlier query+body arg-order quirk (and optional bodies typed as required)
 * was fixed upstream in `@orval/mcp` (orval PR #3600), released in orval 8.18.0,
 * so no post-gen swap is needed.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const generatedDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'generated',
);

const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Decode the common escapes Orval emits in single-quoted JS string literals. */
const unescapeJs = (s: string): string =>
  s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc: string) => {
    switch (esc) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      default:
        if (esc[0] === 'u' || esc[0] === 'x')
          return String.fromCharCode(parseInt(esc.slice(1), 16));
        return esc; // \' \" \\ \/ and any other single-char escape -> itself
    }
  });

/**
 * Map each operation to its tool `title` (the OpenAPI summary) as emitted by
 * Orval in `server.ts`: `server.registerTool('<op>', { title: '<summary>', ... })`.
 * The registered name matches the handler op exactly, so no normalization is
 * needed. Returns an empty map if `server.ts` is absent.
 */
const titlesFromServer = (serverSrc: string | undefined): Map<string, string> => {
  const map = new Map<string, string>();
  if (!serverSrc) return map;
  const re =
    /server\.registerTool\(\s*'(\w+)',\s*\{\s*title:\s*'((?:[^'\\]|\\.)*)'/g;
  for (const m of serverSrc.matchAll(re)) {
    const title = unescapeJs(m[2]).replace(/\s+/g, ' ').trim();
    if (title) map.set(m[1], title.slice(0, 200));
  }
  return map;
};

/**
 * Emit `register.ts` for one API by reading the generated `handlers.ts` and
 * `tool-schemas.zod.ts`: one `server.registerTool` call per `<op>Handler`, paired
 * with its Zod input (`<Op>Params`/`<Op>QueryParams`/`<Op>Body`). A handler that
 * takes args but has no generated Zod is a hard error: it would mean a spec or
 * generator gap that silently loses input validation.
 */
const generateRegister = (
  api: string,
  apiDir: string,
  titles: Map<string, string>,
): void => {
  const handlersSrc = readFileSync(join(apiDir, 'handlers.ts'), 'utf8');
  const zodSrc = readFileSync(join(apiDir, 'tool-schemas.zod.ts'), 'utf8');
  const zodExports = new Set(
    [...zodSrc.matchAll(/export const (\w+) =/g)].map((m) => m[1]),
  );

  const calls: string[] = [];

  for (const match of handlersSrc.matchAll(
    /export const (\w+)Handler = async \(\s*(\w+)/g,
  )) {
    const op = match[1];
    // Use the OpenAPI summary Orval extracted; fall back to the generic describe.
    const title = titles.get(op);
    const descExpr = title ? JSON.stringify(title) : `ctx.describe('${op}')`;
    const head = `ctx.tool('${op}'), { description: ${descExpr}`;

    if (match[2] !== 'args') {
      calls.push(
        `  server.registerTool(${head} }, async () => ctx.strip('${op}', await handlers.${op}Handler()));`,
      );
      continue;
    }

    const P = pascal(op);
    const parts: string[] = [];
    if (zodExports.has(`${P}Params`)) parts.push(`pathParams: schemas.${P}Params`);
    if (zodExports.has(`${P}QueryParams`))
      parts.push(`queryParams: schemas.${P}QueryParams`);
    if (zodExports.has(`${P}Body`)) parts.push(`bodyParams: schemas.${P}Body`);

    if (parts.length === 0)
      throw new Error(
        `postgen: ${api}/${op} handler takes args but tool-schemas.zod.ts exports none of ${P}Params/${P}QueryParams/${P}Body - spec or generator gap, refusing to register it unvalidated`,
      );

    calls.push(
      `  server.registerTool(${head}, inputSchema: { ${parts.join(', ')} } }, async (args) => ctx.strip('${op}', await handlers.${op}Handler(args)));`,
    );
  }

  const content = `// Generated by scripts/postgen.ts - do not edit.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RegisterContext } from '../../registry';
import * as handlers from './handlers';
import * as schemas from './tool-schemas.zod';

export const register${pascal(api)}Tools = (
  server: McpServer,
  ctx: RegisterContext,
): void => {
${calls.join('\n')}
};
`;

  writeFileSync(join(apiDir, 'register.ts'), content);
};

for (const api of readdirSync(generatedDir)) {
  const apiDir = join(generatedDir, api);

  // Harvest the tool titles (OpenAPI summaries) Orval put in server.ts, then
  // remove server.ts (unused stdio entry that references disabled schemas).
  const server = join(apiDir, 'server.ts');
  const titles = titlesFromServer(existsSync(server) ? readFileSync(server, 'utf8') : undefined);
  if (existsSync(server)) rmSync(server);

  const httpClient = join(apiDir, 'http-client.ts');
  if (existsSync(httpClient)) {
    const importLine = `import { ${api}Mutator } from '../../mutator';`;
    const source = readFileSync(httpClient, 'utf8');
    if (!source.includes(importLine))
      writeFileSync(httpClient, `${importLine}\n${source}`);
  }

  generateRegister(api, apiDir, titles);
}

process.stderr.write(
  'postgen: injected mutator imports, removed unused server.ts, generated register.ts\n',
);
