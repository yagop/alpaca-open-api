/**
 * Minimal MessagePack codec - just enough to talk to Alpaca's binary streams.
 * Dependency-free by design (project policy: native/minimal over a new dep).
 *
 * The decoder reads everything Alpaca sends (maps, arrays, strings, ints,
 * floats, bool, nil, bin and the timestamp extension, which it renders as an
 * RFC3339 nanosecond string to match the JSON streams). The encoder only needs
 * to produce the simple flat `{action, ...}` shapes used for `auth`/`listen`/
 * `subscribe`/`unsubscribe` - nil, bool, string (any length), array, plain
 * object (map with string keys), and number (always as float64 - these
 * messages never carry one, but it keeps the encoder total). Values with a
 * `toJSON()` (own or inherited, e.g. `Date`) encode via its result instead,
 * same as `JSON.stringify`; a circular reference throws instead of recursing
 * forever. No extension types, no compact integer-width selection -
 * correctness over byte-shaving for a handful of tiny, infrequent control
 * messages.
 *
 * Originally added decode-only on the assumption every stream accepts JSON
 * for outgoing messages (true for trading and stock/crypto/news data) -
 * disproven for the option data stream, confirmed against the real API: it
 * rejects a JSON-text auth message with `{T:"error", code:400, msg:"invalid
 * syntax"}` and requires real MessagePack both ways.
 *
 * @see https://github.com/msgpack/msgpack/blob/master/spec.md
 */

const TEXT = new TextDecoder();

/** Decode a single MessagePack value from a buffer (the whole frame). */
export function decode(input: ArrayBuffer | ArrayBufferView): unknown {
  return new Decoder(toBytes(input)).read();
}

/**
 * Encode one value (nil/bool/number/string/array/plain object) to a MessagePack
 * buffer. A value with a `toJSON()` method (own or inherited - e.g. `Date`) is
 * encoded via its `toJSON()` result instead, same as `JSON.stringify`. Throws on
 * a circular reference rather than recursing forever.
 */
export function encode(value: unknown): Uint8Array {
  const out: number[] = [];
  writeValue(value, out, new Set());
  return Uint8Array.from(out);
}

function toBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

function writeValue(value: unknown, out: number[], seen: Set<object>): void {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    writeValue((value as { toJSON(): unknown }).toJSON(), out, seen);
  } else if (value === null || value === undefined) {
    out.push(0xc0);
  } else if (value === false) {
    out.push(0xc2);
  } else if (value === true) {
    out.push(0xc3);
  } else if (typeof value === 'number') {
    out.push(0xcb, ...f64(value));
  } else if (typeof value === 'string') {
    writeString(value, out);
  } else if (Array.isArray(value)) {
    withCycleCheck(value, seen, () => {
      writeLength(value.length, [0x90, 0xdc, 0xdd], out);
      for (const item of value) writeValue(item, out, seen);
    });
  } else if (typeof value === 'object') {
    withCycleCheck(value, seen, () => {
      const entries = Object.entries(value);
      writeLength(entries.length, [0x80, 0xde, 0xdf], out);
      for (const [k, v] of entries) {
        writeString(k, out);
        writeValue(v, out, seen);
      }
    });
  } else {
    throw new Error(`msgpack: cannot encode a ${typeof value}`);
  }
}

/** Guards a container's recursion against a true cycle, while letting the same object appear more than once in unrelated branches (that's not circular). */
function withCycleCheck(value: object, seen: Set<object>, write: () => void): void {
  if (seen.has(value)) throw new Error('msgpack: cannot encode a circular reference');
  seen.add(value);
  try {
    write();
  } finally {
    seen.delete(value);
  }
}

function writeString(value: string, out: number[]): void {
  const bytes = TEXT_ENCODER.encode(value);
  if (bytes.length < 32) out.push(0xa0 | bytes.length);
  else writeLength(bytes.length, [-1, 0xd9, 0xda, 0xdb], out, true);
  out.push(...bytes);
}

/**
 * Writes the opcode + any length bytes for a length-prefixed type. `opcodes` is
 * `[fixedOpcode, len8Or16Opcode, len32Opcode]` (fixed has no length byte; the
 * others are uint8/16 then uint32) for arrays/maps, or `[-1, len8, len16, len32]`
 * for strings (no fixed-with-no-length-byte form beyond the literal fixstr case,
 * handled separately in `writeString`).
 */
function writeLength(len: number, opcodes: readonly number[], out: number[], stringForm = false): void {
  if (!stringForm) {
    const [fixed, op16, op32] = opcodes as [number, number, number];
    if (len < 16) {
      out.push(fixed | len);
    } else if (len < 0x10000) {
      out.push(op16, (len >> 8) & 0xff, len & 0xff);
    } else {
      out.push(op32, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    }
    return;
  }
  const [, op8, op16, op32] = opcodes as [number, number, number, number];
  if (len < 256) {
    out.push(op8, len);
  } else if (len < 0x10000) {
    out.push(op16, (len >> 8) & 0xff, len & 0xff);
  } else {
    out.push(op32, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  }
}

const TEXT_ENCODER = new TextEncoder();

function f64(value: number): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value);
  return [...new Uint8Array(buf)];
}

class Decoder {
  private view: DataView;
  private pos = 0;

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  read(): unknown {
    const b = this.u8();
    // positive fixint
    if (b <= 0x7f) return b;
    // negative fixint
    if (b >= 0xe0) return b - 0x100;
    // fixmap / fixarray / fixstr
    if (b <= 0x8f) return this.map(b & 0x0f);
    if (b <= 0x9f) return this.array(b & 0x0f);
    if (b <= 0xbf) return this.str(b & 0x1f);

    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return this.bin(this.u8());
      case 0xc5: return this.bin(this.u16());
      case 0xc6: return this.bin(this.u32());
      case 0xc7: return this.ext(this.u8());
      case 0xc8: return this.ext(this.u16());
      case 0xc9: return this.ext(this.u32());
      case 0xca: { const v = this.view.getFloat32(this.pos); this.pos += 4; return v; }
      case 0xcb: { const v = this.view.getFloat64(this.pos); this.pos += 8; return v; }
      case 0xcc: return this.u8();
      case 0xcd: return this.u16();
      case 0xce: return this.u32();
      case 0xcf: return this.u64();
      case 0xd0: { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
      case 0xd1: { const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
      case 0xd2: { const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
      case 0xd3: return this.i64();
      case 0xd4: return this.ext(1);
      case 0xd5: return this.ext(2);
      case 0xd6: return this.ext(4);
      case 0xd7: return this.ext(8);
      case 0xd8: return this.ext(16);
      case 0xd9: return this.str(this.u8());
      case 0xda: return this.str(this.u16());
      case 0xdb: return this.str(this.u32());
      case 0xdc: return this.array(this.u16());
      case 0xdd: return this.array(this.u32());
      case 0xde: return this.map(this.u16());
      case 0xdf: return this.map(this.u32());
      default: throw new Error(`msgpack: unknown byte 0x${b.toString(16)}`);
    }
  }

  private u8(): number { return this.bytes[this.pos++]!; }
  private u16(): number { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  private u32(): number { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  private u64(): number | bigint { const v = this.view.getBigUint64(this.pos); this.pos += 8; return safe(v); }
  private i64(): number | bigint { const v = this.view.getBigInt64(this.pos); this.pos += 8; return safe(v); }

  private str(len: number): string {
    const s = TEXT.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  private bin(len: number): Uint8Array {
    const b = this.bytes.slice(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }

  private array(len: number): unknown[] {
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = this.read();
    return out;
  }

  private map(len: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < len; i++) {
      const k = this.read();
      out[String(k)] = this.read();
    }
    return out;
  }

  private ext(len: number): unknown {
    const type = this.view.getInt8(this.pos); this.pos += 1;
    if (type === -1) return this.timestamp(len);
    const data = this.bin(len);
    return { type, data };
  }

  /**
   * Timestamp extension (-1): 4-byte secs, 8-byte ns|secs, or 12-byte ns + secs. Returns an
   * RFC3339 string with nanosecond precision - matching what Alpaca's JSON streams put in the same
   * `t` fields (and the generated `Timestamp = string` REST type), so a consumer sees one uniform
   * representation across every stream. Confirmed live: the option data stream sends every `t` as
   * an 8-byte timestamp extension; decoding it to a `Date` (as this did originally) both mistyped
   * the field and truncated its nanoseconds to milliseconds.
   */
  private timestamp(len: number): string {
    let secs: number;
    let nanos: number;
    if (len === 4) {
      secs = this.u32();
      nanos = 0;
    } else if (len === 8) {
      // Spec: data64 = (nanoseconds << 34) | seconds (30-bit nanoseconds, 34-bit seconds), big-endian.
      // So the FIRST (more-significant) word holds nanoseconds in its top 30 bits plus the top 2 bits
      // of seconds; the SECOND word holds the low 32 bits of seconds.
      const high = this.view.getUint32(this.pos);
      const low = this.view.getUint32(this.pos + 4);
      this.pos += 8;
      nanos = high >>> 2;
      secs = (high & 0x3) * 2 ** 32 + low;
    } else if (len === 12) {
      nanos = this.u32();
      secs = Number(this.i64());
    } else {
      throw new Error(`msgpack: bad timestamp length ${len}`);
    }
    // Whole seconds via Date (exact - Date holds ms and secs*1000 has none), nanoseconds spliced in
    // as a trailing fraction so the full precision survives (RFC3339 allows any fractional width).
    const whole = new Date(secs * 1000).toISOString().slice(0, 19); // "YYYY-MM-DDTHH:MM:SS"
    const frac = nanos === 0 ? '' : `.${String(nanos).padStart(9, '0').replace(/0+$/, '')}`;
    return `${whole}${frac}Z`;
  }
}

function safe(v: bigint): number | bigint {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}
