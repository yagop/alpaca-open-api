#!/usr/bin/env node
/**
 * Alpaca MCP server.
 *
 * Exposes the entire Alpaca API surface (Trading, Market Data, Broker, AuthX)
 * to MCP clients. The design is hybrid:
 *
 *   - **Curated tools** for the common trading/market-data calls, with explicit,
 *     well-described arguments (`alpaca_place_order`, `alpaca_get_bars`, …).
 *   - **Gateway tools** (`alpaca_search_endpoints` / `alpaca_describe_endpoint` /
 *     `alpaca_call_endpoint`) that reach every one of the ~266 catalogued
 *     operations, so nothing is out of reach.
 *
 * Both layers funnel through {@link callOperation}, which resolves the correct
 * host and auth strategy per API from the catalog shipped by
 * `@open-alpaca-api/core`.
 *
 * Published as the `@open-alpaca-api/mcp` CLI — run via `npx @open-alpaca-api/mcp`
 * (or `bun run src/mcp.ts` in development). Configure via environment variables:
 *
 *   ALPACA_API_KEY, ALPACA_API_SECRET   (required)
 *   ALPACA_ENV = paper | live            (default: paper)
 *   ALPACA_{TRADING,DATA,BROKER,AUTHX}_URL  (optional per-API base-URL overrides)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadCatalog, type Catalog, type Operation } from '@open-alpaca-api/core';

// CLI: this package is published as a bin (`alpaca-mcp` / `npx @open-alpaca-api/mcp`).
// Handle informational flags before any network or transport work.
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    `alpaca-mcp — MCP server for the Alpaca Markets API\n\n` +
      `Usage:\n` +
      `  npx @open-alpaca-api/mcp        Start the server on stdio (for MCP clients)\n\n` +
      `Environment:\n` +
      `  ALPACA_API_KEY          (required)  API key\n` +
      `  ALPACA_API_SECRET       (required)  API secret\n` +
      `  ALPACA_ENV              paper|live  (default: paper)\n` +
      `  ALPACA_{TRADING,DATA,BROKER,AUTHX}_URL   per-API base-URL overrides\n`
  );
  process.exit(0);
}
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('0.1.0\n');
  process.exit(0);
}

// Derive the endpoint catalog from the live OpenAPI specs (built once, then
// cached on disk and reused — the Alpaca API surface doesn't change).
const catalog: Catalog = await loadCatalog();
const byId = new Map(catalog.operations.map((op) => [op.operationId, op]));

const API_KEY = process.env.ALPACA_API_KEY ?? '';
const API_SECRET = process.env.ALPACA_API_SECRET ?? '';
const IS_LIVE = (process.env.ALPACA_ENV ?? 'paper').toLowerCase() === 'live';

if (!API_KEY || !API_SECRET) {
  process.stderr.write('Warning: ALPACA_API_KEY / ALPACA_API_SECRET are not set; calls will fail auth.\n');
}

/** Resolves the base URL for an API, honoring `ALPACA_<API>_URL` overrides. */
function resolveBaseUrl(api: string): string {
  const override = process.env[`ALPACA_${api.toUpperCase()}_URL`];
  if (override) return override;
  const { servers } = catalog.apis[api];
  // Market data is served from one host regardless of paper/live.
  if (api === 'data') return servers.live;
  return IS_LIVE ? servers.live : (servers.paper ?? servers.sandbox ?? servers.live);
}

/** Substitutes `{param}` placeholders in a path, erroring on any missing value. */
function fillPath(path: string, pathParams: Record<string, unknown>): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = pathParams[name];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

type CallArgs = { pathParams?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };

/** Core request path shared by every tool. Routes host + auth from the catalog. */
async function callOperation(op: Operation, { pathParams = {}, query = {}, body }: CallArgs) {
  const path = fillPath(op.path, pathParams);

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    qs.append(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const url = `${resolveBaseUrl(op.api)}${path}${qs.toString() ? `?${qs}` : ''}`;

  const auth = catalog.apis[op.api].auth;
  const headers: Record<string, string> = {};
  let payload: string | undefined;

  if (auth === 'form') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (body && typeof body === 'object') payload = new URLSearchParams(body as Record<string, string>).toString();
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
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* leave as raw text */
    }
  }

  if (!response.ok) {
    throw new Error(`${op.method} ${path} → ${response.status} ${response.statusText}: ${text.slice(0, 800)}`);
  }
  return { status: response.status, url, data };
}

function findOp(operationId: string): Operation {
  const op = byId.get(operationId);
  if (!op) throw new Error(`Unknown operationId: ${operationId}`);
  return op;
}

const server = new McpServer({ name: 'alpaca-api', version: '0.1.0' });

/** Wraps a handler so thrown errors become MCP tool errors instead of crashes. */
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway tools — reach every catalogued operation.
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
  'alpaca_search_endpoints',
  {
    title: 'Search Alpaca endpoints',
    description:
      'Search the full catalog of Alpaca API operations by keyword (matched against operationId, path, summary, and tags). Optionally filter by api: trading | data | broker | authx. Returns operationIds to use with alpaca_describe_endpoint / alpaca_call_endpoint.',
    inputSchema: {
      query: z.string().describe('Keyword(s) to match, e.g. "orders", "latest quote", "watchlist".'),
      api: z.enum(['trading', 'data', 'broker', 'authx']).optional().describe('Restrict to one API.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25).'),
    },
  },
  async ({ query, api, limit }) => {
    try {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = catalog.operations
        .filter((op) => !api || op.api === api)
        .map((op) => {
          const hay = `${op.operationId} ${op.method} ${op.path} ${op.summary} ${op.tags.join(' ')}`.toLowerCase();
          const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
          return { op, score };
        })
        .filter((m) => m.score === terms.length)
        .slice(0, limit ?? 25)
        .map(({ op }) => ({ api: op.api, operationId: op.operationId, method: op.method, path: op.path, summary: op.summary }));
      return ok({ count: matches.length, matches });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'alpaca_describe_endpoint',
  {
    title: 'Describe an Alpaca endpoint',
    description: 'Return the full schema for one operation: method, path, path/query parameters, and request-body shape.',
    inputSchema: { operationId: z.string().describe('From alpaca_search_endpoints.') },
  },
  async ({ operationId }) => {
    try {
      return ok(findOp(operationId));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'alpaca_call_endpoint',
  {
    title: 'Call any Alpaca endpoint',
    description:
      'Invoke any catalogued operation by operationId. Supply pathParams for {placeholders} in the path, query for query-string params, and body for the request payload. Host and auth are resolved automatically per API.',
    inputSchema: {
      operationId: z.string().describe('From alpaca_search_endpoints.'),
      pathParams: z.record(z.string(), z.any()).optional().describe('Values for {…} placeholders in the path.'),
      query: z.record(z.string(), z.any()).optional().describe('Query-string parameters.'),
      body: z.any().optional().describe('Request body (object). Sent as JSON, or form-encoded for AuthX.'),
    },
  },
  async ({ operationId, pathParams, query, body }) => {
    try {
      return ok(await callOperation(findOp(operationId), { pathParams, query, body }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Curated tools — the common trading / market-data path.
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
  'alpaca_get_account',
  { title: 'Get account', description: 'Fetch the trading account (status, cash, buying power, equity).', inputSchema: {} },
  async () => {
    try {
      return ok(await callOperation(findOp('getAccount'), {}));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'alpaca_list_positions',
  { title: 'List positions', description: 'List all open positions.', inputSchema: {} },
  async () => {
    try {
      return ok(await callOperation(findOp('getAllOpenPositions'), {}));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'alpaca_list_orders',
  {
    title: 'List orders',
    description: 'List orders, optionally filtered by status (open | closed | all) and limit.',
    inputSchema: {
      status: z.enum(['open', 'closed', 'all']).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async ({ status, limit }) => {
    try {
      return ok(await callOperation(findOp('getAllOrders'), { query: { status, limit } }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'alpaca_place_order',
  {
    title: 'Place order',
    description:
      'Submit an order. Provide either qty (shares) or notional (dollar amount). type defaults to market; for limit/stop orders supply limit_price / stop_price.',
    inputSchema: {
      symbol: z.string(),
      side: z.enum(['buy', 'sell']),
      qty: z.string().optional().describe('Number of shares, as a string (e.g. "1").'),
      notional: z.string().optional().describe('Dollar amount, as a string. Mutually exclusive with qty.'),
      type: z.enum(['market', 'limit', 'stop', 'stop_limit', 'trailing_stop']).optional(),
      time_in_force: z.enum(['day', 'gtc', 'opg', 'cls', 'ioc', 'fok']).optional(),
      limit_price: z.string().optional(),
      stop_price: z.string().optional(),
    },
  },
  async ({ symbol, side, qty, notional, type, time_in_force, limit_price, stop_price }) => {
    try {
      const body = {
        symbol,
        side,
        qty,
        notional,
        type: type ?? 'market',
        time_in_force: time_in_force ?? 'day',
        limit_price,
        stop_price,
      };
      for (const k of Object.keys(body) as Array<keyof typeof body>) if (body[k] === undefined) delete body[k];
      return ok(await callOperation(findOp('postOrder'), { body }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'alpaca_cancel_order',
  {
    title: 'Cancel order',
    description: 'Cancel a single open order by its order_id.',
    inputSchema: { order_id: z.string() },
  },
  async ({ order_id }) => {
    try {
      return ok(await callOperation(findOp('deleteOrderByOrderID'), { pathParams: { order_id } }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'alpaca_get_clock',
  { title: 'Market clock', description: 'Whether the market is open, plus next open/close times.', inputSchema: {} },
  async () => {
    try {
      return ok(await callOperation(findOp('LegacyClock'), {}));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'alpaca_latest_quote',
  {
    title: 'Latest stock quote',
    description: 'Latest bid/ask quote for a stock symbol (Market Data API).',
    inputSchema: { symbol: z.string() },
  },
  async ({ symbol }) => {
    try {
      return ok(await callOperation(findOp('StockLatestQuoteSingle'), { pathParams: { symbol } }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'alpaca_get_bars',
  {
    title: 'Historical stock bars',
    description: 'OHLCV bars for a stock symbol. timeframe e.g. "1Day", "1Hour", "5Min". start/end are RFC-3339.',
    inputSchema: {
      symbol: z.string(),
      timeframe: z.string().describe('e.g. 1Min, 5Min, 1Hour, 1Day.'),
      start: z.string().optional(),
      end: z.string().optional(),
      limit: z.number().int().min(1).max(10000).optional(),
    },
  },
  async ({ symbol, timeframe, start, end, limit }) => {
    try {
      return ok(await callOperation(findOp('StockBarSingle'), { pathParams: { symbol }, query: { timeframe, start, end, limit } }));
    } catch (error) {
      return fail(error);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`alpaca-api MCP server ready — ${catalog.count} operations catalogued.\n`);
