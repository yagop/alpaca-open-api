import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startHttpServer } from './http';

// Drives the HTTP transport end-to-end: a real MCP client speaks Streamable HTTP
// to a server bound on an ephemeral port. `fetch` is stubbed so tool calls
// exercise the full path (handler -> generated client -> mutator) minus network.
const realFetch = globalThis.fetch;
let server: Server;

beforeEach(() => {
  process.env.ALPACA_API_KEY = 'KEY';
  process.env.ALPACA_API_SECRET = 'SECRET';
  process.env.ALPACA_ENV = 'paper';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    // Pass the MCP client's own requests to the real fetch; stub Alpaca calls.
    if (String(input).includes('127.0.0.1') || String(input).includes('localhost')) {
      return realFetch(input, init);
    }
    return new Response(JSON.stringify({ id: 'acct-1' }), { status: 200 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function listen(opts: Parameters<typeof startHttpServer>[0]): Promise<number> {
  server = startHttpServer(opts);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return (server.address() as AddressInfo).port;
}

async function connect(
  enabledToolsets?: string[],
  opts: { token?: string; authHeader?: string } = {},
): Promise<Client> {
  const port = await listen({ port: 0, hostname: '127.0.0.1', enabledToolsets, token: opts.token });
  const requestInit = opts.authHeader ? { headers: { authorization: opts.authHeader } } : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit,
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}

test('serves the default trading+data surface over HTTP and assigns a session id', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  expect(tools.length).toBe(101);
  const names = new Set(tools.map((t) => t.name));
  expect(names.has('alpaca_getAccount')).toBe(true);
  expect(names.has('alpaca_getAllAccounts')).toBe(false); // broker-only
  await client.close();
});

test('dispatches a tool call over HTTP and returns the data as text', async () => {
  const client = await connect(['trading']);
  const result = (await client.callTool({ name: 'alpaca_getAccount', arguments: {} })) as CallToolResult;
  expect(result.isError).toBeFalsy();
  expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ id: 'acct-1' });
  await client.close();
});

test('returns 404 for a path other than /mcp', async () => {
  const port = await listen({ port: 0, hostname: '127.0.0.1' });
  const res = await realFetch(`http://127.0.0.1:${port}/nope`);
  expect(res.status).toBe(404);
});

test('rejects a non-initialize POST without a session id', async () => {
  const port = await listen({ port: 0, hostname: '127.0.0.1' });
  const res = await realFetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error?: { message: string } };
  expect(body.error?.message).toContain('no valid session ID');
});

test('rejects a request with no bearer token when a token is configured', async () => {
  const port = await listen({ port: 0, hostname: '127.0.0.1', token: 's3cret' });
  const res = await realFetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
});

test('rejects a request with the wrong bearer token', async () => {
  const port = await listen({ port: 0, hostname: '127.0.0.1', token: 's3cret' });
  const res = await realFetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer wrong',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  expect(res.status).toBe(401);
});

test('accepts a full MCP session when the correct bearer token is supplied', async () => {
  const client = await connect(['trading'], { token: 's3cret', authHeader: 'Bearer s3cret' });
  const result = (await client.callTool({ name: 'alpaca_getAccount', arguments: {} })) as CallToolResult;
  expect(result.isError).toBeFalsy();
  expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ id: 'acct-1' });
  await client.close();
});
