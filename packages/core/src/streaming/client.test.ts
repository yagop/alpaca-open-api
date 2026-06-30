import { expect, test } from 'bun:test';
import { AsyncQueue, StreamClient, type StreamClientOptions, type StreamEvent } from './client';
import { lastSocket, MockSocket, tick } from './mock-socket';

const dataStreamOptions = (overrides: Partial<StreamClientOptions> = {}): StreamClientOptions => ({
  url: () => 'wss://stream.test/v2/iex',
  auth: () => ({ action: 'auth', key: 'KEY', secret: 'SECRET' }),
  // Frames may be arrays of messages (handleMessage fans them out individually before
  // this runs), so this only ever sees one message at a time.
  isAuthenticated: (m) => (m as any)?.T === 'success' && (m as any)?.msg === 'authenticated',
  WebSocketImpl: MockSocket as unknown as typeof WebSocket,
  ...overrides,
});

/** Drains events from a client's async iterator until `n` have been collected, or it ends. */
async function collect(client: AsyncIterable<StreamEvent>, n: number): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of client) {
    out.push(event);
    if (out.length >= n) break;
  }
  return out;
}

test('connects, authenticates, and yields decoded messages', async () => {
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions());
  client.connect();
  const socket = lastSocket();
  socket.open();
  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  socket.message(JSON.stringify([{ T: 't', S: 'AAPL', p: 100.5 }]));

  const events = await collect(client, 3);
  expect(events).toEqual([
    { type: 'open' },
    { type: 'authenticated' },
    { type: 'message', message: { T: 't', S: 'AAPL', p: 100.5 } },
  ]);
  expect(JSON.parse(socket.sent[0] as string)).toEqual({ action: 'auth', key: 'KEY', secret: 'SECRET' });
  expect(client.state).toBe('open');
});

test('subscribe sends immediately and unsubscribe forgets it', async () => {
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions());
  client.connect();
  const socket = lastSocket();
  socket.open();
  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  await collect(client, 2); // drain open + authenticated so the test below reads cleanly

  client.subscribe('trades', { action: 'subscribe', trades: ['AAPL'] });
  expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ action: 'subscribe', trades: ['AAPL'] });

  client.unsubscribe('trades', { action: 'unsubscribe', trades: ['AAPL'] });
  expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ action: 'unsubscribe', trades: ['AAPL'] });
});

test('reconnects with backoff and replays tracked subscriptions, but not the unsubscribed one', async () => {
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions({ reconnect: { initialDelayMs: 1, maxDelayMs: 4, factor: 2 } }));
  client.connect();
  let socket = lastSocket();
  socket.open();
  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  await collect(client, 2);
  client.subscribe('trades', { action: 'subscribe', trades: ['AAPL'] });
  client.subscribe('quotes', { action: 'subscribe', quotes: ['MSFT'] });
  client.unsubscribe('quotes', { action: 'unsubscribe', quotes: ['MSFT'] });

  // Connection drops unexpectedly (not via client.close()) - should auto-reconnect.
  socket.close(1006, 'abnormal');
  const [reconnecting] = await collect(client, 1);
  expect(reconnecting).toEqual({ type: 'reconnecting', attempt: 1, delayMs: 1 });
  expect(client.state).toBe('reconnecting');

  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(MockSocket.instances).toHaveLength(2);
  socket = lastSocket();
  socket.open();
  socket.sent = []; // clear the resent auth message
  socket.message(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  await collect(client, 1); // the 'authenticated' event
  const replayed = socket.sent.map((m) => JSON.parse(m as string));
  expect(replayed).toEqual([{ action: 'subscribe', trades: ['AAPL'] }]);
});

test('idle timeout forces a reconnect: state correctly reflects the in-flight close, not stale "open"', async () => {
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions({ idleTimeoutMs: 5, reconnect: { initialDelayMs: 1 } }));
  client.connect();
  const socket = lastSocket();
  socket.open();

  const [, errorEvent] = await collect(client, 2); // 'open' first, then the idle-timeout error
  expect(errorEvent).toEqual({ type: 'error', error: expect.any(Error) as unknown as Error });
  expect((errorEvent as { type: 'error'; error: Error }).error.message).toMatch(/idle timeout/);
  // Regression: the idle handler used to leave `state` reporting 'open' during the async close
  // handshake, so a subscribe()/send() call in that window threw "stream socket is not open"
  // unexpectedly. It must never claim 'open' again once the idle-driven close has begun, and
  // send() (which checks the socket's actual readyState, not just the label) must refuse.
  expect(client.state).not.toBe('open');
  expect(() => client.send({})).toThrow('stream socket is not open');

  await tick(); // let the deferred close handshake land
  expect(socket.readyState).toBe(3);
  // It keeps trying - not stuck 'closed' - though by now the 1ms reconnect timer may already have
  // fired too, so this could be 'reconnecting' (still waiting) or 'connecting' (already retrying).
  expect(client.state).not.toBe('closed');

  client.close(); // clean up any pending reconnect timer so it can't fire into a later test
});

test('close() is clean - no reconnect, ends the async iterator', async () => {
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions());
  client.connect();
  const socket = lastSocket();
  socket.open();

  const iterator = client[Symbol.asyncIterator]();
  const pending = iterator.next(); // currently parked waiting for the next event (the 'open' one, already queued, will resolve first)
  await pending;
  const next = iterator.next();
  client.close(1000, 'bye');
  expect(client.state).toBe('closing');
  await tick();
  expect(socket.readyState).toBe(3);
  expect(await next).toEqual({ value: undefined, done: true });
  expect(MockSocket.instances).toHaveLength(1); // never reconnected
});

test('close() called while a reconnect is already scheduled ends the iterator immediately, instead of hanging', async () => {
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions({ reconnect: { initialDelayMs: 1000 } }));
  client.connect();
  const socket = lastSocket();
  socket.open();
  await collect(client, 1); // 'open'

  socket.close(1006, 'abnormal'); // unexpected drop - schedules a reconnect 1000ms out
  await collect(client, 1); // 'reconnecting'
  expect(client.state).toBe('reconnecting');

  const iterator = client[Symbol.asyncIterator]();
  const pending = iterator.next();
  client.close(); // regression: this used to silently no-op (state was already 'closed') and never end the queue
  expect(await pending).toEqual({ value: undefined, done: true });
});

test("connect()'s re-entry guard covers the 'closing' state, so a stale close can't orphan a fresh connection", async () => {
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions());
  client.connect();
  const first = lastSocket();
  first.open();
  await collect(client, 1); // 'open'

  client.close(); // readyState -> CLOSING synchronously; the 'close' event is still pending (microtask)
  client.connect(); // regression: used to be allowed through and create a second socket while the first was still closing
  expect(MockSocket.instances).toHaveLength(1); // no new socket was created - connect() correctly no-opped

  await tick(); // let the first socket's close event land
  expect(client.state).toBe('closed');
});

test('send() throws when the socket is not open', () => {
  const client = new StreamClient(dataStreamOptions());
  expect(() => client.send({ action: 'noop' })).toThrow('stream socket is not open');
});

test('the default decode handles JSON arriving as a binary-opcode frame, not just text frames', async () => {
  // Regression: confirmed against the real API that some streams (trading, option data) send
  // JSON inside *binary*-opcode frames by default - "binary frames" describes the WS opcode,
  // not the codec. The default decode (no `decode` option configured) must handle this, not
  // just text frames.
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions());
  client.connect();
  const socket = lastSocket();
  socket.open();
  const bytes = new TextEncoder().encode(JSON.stringify({ T: 'success', msg: 'authenticated' }));
  socket.message(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  const [openEvent, authEvent] = await collect(client, 2);
  expect(openEvent).toEqual({ type: 'open' });
  expect(authEvent).toEqual({ type: 'authenticated' });
});

test('a binary frame that is not valid UTF-8 JSON yields an error event instead of throwing', async () => {
  MockSocket.instances = [];
  const client = new StreamClient(dataStreamOptions());
  client.connect();
  const socket = lastSocket();
  socket.open();
  socket.message(new ArrayBuffer(4)); // four zero bytes - not valid JSON

  const [openEvent, errorEvent] = await collect(client, 2);
  expect(openEvent).toEqual({ type: 'open' });
  expect((errorEvent as { type: 'error'; error: Error }).error).toBeInstanceOf(Error);
});

test('AsyncQueue rejects a second concurrent consumer instead of silently splitting messages between them', async () => {
  const queue = new AsyncQueue<number>();
  const a = queue[Symbol.asyncIterator]().next();
  const b = queue[Symbol.asyncIterator]().next(); // a second next() while `a` is still pending
  queue.push(1);
  await expect(a).resolves.toEqual({ value: 1, done: false });
  await expect(b).rejects.toThrow('AsyncQueue: next() was called concurrently by more than one consumer');
});
