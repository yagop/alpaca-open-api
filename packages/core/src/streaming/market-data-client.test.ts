import { expect, test } from 'bun:test';
import {
  cryptoDataStream,
  type CryptoMessage,
  type CryptoOrderbookMessage,
  type MarketDataStreamEvent,
  newsDataStream,
  optionDataStream,
  type StockCancelErrorMessage,
  type StockCorrectionMessage,
  type StockLuldMessage,
  type StockMessage,
  type StockStatusMessage,
  stockDataStream,
} from './market-data-client';
import { lastSocket, MockSocket } from './mock-socket';
import { decode, encode } from './msgpack';

const json = (sent: unknown) => JSON.parse(sent as string);

function connectAndAuth(socketFactory: () => void): MockSocket {
  socketFactory();
  const socket = lastSocket();
  socket.open();
  socket.message(JSON.stringify([{ T: 'success', msg: 'connected' }]));
  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  return socket;
}

/** Drains events from a client's async iterator until `n` have been collected, or it ends. */
async function collect<T>(client: AsyncIterable<MarketDataStreamEvent<T>>, n: number): Promise<MarketDataStreamEvent<T>[]> {
  const out: MarketDataStreamEvent<T>[] = [];
  for await (const event of client) {
    out.push(event);
    if (out.length >= n) break;
  }
  return out;
}

test('stock stream: connects to the iex feed by default, authenticates, ignores the "connected" greeting', async () => {
  MockSocket.instances = [];
  const client = stockDataStream({ apiKey: 'KEY', apiSecret: 'SECRET', WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  const socket = connectAndAuth(() => client.connect());
  expect(socket.url).toBe('wss://stream.data.alpaca.markets/v2/iex');
  expect(json(socket.sent[0])).toEqual({ action: 'auth', key: 'KEY', secret: 'SECRET' });

  const events = await collect(client, 2); // the "connected" greeting produced no event of its own
  expect(events).toEqual([{ type: 'open' }, { type: 'authenticated' }]);
});

test('subscribe sends only the incremental channels, merges across calls, and replays the merged state on reconnect', async () => {
  MockSocket.instances = [];
  const client = stockDataStream({ reconnect: { initialDelayMs: 1 }, WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  let socket = connectAndAuth(() => client.connect());
  await collect(client, 2); // open + authenticated

  client.subscribe({ trades: ['AAPL'] });
  client.subscribe({ quotes: ['MSFT'] });
  expect(json(socket.sent.at(-1))).toEqual({ action: 'subscribe', quotes: ['MSFT'] });

  client.unsubscribe({ trades: ['AAPL'] });
  expect(json(socket.sent.at(-1))).toEqual({ action: 'unsubscribe', trades: ['AAPL'] });
  // auth, subscribe(trades), subscribe(quotes), unsubscribe(trades) - one send per call, never duplicated.
  expect(socket.sent).toHaveLength(4);

  socket.close(1006, 'abnormal');
  await collect(client, 1); // 'reconnecting'

  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(MockSocket.instances).toHaveLength(2);
  socket = lastSocket();
  socket.open();
  socket.message(JSON.stringify([{ T: 'success', msg: 'connected' }]));
  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  await collect(client, 2); // open + authenticated, on the new connection
  // Only the still-desired 'quotes' subscription is replayed - 'trades' was unsubscribed - and it's
  // the one merged auto-replay send (auth + one subscribe), not also re-sent by subscribe()/unsubscribe().
  expect(socket.sent).toHaveLength(2);
  expect(json(socket.sent.at(-1))).toEqual({ action: 'subscribe', quotes: ['MSFT'] });
});

test('unsubscribing everything stops replaying on the next reconnect', async () => {
  MockSocket.instances = [];
  const client = stockDataStream({ reconnect: { initialDelayMs: 1 }, WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  let socket = connectAndAuth(() => client.connect());
  await collect(client, 2);

  client.subscribe({ trades: ['AAPL'] });
  client.unsubscribe({ trades: ['AAPL'] });

  socket.close(1006, 'abnormal');
  await collect(client, 1); // 'reconnecting'
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  socket = lastSocket();
  socket.open();
  socket.message(JSON.stringify([{ T: 'success', msg: 'connected' }]));
  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  await collect(client, 2);
  // Only the auth message - nothing left to replay.
  expect(socket.sent).toHaveLength(1);
});

test('typed trade/quote/bar messages are yielded and iterable; subscription acks and stream errors are separate event types', async () => {
  MockSocket.instances = [];
  const client = stockDataStream({ WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  const socket = connectAndAuth(() => client.connect());
  await collect(client, 2); // open + authenticated

  socket.message(JSON.stringify([{ T: 'subscription', trades: ['AAPL'] }]));
  socket.message(JSON.stringify([{ T: 't', S: 'AAPL', p: 150.25, s: 100, t: '2024-01-01T00:00:00Z', c: [], i: 1, x: 'V', z: 'A' }]));
  socket.message(JSON.stringify([{ T: 'error', code: 405, msg: 'symbol limit exceeded' }]));

  const [ack, message, error] = await collect(client, 3);
  expect(ack).toEqual({ type: 'subscription', ack: { T: 'subscription', trades: ['AAPL'] } });
  expect((message as Extract<MarketDataStreamEvent<StockMessage>, { type: 'message' }>).message.S).toBe('AAPL');
  expect((error as Extract<MarketDataStreamEvent<StockMessage>, { type: 'error' }>).error.message).toBe('market data stream: symbol limit exceeded (code 405)');

  socket.message(JSON.stringify([{ T: 'q', S: 'AAPL', bp: 150, bs: 1, ax: 'V', ap: 150.5, as: 1, bx: 'V', c: [], t: '2024-01-01T00:00:00Z', z: 'A' }]));
  const [quote] = await collect(client, 1);
  expect((quote as Extract<MarketDataStreamEvent<StockMessage>, { type: 'message' }>).message).toMatchObject({ T: 'q', S: 'AAPL' });
});

// Golden payloads straight from https://docs.alpaca.markets/docs/real-time-stock-pricing-data
// and https://docs.alpaca.markets/docs/real-time-crypto-pricing-data - status/LULD/correction/
// cancel-error (stock-only) and orderbook (crypto-only) have no REST equivalent to compare
// against, so these anchor the hand-written types directly to the documented wire shape.

test('typed stock status, LULD, correction, and cancel/error events flow through as plain messages', async () => {
  MockSocket.instances = [];
  const client = stockDataStream({ WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  const socket = connectAndAuth(() => client.connect());
  await collect(client, 2); // open + authenticated

  const status: StockStatusMessage = { T: 's', S: 'AAPL', sc: 'H', sm: 'Trading Halt', rc: 'T12', rm: 'Trading Halted; For information requested by NASDAQ', t: '2021-02-22T19:15:00Z', z: 'C' };
  const luld: StockLuldMessage = { T: 'l', S: 'IONM', u: 3.24, d: 2.65, i: 'B', t: '2023-04-06T13:34:45.565004401Z', z: 'C' };
  const correction: StockCorrectionMessage = {
    T: 'c',
    S: 'EEM',
    x: 'M',
    oi: 52983525033527,
    op: 39.1582,
    os: 440000,
    oc: [' ', '7'],
    ci: 52983525034326,
    cp: 39.1809,
    cs: 440000,
    cc: [' ', '7'],
    z: 'B',
    t: '2023-04-06T14:25:06.542305024Z',
  };
  const cancelError: StockCancelErrorMessage = { T: 'x', S: 'GOOGL', i: 465, x: 'D', p: 105.31, s: 300, a: 'C', z: 'C', t: '2023-04-06T13:15:42.83540958Z' };
  socket.message(JSON.stringify([status]));
  socket.message(JSON.stringify([luld]));
  socket.message(JSON.stringify([correction]));
  socket.message(JSON.stringify([cancelError]));

  const events = await collect(client, 4);
  expect(events.map((e) => (e as Extract<MarketDataStreamEvent<StockMessage>, { type: 'message' }>).message)).toEqual([status, luld, correction, cancelError]);
});

test('typed crypto orderbook events flow through as plain messages', async () => {
  MockSocket.instances = [];
  const client = cryptoDataStream({ WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  const socket = connectAndAuth(() => client.connect());
  await collect(client, 2);

  const orderbook: CryptoOrderbookMessage = { T: 'o', S: 'BTC/USD', t: '2024-03-12T10:38:50.79613221Z', b: [{ p: 71859.53, s: 0.27994 }], a: [{ p: 71939.7, s: 0.83953 }], r: true };
  socket.message(JSON.stringify([orderbook]));

  const [event] = await collect(client, 1);
  expect((event as Extract<MarketDataStreamEvent<CryptoMessage>, { type: 'message' }>).message).toEqual(orderbook);
});

test('authenticates over the option feed using real MessagePack both ways (unlike stocks/crypto/news, which are JSON)', async () => {
  // Regression: confirmed against the real API that the option data stream rejects a JSON-text
  // auth message outright (`{T:"error",code:400,msg:"invalid syntax"}`) and requires real
  // MessagePack in both directions - the only stream that does (the trading stream sends JSON
  // as binary-opcode frames, which is different and already handled by the base client's
  // default decode). `optionDataStream()` must wire up the msgpack codec itself.
  MockSocket.instances = [];
  const client = optionDataStream({ apiKey: 'KEY', apiSecret: 'SECRET', WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  client.connect();
  const socket = lastSocket();
  socket.open();

  expect(decode(socket.sent[0] as Uint8Array)).toEqual({ action: 'auth', key: 'KEY', secret: 'SECRET' });

  const msgpackFrame = (value: unknown) => encode(value).buffer;
  socket.message(msgpackFrame([{ T: 'success', msg: 'connected' }]));
  socket.message(msgpackFrame([{ T: 'success', msg: 'authenticated' }]));

  const events = await collect(client, 2);
  expect(events).toEqual([{ type: 'open' }, { type: 'authenticated' }]);

  client.subscribe({ trades: ['AAPL260116C00150000'] });
  expect(decode(socket.sent.at(-1) as Uint8Array)).toEqual({ action: 'subscribe', trades: ['AAPL260116C00150000'] });
});

test('crypto/option/news factories target the right hosts', () => {
  MockSocket.instances = [];
  cryptoDataStream({ WebSocketImpl: MockSocket as unknown as typeof WebSocket }).connect();
  expect(lastSocket().url).toBe('wss://stream.data.alpaca.markets/v1beta3/crypto/us');

  optionDataStream({ WebSocketImpl: MockSocket as unknown as typeof WebSocket }).connect();
  expect(lastSocket().url).toBe('wss://stream.data.alpaca.markets/v1beta1/indicative');

  newsDataStream({ WebSocketImpl: MockSocket as unknown as typeof WebSocket }).connect();
  expect(lastSocket().url).toBe('wss://stream.data.alpaca.markets/v1beta1/news');
});
