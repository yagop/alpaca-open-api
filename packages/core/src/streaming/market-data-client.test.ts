import { expect, test } from 'bun:test';
import { cryptoDataStream, newsDataStream, optionDataStream, stockDataStream } from './market-data-client';

// Same MockSocket shape as client.test.ts/trading-client.test.ts - no network.
class MockSocket {
  static instances: MockSocket[] = [];
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  sent: unknown[] = [];
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(public url: string) {
    MockSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.fire('open', {});
  }

  message(data: unknown): void {
    this.fire('message', { data });
  }

  private fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function lastSocket(): MockSocket {
  return MockSocket.instances[MockSocket.instances.length - 1]!;
}

const json = (sent: unknown) => JSON.parse(sent as string);

function connectAndAuth(socketFactory: () => void): MockSocket {
  socketFactory();
  const socket = lastSocket();
  socket.open();
  socket.message(JSON.stringify([{ T: 'success', msg: 'connected' }]));
  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  return socket;
}

test('stock stream: connects to the iex feed by default, authenticates, ignores the "connected" greeting', () => {
  MockSocket.instances = [];
  const events: string[] = [];
  const client = stockDataStream({ apiKey: 'KEY', apiSecret: 'SECRET', WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  client.on('open', () => events.push('open'));
  client.on('authenticated', () => events.push('authenticated'));
  client.on('message', () => events.push('message'));

  const socket = connectAndAuth(() => client.connect());
  expect(socket.url).toBe('wss://stream.data.alpaca.markets/v2/iex');
  expect(json(socket.sent[0])).toEqual({ action: 'auth', key: 'KEY', secret: 'SECRET' });
  expect(events).toEqual(['open', 'authenticated']); // the "connected" greeting produced no event
});

test('subscribe sends immediately, merges across calls, and replays the merged state on reconnect', () => {
  MockSocket.instances = [];
  const client = stockDataStream({ reconnect: { initialDelayMs: 1 }, WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  let socket = connectAndAuth(() => client.connect());

  client.subscribe({ trades: ['AAPL'] });
  client.subscribe({ quotes: ['MSFT'] });
  expect(json(socket.sent.at(-1))).toEqual({ action: 'subscribe', quotes: ['MSFT'] });

  client.unsubscribe({ trades: ['AAPL'] });
  expect(json(socket.sent.at(-1))).toEqual({ action: 'unsubscribe', trades: ['AAPL'] });

  socket.close(1006, 'abnormal');
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      expect(MockSocket.instances).toHaveLength(2);
      socket = lastSocket();
      socket.open();
      socket.message(JSON.stringify([{ T: 'success', msg: 'connected' }]));
      socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
      // Only the still-desired 'quotes' subscription is replayed - 'trades' was unsubscribed.
      expect(json(socket.sent.at(-1))).toEqual({ action: 'subscribe', quotes: ['MSFT'] });
      resolve();
    }, 5);
  });
});

test('typed trade/quote/bar messages are emitted and iterable; subscription acks and stream errors are surfaced separately', async () => {
  MockSocket.instances = [];
  const messages: unknown[] = [];
  const acks: unknown[] = [];
  const errors: Error[] = [];
  const client = stockDataStream({ WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  client.on('message', (m) => messages.push(m));
  client.on('subscription', (a) => acks.push(a));
  client.on('error', (e) => errors.push(e));
  const socket = connectAndAuth(() => client.connect());

  socket.message(JSON.stringify([{ T: 'subscription', trades: ['AAPL'] }]));
  socket.message(JSON.stringify([{ T: 't', S: 'AAPL', p: 150.25, s: 100, t: '2024-01-01T00:00:00Z', c: [], i: 1, x: 'V', z: 'A' }]));
  socket.message(JSON.stringify([{ T: 'error', code: 405, msg: 'symbol limit exceeded' }]));

  expect(acks).toEqual([{ T: 'subscription', trades: ['AAPL'] }]);
  expect(messages).toHaveLength(1);
  expect((messages[0] as { S: string }).S).toBe('AAPL');
  expect(errors[0]?.message).toBe('market data stream: symbol limit exceeded (code 405)');

  // The iterator drains the backlog first (the 't' message above, queued before anyone
  // was pulling), then yields newly arriving messages as they come in.
  const iterator = client[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ T: 't', S: 'AAPL' });
  socket.message(JSON.stringify([{ T: 'q', S: 'AAPL', bp: 150, bs: 1, ax: 'V', ap: 150.5, as: 1, bx: 'V', c: [], t: '2024-01-01T00:00:00Z', z: 'A' }]));
  expect((await iterator.next()).value).toMatchObject({ T: 'q', S: 'AAPL' });
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
