/**
 * Optional streamable-http transport for hosting the MCP server remotely.
 *
 * `stdio` (see `mcp.ts`) is the default and trusts the process environment for
 * credentials - the OS process boundary is the trust boundary. This transport is
 * the multi-tenant alternative: the server holds no secrets of its own and each
 * request carries its own Alpaca credentials in headers - possession of valid keys
 * *is* the authorization (a pure pass-through proxy). The headers are read into a
 * per-request {@link reqCtx} store that the mutator consumes; a credential-less
 * request is rejected with **no env fallback**, so an open endpoint can never be
 * turned into a confused deputy borrowing the server's own keys.
 *
 * Each request gets a fresh {@link buildServer | McpServer} + stateless transport
 * (no session state shared between requests, so requests stay fully isolated), and
 * is handled inside `reqCtx.run(creds, ...)` so the credentials reach the mutator
 * without any change to the generated handler/client signatures.
 *
 * Credentials are never logged.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { reqCtx, type Creds } from '@alpaca-open-api/core';
import { buildServer } from './compose';

/** Per-request credential headers (Node lower-cases incoming header names). */
const KEY_HEADER = 'apca-api-key-id';
const SECRET_HEADER = 'apca-api-secret-key';
const ENV_HEADER = 'x-alpaca-env';
const AUTH_HEADER = 'authorization';
const BEARER_PREFIX = 'bearer ';

export type HttpServerOptions = {
  /** The single MCP endpoint path. Default `/mcp`. */
  path?: string;
  /** Toolsets registered per request (forwarded to {@link buildServer}); default is buildServer's own. */
  toolsets?: string[];
};

export type StartHttpServerOptions = HttpServerOptions & {
  /** TCP port to listen on. */
  port: number;
  /** Interface to bind. Default `127.0.0.1` - loopback only; front it with a TLS proxy to expose publicly. */
  host?: string;
};

const firstHeader = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Reads the per-request credentials from headers, accepting either pass-through shape:
 *
 * - `APCA-API-KEY-ID` + `APCA-API-SECRET-KEY` - the caller's Alpaca key/secret (clients
 *   that can set headers); or
 * - `Authorization: Bearer <token>` - an Alpaca OAuth2 access token (header-less hosts
 *   like Claude Web, which authenticate via OAuth).
 *
 * Returns `undefined` when neither is present - the caller rejects such requests (no env
 * fallback). `x-alpaca-env: paper` selects the paper/sandbox hosts; anything else is live.
 */
const credsFromHeaders = (req: IncomingMessage): Creds | undefined => {
  const env = firstHeader(req, ENV_HEADER)?.toLowerCase() === 'paper' ? 'paper' : 'live';
  const key = firstHeader(req, KEY_HEADER);
  const secret = firstHeader(req, SECRET_HEADER);
  if (key && secret) return { key, secret, env };
  const auth = firstHeader(req, AUTH_HEADER);
  if (auth?.toLowerCase().startsWith(BEARER_PREFIX)) {
    const token = auth.slice(BEARER_PREFIX.length).trim();
    if (token) return { token, env };
  }
  return undefined;
};

/** Writes a JSON-RPC-shaped error response (the body the transport would also emit). */
const sendError = (res: ServerResponse, status: number, code: number, message: string): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
};

/**
 * Builds (but does not start) the streamable-http MCP server. Call `.listen()` on
 * the returned server, or use {@link startHttpServer}.
 */
export function createHttpServer(opts: HttpServerOptions = {}): Server {
  const path = opts.path ?? '/mcp';
  return createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== path) {
      sendError(res, 404, -32601, `not found: ${pathname}`);
      return;
    }
    const creds = credsFromHeaders(req);
    if (!creds) {
      // No env fallback: a credential-less request is unauthorized, never served
      // with the server's own keys.
      sendError(res, 401, -32001, `missing Alpaca credentials (${KEY_HEADER} / ${SECRET_HEADER} headers, or ${AUTH_HEADER}: Bearer)`);
      return;
    }
    // Stateless, fresh per request: no shared session or JSON-RPC id state, and the
    // transport reads the body itself (credentials live in headers, so we never
    // parse the body here).
    const { server } = buildServer(opts.toolsets);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await reqCtx.run(creds, () => transport.handleRequest(req, res));
    } catch {
      if (!res.headersSent) sendError(res, 500, -32603, 'internal error');
    }
  });
}

/** Starts the streamable-http server and resolves once it is listening. */
export function startHttpServer(opts: StartHttpServerOptions): Promise<Server> {
  const server = createHttpServer(opts);
  const host = opts.host ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolve(server));
  });
}

/**
 * CLI runner for the http transport: reads the `ALPACA_HTTP_*` env, starts the
 * server, and writes a readiness banner to stderr. Throws on an invalid port. The
 * factories above ({@link createHttpServer} / {@link startHttpServer}) carry no
 * env or logging - those are what an embedding/serverless deployment imports.
 */
export async function runHttpServer(opts: HttpServerOptions = {}): Promise<Server> {
  const port = Number(process.env.ALPACA_HTTP_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid ALPACA_HTTP_PORT: ${process.env.ALPACA_HTTP_PORT}`);
  }
  const host = process.env.ALPACA_HTTP_HOST ?? '127.0.0.1';
  const path = process.env.ALPACA_HTTP_PATH ?? opts.path ?? '/mcp';
  // One-time build to report the tool count (the transport rebuilds per request).
  const { count } = buildServer(opts.toolsets);
  const server = await startHttpServer({ port, host, path, toolsets: opts.toolsets });
  const toolsetsNote = opts.toolsets?.length ? ` (toolsets: ${opts.toolsets.join(', ')})` : '';
  process.stderr.write(
    `alpaca-api MCP server (streamable-http) ready - ${count} tools, listening on http://${host}:${port}${path}. ` +
      `Credentials are read per request from the APCA-API-KEY-ID / APCA-API-SECRET-KEY headers ` +
      `(X-Alpaca-Env: paper|live)${toolsetsNote}.\n`
  );
  return server;
}
