import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpServer } from './http';

// Drives the streamable-http transport over real HTTP with raw `fetch` (the SDK's
// own client transport mis-handles the 202 notification response under Bun). The
// upstream Alpaca `fetch` is stubbed to capture the outgoing request, so a tool
// call exercises the full path (transport -> handler -> generated client -> mutator)
// and proves the per-request header credentials reach the mutator - overriding the
// process env, with no env fallback when they are absent.

const realFetch = globalThis.fetch.bind(globalThis);
let captured: { url: string; headers: Record<string, string> } | undefined;
let server: Server;
let origin: string;

const ACCEPT = 'application/json, text/event-stream';
const callBody = (name: string) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

beforeEach(async () => {
  captured = undefined;
  // Env creds that must NOT leak into a request-scoped call.
  process.env.ALPACA_API_KEY = 'ENV-KEY';
  process.env.ALPACA_API_SECRET = 'ENV-SECRET';
  process.env.ALPACA_ENV = 'live';
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url);
    if (u.includes('127.0.0.1')) return realFetch(url, init); // our own server
    captured = { url: u, headers: { ...((init?.headers as Record<string, string>) ?? {}) } }; // upstream Alpaca
    return new Response(JSON.stringify({ id: 'acct-1' }), { status: 200 });
  }) as typeof fetch;
  server = createHttpServer({ toolsets: ['trading'] });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const k of ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_ENV']) delete process.env[k];
  await new Promise<void>((r) => server.close(() => r()));
});

test('rejects a credential-less request with 401 and never calls upstream', async () => {
  const res = await realFetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT },
    body: callBody('alpaca_getAccount'),
  });
  expect(res.status).toBe(401);
  expect(captured).toBeUndefined();
});

test('passes per-request header credentials through to the upstream Alpaca call', async () => {
  const res = await realFetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      'APCA-API-KEY-ID': 'REQ-KEY',
      'APCA-API-SECRET-KEY': 'REQ-SECRET',
      'X-Alpaca-Env': 'paper',
    },
    body: callBody('alpaca_getAccount'),
  });
  expect(res.status).toBe(200);
  // Request creds + paper host win over the env (ENV-KEY / live).
  expect(captured?.url).toBe('https://paper-api.alpaca.markets/v2/account');
  expect(captured?.headers['APCA-API-KEY-ID']).toBe('REQ-KEY');
  expect(captured?.headers['APCA-API-SECRET-KEY']).toBe('REQ-SECRET');
});

test('forwards an Authorization: Bearer token to the upstream Alpaca call', async () => {
  const res = await realFetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      Authorization: 'Bearer OAUTH-TOKEN',
      'X-Alpaca-Env': 'paper',
    },
    body: callBody('alpaca_getAccount'),
  });
  expect(res.status).toBe(200);
  expect(captured?.url).toBe('https://paper-api.alpaca.markets/v2/account');
  expect(captured?.headers['Authorization']).toBe('Bearer OAUTH-TOKEN');
  expect(captured?.headers['APCA-API-KEY-ID']).toBeUndefined();
});

test('defaults to the live host when X-Alpaca-Env is omitted', async () => {
  await realFetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      'APCA-API-KEY-ID': 'REQ-KEY',
      'APCA-API-SECRET-KEY': 'REQ-SECRET',
    },
    body: callBody('alpaca_getAccount'),
  });
  expect(captured?.url).toBe('https://api.alpaca.markets/v2/account');
});

test('an unknown path returns 404', async () => {
  const res = await realFetch(`${origin}/nope`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      'APCA-API-KEY-ID': 'REQ-KEY',
      'APCA-API-SECRET-KEY': 'REQ-SECRET',
    },
    body: callBody('alpaca_getAccount'),
  });
  expect(res.status).toBe(404);
  expect(captured).toBeUndefined();
});
