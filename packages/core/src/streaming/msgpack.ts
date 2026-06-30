/**
 * Minimal MessagePack *decoder* - just enough to read Alpaca's binary
 * `trade_updates` frames (maps, arrays, strings, ints, floats, bool, nil, bin and
 * the timestamp extension). Decode-only and dependency-free by design: the REST
 * seam stays JSON and only this one stream is binary, so a small reader beats a
 * dependency (project policy: native/minimal over a new dep). Encoding outgoing
 * frames is unnecessary - Alpaca accepts JSON for `auth`/`listen`.
 *
 * @see https://github.com/msgpack/msgpack/blob/master/spec.md
 */

const TEXT = new TextDecoder();

/** Decode a single MessagePack value from a buffer (the whole frame). */
export function decode(input: ArrayBuffer | ArrayBufferView): unknown {
  return new Decoder(toBytes(input)).read();
}

function toBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
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

  /** Timestamp extension (-1): 4-byte secs, 8-byte ns|secs, or 12-byte ns + secs. Returns a Date. */
  private timestamp(len: number): Date {
    if (len === 4) {
      const secs = this.u32();
      return new Date(secs * 1000);
    }
    if (len === 8) {
      const lo = this.view.getUint32(this.pos);
      const hi = this.view.getUint32(this.pos + 4);
      this.pos += 8;
      const nanos = (hi >>> 2);
      const secs = (hi & 0x3) * 2 ** 32 + lo;
      return new Date(secs * 1000 + Math.floor(nanos / 1e6));
    }
    if (len === 12) {
      const nanos = this.u32();
      const secs = Number(this.i64());
      return new Date(secs * 1000 + Math.floor(nanos / 1e6));
    }
    throw new Error(`msgpack: bad timestamp length ${len}`);
  }
}

function safe(v: bigint): number | bigint {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}
