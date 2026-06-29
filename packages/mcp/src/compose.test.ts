import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from './compose';

// Drives the composed server through a real MCP client over an in-memory
// transport. `fetch` is stubbed so a tool call exercises the full path
// (handler -> generated client -> mutator -> fetch) without network or creds.
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.ALPACA_API_KEY = 'KEY';
  process.env.ALPACA_API_SECRET = 'SECRET';
  process.env.ALPACA_ENV = 'paper';
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) =>
    new Response(JSON.stringify({ id: 'acct-1' }), { status: 200 })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function connect(enabledToolsets?: string[]): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = buildServer(enabledToolsets);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

test('registers trading and data toolsets by default with object input schemas', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  expect(tools.length).toBe(118);
  const names = new Set(tools.map((t) => t.name));
  expect(names.has('alpaca_getAccount')).toBe(true);
  expect(names.has('alpaca_postOrder')).toBe(true);
  expect(names.has('alpaca_stockLatestQuoteSingle')).toBe(true);
  expect(names.has('alpaca_getAllAccounts')).toBe(false); // broker-only
  expect(names.has('alpaca_issueTokens')).toBe(false); // authx-only
  expect(tools.find((t) => t.name === 'alpaca_getAccount')?.inputSchema.type).toBe('object');
  await client.close();
});

test('explicitly registering all toolsets exposes the full Alpaca surface', async () => {
  const client = await connect(['trading', 'data', 'broker', 'authx']);
  const { tools } = await client.listTools();
  expect(tools.length).toBe(273);
  const names = new Set(tools.map((t) => t.name));
  expect(names.has('alpaca_getAccount')).toBe(true);
  expect(names.has('alpaca_stockLatestQuoteSingle')).toBe(true);
  expect(names.has('alpaca_getAllAccounts')).toBe(true);
  expect(names.has('alpaca_issueTokens')).toBe(true);
  await client.close();
});

test('ALPACA_TOOLSETS-style filtering registers only the requested toolset', async () => {
  const client = await connect(['trading']);
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain('alpaca_getAccount');
  expect(names.some((n) => n === 'alpaca_stockLatestQuoteSingle')).toBe(false); // a data-only tool
  await client.close();
});

test('dispatches a valid call through the mutator and returns the data as text', async () => {
  const client = await connect(['trading']);
  const result = (await client.callTool({ name: 'alpaca_getAccount', arguments: {} })) as CallToolResult;
  expect(result.isError).toBeFalsy();
  const block = result.content[0];
  expect(block?.type).toBe('text');
  expect(JSON.parse((block as { text: string }).text)).toEqual({ id: 'acct-1' });
  await client.close();
});

test('a query+body operation routes the query to the URL and the body to the request body (not swapped)', async () => {
  // Regression guard for the Orval MCP arg-order bug fixed in postgen.ts:
  // addAssetToWatchlistByName's client signature is (queryParams, body), but the
  // template emitted them swapped, so `?name=...` and `{ symbol }` were reversed.
  // Capture the outgoing request and assert the wire shape end-to-end.
  let captured: { url: string; body?: string } | undefined;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    captured = { url: String(input), body: init?.body == null ? undefined : String(init.body) };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const client = await connect(['trading']);
  const result = (await client.callTool({
    name: 'alpaca_addAssetToWatchlistByName',
    arguments: { queryParams: { name: 'tech' }, bodyParams: { symbol: 'AAPL' } },
  })) as CallToolResult;

  expect(result.isError).toBeFalsy();
  expect(captured?.url).toBe('https://paper-api.alpaca.markets/v2/watchlists:by_name?name=tech');
  expect(captured?.body).toBe(JSON.stringify({ symbol: 'AAPL' }));
  await client.close();
});

test('rejects arguments that fail the generated Zod schema', async () => {
  const client = await connect(['trading']);
  // getOrderByOrderID requires pathParams.order_id; omit it.
  let rejected = false;
  try {
    const result = (await client.callTool({ name: 'alpaca_getOrderByOrderID', arguments: {} })) as CallToolResult;
    rejected = result.isError === true;
  } catch {
    rejected = true; // SDK rejects invalid params with a JSON-RPC error
  }
  expect(rejected).toBe(true);
  await client.close();
});
