import { afterEach, beforeEach, expect, test } from 'bun:test';
import { makeMutator } from './mutator';
import { reqCtx } from './request-context';

// The mutator is the single HTTP layer behind every generated client (MCP tools
// and the library's fetch clients). These tests stub `fetch` to capture the
// outgoing request and assert per-API host + auth - no network, no real creds.

type Captured = { url: string; method?: string; headers: Record<string, string>; body?: any };
let captured: Captured | undefined;
let respond: () => Response;
const realFetch = globalThis.fetch;
const ENV_KEYS = ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_ENV', 'ALPACA_PAPER', 'ALPACA_TRADING_URL', 'ALPACA_BROKER_URL'] as const;

beforeEach(() => {
  captured = undefined;
  respond = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  process.env.ALPACA_API_KEY = 'KEY';
  process.env.ALPACA_API_SECRET = 'SECRET';
  process.env.ALPACA_ENV = 'paper';
  delete process.env.ALPACA_PAPER; // ignore the workspace .env's legacy paper flag
  delete process.env.ALPACA_TRADING_URL;
  delete process.env.ALPACA_BROKER_URL;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    captured = {
      url: String(input),
      method: init?.method,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: init?.body,
    };
    return respond();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) delete process.env[k];
});

test('trading (paper) targets the paper host with APCA headers and returns { status, data, headers }', async () => {
  const result = await makeMutator('trading')<{ status: number; data: unknown; headers: Headers }>('/v2/account', { method: 'GET' });
  expect(captured?.url).toBe('https://paper-api.alpaca.markets/v2/account');
  expect(captured?.headers['APCA-API-KEY-ID']).toBe('KEY');
  expect(captured?.headers['APCA-API-SECRET-KEY']).toBe('SECRET');
  expect(result.status).toBe(200);
  expect(result.data).toEqual({ ok: true });
  expect(result.headers).toBeInstanceOf(Headers);
});

test('trading (live) targets the live host', async () => {
  process.env.ALPACA_ENV = 'live';
  await makeMutator('trading')('/v2/account', { method: 'GET' });
  expect(captured?.url).toBe('https://api.alpaca.markets/v2/account');
});

test('defaults to the live host when ALPACA_ENV is unset', async () => {
  delete process.env.ALPACA_ENV;
  await makeMutator('trading')('/v2/account', { method: 'GET' });
  expect(captured?.url).toBe('https://api.alpaca.markets/v2/account');
});

test('data uses the live data host regardless of paper', async () => {
  await makeMutator('data')('/v2/stocks/quotes/latest?symbols=AAPL', { method: 'GET' });
  expect(captured?.url).toBe('https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=AAPL');
});

test('broker uses the sandbox host with HTTP Basic auth', async () => {
  await makeMutator('broker')('/v1/accounts', { method: 'GET' });
  expect(captured?.url).toBe('https://broker-api.sandbox.alpaca.markets/v1/accounts');
  expect(captured?.headers['Authorization']).toBe(`Basic ${Buffer.from('KEY:SECRET').toString('base64')}`);
  expect(captured?.headers['APCA-API-KEY-ID']).toBeUndefined();
});

test('authx uses the sandbox host and adds no key/basic headers (form body carries creds)', async () => {
  await makeMutator('authx')('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  expect(captured?.url).toBe('https://authx.sandbox.alpaca.markets/v1/oauth/token');
  expect(captured?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  expect(captured?.headers['APCA-API-KEY-ID']).toBeUndefined();
  expect(captured?.headers['Authorization']).toBeUndefined();
});

test('a per-API base URL override wins over the routing table', async () => {
  process.env.ALPACA_BROKER_URL = 'https://broker.internal.test';
  await makeMutator('broker')('/v1/accounts', { method: 'GET' });
  expect(captured?.url).toBe('https://broker.internal.test/v1/accounts');
});

test('an empty (204) response yields undefined data', async () => {
  respond = () => new Response(null, { status: 204 });
  const result = await makeMutator('trading')<{ status: number; data: unknown }>('/v2/orders/o-1', { method: 'DELETE' });
  expect(result.status).toBe(204);
  expect(result.data).toBeUndefined();
});

test('passes the response headers through (the generated contracts type them)', async () => {
  respond = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'x-ratelimit-remaining': '42' } });
  const result = await makeMutator('trading')<{ headers: Headers }>('/v2/account', { method: 'GET' });
  expect(result.headers).toBeInstanceOf(Headers);
  expect(result.headers.get('x-ratelimit-remaining')).toBe('42');
});

test('an unknown api throws', async () => {
  await expect(makeMutator('nope')('/x', { method: 'GET' })).rejects.toThrow('Unknown API: nope');
});

// Remote (HTTP) mode: credentials + environment come from the per-request `reqCtx`
// store, not the process env. The store wins and there is no env fallback within it.

test('per-request creds from reqCtx win over env (key/secret and paper host)', async () => {
  // Env points at live with KEY/SECRET; the request store must override both.
  process.env.ALPACA_ENV = 'live';
  await reqCtx.run({ key: 'REQ-KEY', secret: 'REQ-SECRET', env: 'paper' }, async () => {
    await makeMutator('trading')('/v2/account', { method: 'GET' });
  });
  expect(captured?.url).toBe('https://paper-api.alpaca.markets/v2/account');
  expect(captured?.headers['APCA-API-KEY-ID']).toBe('REQ-KEY');
  expect(captured?.headers['APCA-API-SECRET-KEY']).toBe('REQ-SECRET');
});

test('per-request env=live selects the live host (broker basic auth from store creds)', async () => {
  // Without a store, broker resolves to the sandbox host; the store's env drives it.
  await reqCtx.run({ key: 'REQ-KEY', secret: 'REQ-SECRET', env: 'live' }, async () => {
    await makeMutator('broker')('/v1/accounts', { method: 'GET' });
  });
  expect(captured?.url).toBe('https://broker-api.alpaca.markets/v1/accounts');
  expect(captured?.headers['Authorization']).toBe(`Basic ${Buffer.from('REQ-KEY:REQ-SECRET').toString('base64')}`);
});

test('falls back to the process env when no reqCtx store is set', async () => {
  process.env.ALPACA_ENV = 'paper';
  await makeMutator('trading')('/v2/account', { method: 'GET' });
  expect(captured?.url).toBe('https://paper-api.alpaca.markets/v2/account');
  expect(captured?.headers['APCA-API-KEY-ID']).toBe('KEY');
});
