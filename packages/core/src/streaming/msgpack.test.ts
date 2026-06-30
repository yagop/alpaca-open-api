import { expect, test } from 'bun:test';
import { decode } from './msgpack';

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

test('timestamp extension (-1) decodes to a Date', () => {
  // fixext4 (0xd6), type -1 (0xff), uint32 seconds = 1
  expect(decode(u(0xd6, 0xff, 0x00, 0x00, 0x00, 0x01))).toEqual(new Date(1000));
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
