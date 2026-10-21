// Small byte-level helpers shared by the codec: growable byte writer/reader with LEB128 varints,
// zigzag, column transposition.

export class ByteWriter {
  constructor(capacity = 1024) { this.buf = new Uint8Array(capacity); this.pos = 0; }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap); next.set(this.buf.subarray(0, this.pos)); this.buf = next;
  }
  u8(v) { this.ensure(1); this.buf[this.pos++] = v & 0xff; }
  u16(v) { this.ensure(2); this.buf[this.pos++] = v & 0xff; this.buf[this.pos++] = (v >>> 8) & 0xff; }
  u32(v) { this.ensure(4); const b = this.buf, p = this.pos; b[p] = v & 0xff; b[p + 1] = (v >>> 8) & 0xff; b[p + 2] = (v >>> 16) & 0xff; b[p + 3] = (v >>> 24) & 0xff; this.pos += 4; }
  varint(v) { // unsigned LEB128, values up to 2^53
    this.ensure(10);
    while (v >= 0x80) { this.buf[this.pos++] = (v % 0x80) | 0x80; v = Math.floor(v / 0x80); }
    this.buf[this.pos++] = v;
  }
  svarint(v) { this.varint(zigzag(v)); }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  finish() { return this.buf.subarray(0, this.pos); }
}

export class ByteReader {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }
  get remaining() { return this.buf.length - this.pos; }
  u8() { return this.buf[this.pos++]; }
  u16() { const v = this.buf[this.pos] | (this.buf[this.pos + 1] << 8); this.pos += 2; return v; }
  u32() { const b = this.buf, p = this.pos; this.pos += 4; return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
  varint() {
    let v = 0, mul = 1, byte;
    do { byte = this.buf[this.pos++]; v += (byte & 0x7f) * mul; mul *= 0x80; } while (byte & 0x80);
    return v;
  }
  svarint() { return unzigzag(this.varint()); }
  bytes(n) { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
}

// Zigzag over the 53-bit safe integer range (values here are 32-bit at most).
export const zigzag = (v) => (v < 0 ? -2 * v - 1 : 2 * v);
export const unzigzag = (u) => (u % 2 === 1 ? -(u + 1) / 2 : u / 2);

// Fixed-stride records -> byte columns (column-major) and back.
export function transpose(bytes, stride) {
  const n = bytes.length / stride;
  const out = new Uint8Array(bytes.length);
  for (let c = 0; c < stride; c++) for (let i = 0; i < n; i++) out[c * n + i] = bytes[i * stride + c];
  return out;
}
export function untranspose(cols, stride) {
  const n = cols.length / stride;
  const out = new Uint8Array(cols.length);
  for (let c = 0; c < stride; c++) for (let i = 0; i < n; i++) out[i * stride + c] = cols[c * n + i];
  return out;
}

export function varintArray(values) {
  const w = new ByteWriter(values.length * 2 + 16);
  for (const v of values) w.varint(v);
  return w.finish();
}
export function svarintArray(values) {
  const w = new ByteWriter(values.length * 2 + 16);
  for (const v of values) w.svarint(v);
  return w.finish();
}
export function readVarints(bytes, count) {
  const r = new ByteReader(bytes); const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = r.varint();
  return out;
}
export function readSvarints(bytes, count) {
  const r = new ByteReader(bytes); const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = r.svarint();
  return out;
}

export function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
