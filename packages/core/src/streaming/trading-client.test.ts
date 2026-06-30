import { expect, test } from 'bun:test';
import { lastSocket, MockSocket } from './mock-socket';
import { TradingStreamClient, type TradeUpdate, type TradingStreamEvent } from './trading-client';

// The trading stream sends JSON as binary frames by default (see trading-client.ts's
// module doc) - so frames here are UTF-8-encoded JSON text wrapped in an ArrayBuffer,
// not text frames and not msgpack.
const jsonFrame = (value: unknown): ArrayBuffer => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const authorizationFrame = (status: 'authorized' | 'unauthorized') =>
  jsonFrame({ stream: 'authorization', data: { status, action: 'authenticate' } });

const listeningFrame = () => jsonFrame({ stream: 'listening', data: { streams: ['trade_updates'] } });

const tradeUpdateFrame = (event: string) =>
  jsonFrame({ stream: 'trade_updates', data: { event, price: '100.5', order: { id: 'o-1', status: 'filled' } } });

function connectAndAuth(client: TradingStreamClient): MockSocket {
  client.connect();
  const socket = lastSocket();
  socket.open();
  socket.message(authorizationFrame('authorized'));
  return socket;
}

/** Drains events from a client's async iterator until `n` have been collected, or it ends. */
async function collect(client: TradingStreamClient, n: number): Promise<TradingStreamEvent[]> {
  const out: TradingStreamEvent[] = [];
  for await (const event of client) {
    out.push(event);
    if (out.length >= n) break;
  }
  return out;
}

test('authenticates with key/secret, listens to trade_updates once, and yields typed events', async () => {
  MockSocket.instances = [];
  const client = new TradingStreamClient({ apiKey: 'KEY', apiSecret: 'SECRET', WebSocketImpl: MockSocket as unknown as typeof WebSocket });

  const socket = connectAndAuth(client);
  const [open, authenticated] = await collect(client, 2);
  expect(open).toEqual({ type: 'open' });
  expect(authenticated).toEqual({ type: 'authenticated' });
  // Auth message is JSON even though the stream itself is binary.
  expect(JSON.parse(socket.sent[0] as string)).toEqual({ action: 'auth', key: 'KEY', secret: 'SECRET' });
  expect(JSON.parse(socket.sent[1] as string)).toEqual({ action: 'listen', data: { streams: ['trade_updates'] } });
  expect(socket.sent).toHaveLength(2); // exactly one auth + one listen - no duplicate

  socket.message(listeningFrame()); // ack - no event surfaced
  socket.message(tradeUpdateFrame('fill'));
  const [update] = await collect(client, 1);
  expect(update).toEqual({ type: 'trade_update', update: { event: 'fill', price: '100.5', order: { id: 'o-1', status: 'filled' } } as TradeUpdate });
});

test('falls back to ALPACA_API_KEY/SECRET env vars when no options are given', () => {
  MockSocket.instances = [];
  process.env.ALPACA_API_KEY = 'ENV_KEY';
  process.env.ALPACA_API_SECRET = 'ENV_SECRET';
  try {
    const client = new TradingStreamClient({ WebSocketImpl: MockSocket as unknown as typeof WebSocket });
    client.connect();
    const socket = lastSocket();
    socket.open();
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ action: 'auth', key: 'ENV_KEY', secret: 'ENV_SECRET' });
  } finally {
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;
  }
});

test('unauthorized auth yields an error and ends the stream instead of retrying forever with the same bad creds', async () => {
  MockSocket.instances = [];
  const client = new TradingStreamClient({ apiKey: 'BAD', apiSecret: 'BAD', WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  client.connect();
  const socket = lastSocket();
  socket.open();
  socket.message(authorizationFrame('unauthorized'));

  const iterator = client[Symbol.asyncIterator]();
  await iterator.next(); // 'open'
  const errorResult = await iterator.next();
  expect(errorResult.done).toBe(false);
  const event = errorResult.value as Extract<TradingStreamEvent, { type: 'error' }>;
  expect(event.type).toBe('error');
  expect(event.error.message).toMatch(/unauthorized/);

  expect(await iterator.next()).toEqual({ value: undefined, done: true }); // stream ends - no infinite retry loop
});

test('async iterates trade updates in order', async () => {
  MockSocket.instances = [];
  const client = new TradingStreamClient({ apiKey: 'KEY', apiSecret: 'SECRET', WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  const socket = connectAndAuth(client);
  await collect(client, 2); // open + authenticated
  socket.message(tradeUpdateFrame('new'));
  const [update] = await collect(client, 1);
  expect((update as Extract<TradingStreamEvent, { type: 'trade_update' }>).update.event).toBe('new');
});

test('re-listens automatically after a reconnect, exactly once (no duplicate listen)', async () => {
  MockSocket.instances = [];
  const client = new TradingStreamClient({
    apiKey: 'KEY',
    apiSecret: 'SECRET',
    reconnect: { initialDelayMs: 1 },
    WebSocketImpl: MockSocket as unknown as typeof WebSocket,
  });
  const socket = connectAndAuth(client);
  await collect(client, 2); // open + authenticated

  socket.close(1006, 'abnormal');
  await collect(client, 1); // 'reconnecting'

  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(MockSocket.instances).toHaveLength(2);
  const next = lastSocket();
  next.open();
  next.message(authorizationFrame('authorized'));
  await collect(client, 2); // open + authenticated (on the new connection)
  expect(next.sent.map((m) => JSON.parse(m as string))).toEqual([
    { action: 'auth', key: 'KEY', secret: 'SECRET' },
    { action: 'listen', data: { streams: ['trade_updates'] } },
  ]);
});

// Golden payload from a real paper-account fill (a 1-share AAPL buy, captured live), trimmed to
// the order fields that matter here. Regression: `event_id` was missing from `TradeUpdate`
// entirely, and `at`/`settle_date` were undocumented in this codebase before this capture - all
// three are present on every real event, not just fills.
test('a real fill event\'s full field set (event_id, at, settle_date, ...) decodes as TradeUpdate', async () => {
  MockSocket.instances = [];
  const client = new TradingStreamClient({ apiKey: 'KEY', apiSecret: 'SECRET', WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  const socket = connectAndAuth(client);
  await collect(client, 2); // open + authenticated

  const fill = {
    event: 'fill',
    event_id: '01KWD8DCH5VMM1428KJREJK2GS',
    at: '2026-06-30T21:54:22.740534Z',
    timestamp: '2026-06-30T21:54:22.882534878Z',
    price: '289.13',
    qty: '1',
    position_qty: '3',
    execution_id: '31c5a793-576e-4e4c-9f3f-36cd636c8aeb',
    settle_date: '2026-07-01',
    order: {
      id: '9e9ef395-90df-4252-a5b6-05eba5ef0446',
      symbol: 'AAPL',
      side: 'buy',
      status: 'filled',
      filled_avg_price: '289.13',
      notional: null,
      time_in_force: 'day',
      type: 'limit',
    },
  } satisfies TradeUpdate;
  socket.message(jsonFrame({ stream: 'trade_updates', data: fill }));

  const [update] = await collect(client, 1);
  expect((update as Extract<TradingStreamEvent, { type: 'trade_update' }>).update).toEqual(fill);
});
