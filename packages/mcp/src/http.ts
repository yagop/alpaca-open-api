/**
 * Streamable-HTTP transport for the Alpaca MCP server.
 *
 * The bin (`mcp.ts`) speaks stdio by default; passing `--http` (or `SERVER_HTTP=1`)
 * runs this instead, serving the MCP "Streamable HTTP" transport over plain
 * `node:http` so it works under both Node (`npx @alpaca-open-api/mcp`) and Bun.
 *
 * Sessions are stateful: an `initialize` POST spins up a fresh {@link buildServer}
 * instance bound to a new {@link StreamableHTTPServerTransport}, keyed by the
 * generated `mcp-session-id`. Subsequent POST/GET/DELETE requests carrying that
 * header reuse the same server; a DELETE (or transport close) tears it down.
 *
 * Only the configured `path` (default `/mcp`) is served; everything else is 404.
 * When a `token` is configured, every request must carry a matching
 * `Authorization: Bearer <token>` header or it's rejected with 401.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { buildServer } from './compose';

export type HttpServerOptions = {
  /** Toolsets to register per session (see `buildServer`); default trading,data. */
  enabledToolsets?: string[];
  /** Path the MCP endpoint is served on. Default `/mcp`. */
  path?: string;
  /**
   * Shared secret required in an `Authorization: Bearer <token>` header. When set,
   * any request without a matching token is rejected with 401 before routing.
   * When omitted, the endpoint is unauthenticated (fine only for a loopback bind).
   */
  token?: string;
};

/** Constant-time bearer-token check; false on any mismatch or missing header. */
function isAuthorized(header: string | undefined, expected: string): boolean {
  const prefix = 'bearer ';
  if (!header || header.slice(0, prefix.length).toLowerCase() !== prefix) return false;
  const got = Buffer.from(header.slice(prefix.length).trim());
  const want = Buffer.from(expected);
  // timingSafeEqual requires equal-length buffers; the length check itself is not
  // secret (the token length is), so comparing lengths first is acceptable.
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Buffers a request body and parses it as JSON; `undefined` if empty or invalid. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Writes a JSON-RPC error envelope (the shape MCP clients expect on failures). */
function writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }),
  );
}

/**
 * Builds the `(req, res)` handler that implements stateful session routing.
 * Exposed separately from {@link startHttpServer} so it can be mounted on an
 * existing `http.Server` (or exercised in tests) without binding a port.
 */
export function createRequestListener(
  options: HttpServerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const path = options.path ?? '/mcp';
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const token = options.token;

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    if (token && !isAuthorized(req.headers.authorization, token)) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        }),
      );
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const existing = sessionId ? transports.get(sessionId) : undefined;

    // Established session: hand straight to its transport (it reads the body).
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }

    // A new session may only begin with an `initialize` POST.
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };

        const { server } = buildServer(options.enabledToolsets);
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      writeJsonRpcError(res, 400, 'Bad Request: no valid session ID provided');
      return;
    }

    // GET (SSE) / DELETE without a known session id.
    writeJsonRpcError(res, 400, 'Bad Request: no valid session ID provided');
  };
}

/**
 * Starts a `node:http` server exposing the MCP Streamable-HTTP endpoint and
 * begins listening. Returns the underlying {@link Server} so callers can close it.
 */
export function startHttpServer(
  options: HttpServerOptions & { port: number; hostname?: string },
): Server {
  const server = createServer(createRequestListener(options));
  server.listen(options.port, options.hostname);
  return server;
}
