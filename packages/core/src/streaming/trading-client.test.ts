import { expect, test } from 'bun:test';
import { TradingStreamClient } from './trading-client';

// A minimal stand-in for the global `WebSocket`, mirroring client.test.ts's
// MockSocket. The trading stream is binary, so `message()` here sends raw
// msgpack bytes (built with the small encoder below) instead of JSON text.
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

  message(data: ArrayBuffer): void {
    this.fire('message', { data });
  }

  private fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function lastSocket(): MockSocket {
  return MockSocket.instances[MockSocket.instances.length - 1]!;
}

// Tiny spec-correct msgpack encoder for the fixstr/fixmap/fixarray subset -
// enough to build the realistic frames this test sends. Mirrors the
// equivalent helper in msgpack.test.ts.
const u = (...b: number[]) => Uint8Array.from(b);
const fstr = (s: string) => {
  const b = new TextEncoder().encode(s);
  if (b.length >= 32) throw new Error('test helper: string too long');
  return u(0xa0 | b.length, ...b);
};
const concat = (...arrs: Uint8Array[]) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of arrs) {
    out.set(a, p);
    p += a.length;
  }
  return out;
};
const fmap = (o: Record<string, Uint8Array>) => {
  const entries = Object.entries(o);
  return concat(u(0x80 | entries.length), ...entries.flatMap(([k, v]) => [fstr(k), v]));
};
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const authorizationFrame = (status: 'authorized' | 'unauthorized') =>
  toArrayBuffer(fmap({ stream: fstr('authorization'), data: fmap({ status: fstr(status), action: fstr('authenticate') }) }));

const listeningFrame = () => toArrayBuffer(fmap({ stream: fstr('listening'), data: fmap({ streams: fstr('trade_updates') }) }));

const tradeUpdateFrame = (event: string) =>
  toArrayBuffer(
    fmap({
      stream: fstr('trade_updates'),
      data: fmap({ event: fstr(event), price: fstr('100.5'), order: fmap({ id: fstr('o-1'), status: fstr('filled') }) }),
    }),
  );

function connectAndAuth(client: TradingStreamClient): MockSocket {
  client.connect();
  const socket = lastSocket();
  socket.open();
  socket.message(authorizationFrame('authorized'));
  return socket;
}

test('authenticates with key/secret, listens to trade_updates, and emits typed events', () => {
  MockSocket.instances = [];
  const events: string[] = [];
  const client = new TradingStreamClient({
    apiKey: 'KEY',
    apiSecret: 'SECRET',
    WebSocketImpl: MockSocket as unknown as typeof WebSocket,
  });
  client.on('authenticated', () => events.push('authenticated'));
  client.on('trade_update', (u) => events.push(`trade_update:${u.event}`));

  const socket = connectAndAuth(client);
  // Auth message is JSON even though the stream itself is binary.
  expect(JSON.parse(socket.sent[0] as string)).toEqual({ action: 'auth', key: 'KEY', secret: 'SECRET' });
  expect(JSON.parse(socket.sent[1] as string)).toEqual({ action: 'listen', data: { streams: ['trade_updates'] } });
  expect(events).toEqual(['authenticated']);

  socket.message(listeningFrame()); // ack - no event surfaced
  socket.message(tradeUpdateFrame('fill'));
  expect(events).toEqual(['authenticated', 'trade_update:fill']);
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

test('unauthorized auth emits an error and never reaches the open state', () => {
  MockSocket.instances = [];
  const errors: Error[] = [];
  const client = new TradingStreamClient({ apiKey: 'BAD', apiSecret: 'BAD', WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  client.on('error', (e) => errors.push(e));
  client.connect();
  const socket = lastSocket();
  socket.open();
  socket.message(authorizationFrame('unauthorized'));
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toMatch(/unauthorized/);
  expect(client.state).toBe('authenticating');
});

test('async iterates trade updates in order', async () => {
  MockSocket.instances = [];
  const client = new TradingStreamClient({ apiKey: 'KEY', apiSecret: 'SECRET', WebSocketImpl: MockSocket as unknown as typeof WebSocket });
  const socket = connectAndAuth(client);
  const iterator = client[Symbol.asyncIterator]();
  const pending = iterator.next();
  socket.message(tradeUpdateFrame('new'));
  expect((await pending).value?.event).toBe('new');
});

test('re-listens automatically after a reconnect', () => {
  MockSocket.instances = [];
  const client = new TradingStreamClient({
    apiKey: 'KEY',
    apiSecret: 'SECRET',
    reconnect: { initialDelayMs: 1 },
    WebSocketImpl: MockSocket as unknown as typeof WebSocket,
  });
  const socket = connectAndAuth(client);

  socket.close(1006, 'abnormal');
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      expect(MockSocket.instances).toHaveLength(2);
      const next = lastSocket();
      next.open();
      next.message(authorizationFrame('authorized'));
      expect(JSON.parse(next.sent.at(-1) as string)).toEqual({ action: 'listen', data: { streams: ['trade_updates'] } });
      resolve();
    }, 5);
  });
});
