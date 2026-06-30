import { expect, test } from 'bun:test';
import { decode, encode } from './msgpack';

// Golden byte vectors straight from the MessagePack spec - each anchors one leaf
// type independently (so a systematically-wrong reader can't pass via round-trip).
const u = (...b: number[]) => Uint8Array.from(b);

test('fixint, ints and their widths', () => {
  expect(decode(u(0x00))).toBe(0);
  expect(decode(u(0x7f))).toBe(127);
  expect(decode(u(0xff))).toBe(-1); // negative fixint
  expect(decode(u(0xe0))).toBe(-32);
  expect(decode(u(0xcc, 0x80))).toBe(128); // uint8
  expect(decode(u(0xcd, 0x01, 0x00))).toBe(256); // uint16
  expect(decode(u(0xce, 0x00, 0x01, 0x00, 0x00))).toBe(65536); // uint32
  expect(decode(u(0xd0, 0x80))).toBe(-128); // int8
  expect(decode(u(0xd1, 0xff, 0x00))).toBe(-256); // int16
});

test('nil, bool, float', () => {
  expect(decode(u(0xc0))).toBeNull();
  expect(decode(u(0xc2))).toBe(false);
  expect(decode(u(0xc3))).toBe(true);
  // float64 1.5 = 0x3FF8000000000000
  expect(decode(u(0xcb, 0x3f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00))).toBe(1.5);
});

test('fixstr / str8 / utf-8', () => {
  expect(decode(u(0xa3, 0x61, 0x62, 0x63))).toBe('abc'); // fixstr "abc"
  expect(decode(u(0xd9, 0x01, 0x7a))).toBe('z'); // str8 "z"
  expect(decode(u(0xa2, 0xc3, 0xa9))).toBe('é'); // 2-byte utf-8
});

test('fixarray and fixmap', () => {
  expect(decode(u(0x93, 0x01, 0x02, 0x03))).toEqual([1, 2, 3]);
  expect(decode(u(0x81, 0xa1, 0x61, 0x01))).toEqual({ a: 1 }); // {"a":1}
});

test('timestamp extension (-1) decodes to a Date - all three encodings', () => {
  // fixext4 (0xd6), type -1 (0xff), uint32 seconds = 1
  expect(decode(u(0xd6, 0xff, 0x00, 0x00, 0x00, 0x01))).toEqual(new Date(1000));

  // fixext8 (0xd7), type -1, data64 = (nanoseconds << 34) | seconds for
  // nanoseconds=500_000_000, seconds=1_700_000_000 -> 2023-11-14T22:13:20.500Z.
  // Regression test: an earlier version of timestamp(8) read the big-endian
  // word pair backwards, decoding this to a date roughly a decade off.
  expect(decode(u(0xd7, 0xff, 0x77, 0x35, 0x94, 0x00, 0x65, 0x53, 0xf1, 0x00))).toEqual(new Date('2023-11-14T22:13:20.500Z'));

  // ext8 (0xc7), length 12, type -1: 4-byte nanoseconds (250_000_000) + 8-byte seconds (1_700_000_000)
  // -> 2023-11-14T22:13:20.250Z.
  expect(decode(u(0xc7, 0x0c, 0xff, 0x0e, 0xe6, 0xb2, 0x80, 0x00, 0x00, 0x00, 0x00, 0x65, 0x53, 0xf1, 0x00))).toEqual(
    new Date('2023-11-14T22:13:20.250Z'),
  );
});

test('bin decodes to bytes; unknown ext keeps {type,data}', () => {
  expect(decode(u(0xc4, 0x02, 0xaa, 0xbb))).toEqual(u(0xaa, 0xbb)); // bin8
  expect(decode(u(0xd4, 0x05, 0x42))).toEqual({ type: 5, data: u(0x42) }); // fixext1, custom type
});

// A realistic nested trade_updates frame, composed from a small spec-correct
// encoder for the subset (fixstr/fixmap/fixarray) - exercises nesting end to end.
const fstr = (s: string) => {
  const b = new TextEncoder().encode(s);
  if (b.length >= 32) throw new Error('test helper: string too long');
  return u(0xa0 | b.length, ...b);
};
const fmap = (o: Record<string, Uint8Array>) => {
  const entries = Object.entries(o);
  const parts = entries.flatMap(([k, v]) => [fstr(k), v]);
  return concat(u(0x80 | entries.length), ...parts);
};
const concat = (...arrs: Uint8Array[]) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of arrs) { out.set(a, p); p += a.length; }
  return out;
};

test('nested trade_updates frame', () => {
  const frame = fmap({
    stream: fstr('trade_updates'),
    data: fmap({
      event: fstr('fill'),
      price: fstr('100.5'),
      order: fmap({ id: fstr('abc'), status: fstr('filled') }),
    }),
  });
  expect(decode(frame)).toEqual({
    stream: 'trade_updates',
    data: { event: 'fill', price: '100.5', order: { id: 'abc', status: 'filled' } },
  });
});

// The encoder only needs to produce simple `{action, ...}` control messages (auth/listen/
// subscribe/unsubscribe) for the option data stream, which - confirmed against the real API -
// rejects a JSON-text auth message outright and requires real MessagePack both ways.

test('encodes nil, bool, and float64 numbers', () => {
  expect(decode(encode(null))).toBeNull();
  expect(decode(encode(undefined))).toBeNull();
  expect(decode(encode(true))).toBe(true);
  expect(decode(encode(false))).toBe(false);
  expect(decode(encode(1.5))).toBe(1.5);
  expect(decode(encode(0))).toBe(0);
});

test('encodes strings of every length class (fixstr / str8 / str16)', () => {
  expect(decode(encode('hi'))).toBe('hi'); // fixstr
  const len31 = 'a'.repeat(31);
  expect(decode(encode(len31))).toBe(len31); // fixstr boundary
  // Regression: an API secret (44 chars) exceeds fixstr's 31-byte limit and needs str8 - an
  // encoder that always emits a fixstr opcode here corrupts the length nibble silently instead
  // of throwing, truncating the decoded string and desyncing every byte after it.
  const len44 = 'b'.repeat(44);
  expect(decode(encode(len44))).toBe(len44);
  const len300 = 'c'.repeat(300); // str16
  expect(decode(encode(len300))).toBe(len300);
});

test('encodes arrays and plain objects (maps), including nested', () => {
  expect(decode(encode([1, 2, 3]))).toEqual([1, 2, 3]);
  expect(decode(encode({ a: 1, b: 'two' }))).toEqual({ a: 1, b: 'two' });
  expect(decode(encode({ action: 'listen', data: { streams: ['trade_updates'] } }))).toEqual({
    action: 'listen',
    data: { streams: ['trade_updates'] },
  });
});

test('round-trips a realistic auth message with full-length key/secret', () => {
  const message = { action: 'auth', key: 'PKTEST1234567890ABCD', secret: 'x'.repeat(40) };
  expect(decode(encode(message))).toEqual(message);
});

test('round-trips a subscribe message with multiple channels', () => {
  const message = { action: 'subscribe', trades: ['AAPL', 'MSFT'], quotes: ['AAPL'] };
  expect(decode(encode(message))).toEqual(message);
});
