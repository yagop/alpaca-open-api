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

async function connect(enabledApis: string[] = []): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = buildServer(enabledApis);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

test('registers the full Alpaca surface with object input schemas', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(250);
  const names = new Set(tools.map((t) => t.name));
  expect(names.has('alpaca_getAccount')).toBe(true);
  expect(names.has('alpaca_postOrder')).toBe(true);
  expect(names.has('alpaca_stockLatestQuoteSingle')).toBe(true);
  expect(tools.find((t) => t.name === 'alpaca_getAccount')?.inputSchema.type).toBe('object');
  await client.close();
});

test('ALPACA_MCP_APIS-style filtering registers only the requested API', async () => {
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
