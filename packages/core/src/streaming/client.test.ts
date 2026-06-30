import { expect, test } from 'bun:test';
import { StreamClient, type StreamClientOptions } from './client';

// A minimal stand-in for the global `WebSocket` - just enough surface for
// StreamClient (addEventListener/send/close/readyState/binaryType) plus test
// hooks to drive it from the outside. No network, mirrors mutator.test.ts's
// stubbed-fetch approach.
class MockSocket {
  static instances: MockSocket[] = [];
  readyState = 0; // CONNECTING
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
    this.readyState = 3; // CLOSED
    this.fire('close', { code, reason });
  }

  // --- test driver helpers, not part of the real WebSocket API ---
  open(): void {
    this.readyState = 1; // OPEN
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

const dataStreamOptions = (overrides: Partial<StreamClientOptions> = {}): StreamClientOptions => ({
  url: () => 'wss://stream.test/v2/iex',
  auth: () => ({ action: 'auth', key: 'KEY', secret: 'SECRET' }),
  // Frames may be arrays of messages (handleMessage fans them out individually before
  // this runs), so this only ever sees one message at a time.
  isAuthenticated: (m) => (m as any)?.T === 'success' && (m as any)?.msg === 'authenticated',
  WebSocketImpl: MockSocket as unknown as typeof WebSocket,
  ...overrides,
});

test('connects, authenticates, and emits decoded messages + iterates them', async () => {
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions());
  const opened: unknown[] = [];
  const authed: unknown[] = [];
  const messages: unknown[] = [];
  client.on('open', () => opened.push(true));
  client.on('authenticated', () => authed.push(true));
  client.on('message', (m) => messages.push(m));

  client.connect();
  const socket = lastSocket();
  socket.open();
  expect(opened).toHaveLength(1);
  expect(JSON.parse(socket.sent[0] as string)).toEqual({ action: 'auth', key: 'KEY', secret: 'SECRET' });

  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  expect(authed).toHaveLength(1);
  expect(client.state).toBe('open');

  socket.message(JSON.stringify([{ T: 't', S: 'AAPL', p: 100.5 }]));
  expect(messages).toEqual([{ T: 't', S: 'AAPL', p: 100.5 }]);

  // The iterator drains the backlog first (the 't' message above, queued before
  // anyone was pulling), then yields newly arriving messages as they come in.
  const iterator = client[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ value: { T: 't', S: 'AAPL', p: 100.5 }, done: false });
  socket.message(JSON.stringify([{ T: 'q', S: 'AAPL' }]));
  expect(await iterator.next()).toEqual({ value: { T: 'q', S: 'AAPL' }, done: false });
});

test('subscribe sends immediately and unsubscribe forgets it', () => {
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions());
  client.connect();
  const socket = lastSocket();
  socket.open();
  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));

  client.subscribe('trades', { action: 'subscribe', trades: ['AAPL'] });
  expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ action: 'subscribe', trades: ['AAPL'] });

  client.unsubscribe('trades', { action: 'unsubscribe', trades: ['AAPL'] });
  expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ action: 'unsubscribe', trades: ['AAPL'] });
});

test('reconnects with backoff and replays tracked subscriptions, but not the unsubscribed one', () => {
  MockSocket.instances = [];
  const reconnecting: Array<{ attempt: number; delayMs: number }> = [];
  const client = new StreamClient(dataStreamOptions({ reconnect: { initialDelayMs: 1, maxDelayMs: 4, factor: 2 } }));
  client.on('reconnecting', (e) => reconnecting.push(e));

  client.connect();
  let socket = lastSocket();
  socket.open();
  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  client.subscribe('trades', { action: 'subscribe', trades: ['AAPL'] });
  client.subscribe('quotes', { action: 'subscribe', quotes: ['MSFT'] });
  client.unsubscribe('quotes', { action: 'unsubscribe', quotes: ['MSFT'] });

  // Connection drops unexpectedly (not via client.close()) - should auto-reconnect.
  socket.close(1006, 'abnormal');
  expect(reconnecting).toEqual([{ attempt: 1, delayMs: 1 }]);

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      expect(MockSocket.instances).toHaveLength(2);
      socket = lastSocket();
      socket.open();
      socket.sent = []; // clear the resent auth message
      socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
      const replayed = socket.sent.map((m) => JSON.parse(m as string));
      expect(replayed).toEqual([{ action: 'subscribe', trades: ['AAPL'] }]);
      resolve();
    }, 5);
  });
});

test('idle timeout forces a reconnect when no frames arrive', () => {
  MockSocket.instances = [];
  const errors: Error[] = [];
  const client = new StreamClient(dataStreamOptions({ idleTimeoutMs: 5, reconnect: { initialDelayMs: 1 } }));
  client.on('error', (e) => errors.push(e));
  client.connect();
  const socket = lastSocket();
  socket.open();

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      expect(errors[0]?.message).toMatch(/idle timeout/);
      expect(socket.readyState).toBe(3); // forced closed by the idle timer
      resolve();
    }, 10);
  });
});

test('close() is clean - no reconnect, terminal close event, async iterator ends', async () => {
  MockSocket.instances = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const reconnects: unknown[] = [];
  const client = new StreamClient(dataStreamOptions());
  client.on('close', (e) => closes.push(e));
  client.on('reconnecting', (e) => reconnects.push(e));
  client.connect();
  const socket = lastSocket();
  socket.open();

  const iterator = client[Symbol.asyncIterator]();
  const pending = iterator.next();
  client.close(1000, 'bye');
  expect(socket.readyState).toBe(3);
  expect(closes).toEqual([{ code: 1000, reason: 'bye' }]);
  expect(reconnects).toHaveLength(0);
  expect(await pending).toEqual({ value: undefined, done: true });
  expect(MockSocket.instances).toHaveLength(1); // never reconnected
});

test('send() throws when the socket is not open', () => {
  const client = new StreamClient(dataStreamOptions());
  expect(() => client.send({ action: 'noop' })).toThrow('stream socket is not open');
});

test('a binary frame with no decode() configured raises an error event', () => {
  MockSocket.instances = [];
  const errors: Error[] = [];
  const client = new StreamClient(dataStreamOptions());
  client.on('error', (e) => errors.push(e));
  client.connect();
  const socket = lastSocket();
  socket.open();
  socket.message(new ArrayBuffer(4));
  expect(errors[0]?.message).toMatch(/binary frame received but no decode/);
});
