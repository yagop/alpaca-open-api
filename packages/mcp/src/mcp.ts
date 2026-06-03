#!/usr/bin/env node
/**
 * Alpaca MCP server.
 *
 * Exposes the *entire* Alpaca API surface (Trading, Market Data, Broker, AuthX)
 * to MCP clients: every catalogued operation is registered as its own tool,
 * `alpaca_<operationId>`, with an input schema generated from the OpenAPI specs.
 *
 * There is no per-tool code — the server imports the committed tool manifest
 * from `@alpaca-open-api/core` (built from the same specs that generate the
 * TypeScript types) and registers each entry in one loop, handing the spec's
 * JSON Schema straight to the client and dispatching every call through one
 * generic {@link callOperation}. Host and auth are resolved per API from the
 * manifest, so nothing is hand-wired and nothing is out of reach.
 *
 * Published as the `@alpaca-open-api/mcp` CLI — run via `npx @alpaca-open-api/mcp`
 * (or `bun run src/mcp.ts` in development). Configure via environment variables:
 *
 *   ALPACA_API_KEY, ALPACA_API_SECRET   (required)
 *   ALPACA_ENV = paper | live            (default: paper)
 *   ALPACA_MCP_APIS = trading,data,…     (optional: restrict the registered APIs)
 *   ALPACA_{TRADING,DATA,BROKER,AUTHX}_URL  (optional per-API base-URL overrides)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { manifest, type ToolDef } from '@alpaca-open-api/core';

// CLI: this package is published as a bin (`alpaca-mcp` / `npx @alpaca-open-api/mcp`).
// Handle informational flags before any transport work.
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    `alpaca-mcp — MCP server for the Alpaca Markets API\n\n` +
      `Registers every Alpaca endpoint as an \`alpaca_<operationId>\` tool.\n\n` +
      `Usage:\n` +
      `  npx @alpaca-open-api/mcp        Start the server on stdio (for MCP clients)\n\n` +
      `Environment:\n` +
      `  ALPACA_API_KEY          (required)  API key\n` +
      `  ALPACA_API_SECRET       (required)  API secret\n` +
      `  ALPACA_ENV              paper|live  (default: paper)\n` +
      `  ALPACA_MCP_APIS         csv         restrict to a subset: trading,data,broker,authx\n` +
      `  ALPACA_{TRADING,DATA,BROKER,AUTHX}_URL   per-API base-URL overrides\n`
  );
  process.exit(0);
}
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('0.1.0\n');
  process.exit(0);
}

const API_KEY = process.env.ALPACA_API_KEY ?? '';
const API_SECRET = process.env.ALPACA_API_SECRET ?? '';
// `ALPACA_ENV` is canonical; `ALPACA_PAPER=false` is honored for back-compat.
const IS_LIVE =
  (process.env.ALPACA_ENV ?? (process.env.ALPACA_PAPER === 'false' ? 'live' : 'paper')).toLowerCase() === 'live';

if (!API_KEY || !API_SECRET) {
  process.stderr.write('Warning: ALPACA_API_KEY / ALPACA_API_SECRET are not set; calls will fail auth.\n');
}

// Optional scope filter — the full surface is ~266 tools, which some clients
// handle poorly; `ALPACA_MCP_APIS=trading,data` narrows it. Default: all APIs.
const enabledApis = (process.env.ALPACA_MCP_APIS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const tools = manifest.tools.filter((t) => enabledApis.length === 0 || enabledApis.includes(t.api));
const byName = new Map(tools.map((t) => [t.name, t]));

/** Resolves the base URL for an API, honoring `ALPACA_<API>_URL` overrides. */
function resolveBaseUrl(api: string): string {
  const override = process.env[`ALPACA_${api.toUpperCase()}_URL`];
  if (override) return override;
  const { servers } = manifest.apis[api];
  // Market data is served from one host regardless of paper/live.
  if (api === 'data') return servers.live;
  return IS_LIVE ? servers.live : (servers.paper ?? servers.sandbox ?? servers.live);
}

/** Substitutes `{param}` placeholders in a path, erroring on any missing value. */
function fillPath(path: string, pathParams: Record<string, any>): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = pathParams[name];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

type CallArgs = { path?: Record<string, any>; query?: Record<string, any>; body?: any };

/** Core request path shared by every tool. Routes host + auth from the manifest. */
async function callOperation(op: ToolDef, { path = {}, query = {}, body }: CallArgs) {
  const filledPath = fillPath(op.path, path);

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    qs.append(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const url = `${resolveBaseUrl(op.api)}${filledPath}${qs.toString() ? `?${qs}` : ''}`;

  const auth = manifest.apis[op.api].auth;
  const headers: Record<string, string> = {};
  let payload: string | undefined;

  if (auth === 'form') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (body && typeof body === 'object') payload = new URLSearchParams(body).toString();
  } else {
    if (auth === 'basic') {
      headers['Authorization'] = `Basic ${Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64')}`;
    } else {
      headers['APCA-API-KEY-ID'] = API_KEY;
      headers['APCA-API-SECRET-KEY'] = API_SECRET;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }

  const response = await fetch(url, { method: op.method, headers, body: payload });
  const text = await response.text();
  let data: any = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* leave as raw text */
    }
  }

  if (!response.ok) {
    throw new Error(`${op.method} ${filledPath} → ${response.status} ${response.statusText}: ${text.slice(0, 800)}`);
  }
  return { status: response.status, url, data };
}

// `McpServer` is the recommended entry point, but its high-level `registerTool`
// only accepts Zod schemas. To register the raw, full-fidelity JSON Schemas
// straight from the specs, we attach handlers to the underlying protocol server
// (`mcp.server`) — the documented escape hatch for advanced use. The `tools`
// capability is declared up front so it is advertised during initialization.
const mcp = new McpServer({ name: 'alpaca-api', version: '0.1.0' }, { capabilities: { tools: {} } });

mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: `${t.method} ${t.path}${t.summary ? ` — ${t.summary}` : ''}${t.description ? `\n${t.description}` : ''}`,
    inputSchema: t.inputSchema,
  })),
}));

mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const op = byName.get(request.params.name);
  if (!op) {
    return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }] };
  }
  try {
    const result = await callOperation(op, (request.params.arguments ?? {}) as CallArgs);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
process.stderr.write(
  `alpaca-api MCP server ready — ${tools.length} tools registered` +
    `${enabledApis.length ? ` (apis: ${enabledApis.join(', ')})` : ''}.\n`
);
