// Adaptive binary range coder (LZMA style: 32-bit range, 11-bit probabilities, shift-5 update)
// plus bit-tree byte models. Used to test how far adaptive context modelling gets on HBC streams
// and how fast such a decoder runs in JS.

const TOP = 1 << 24;
const BITS = 11;
const INIT = 1 << (BITS - 1);
const SHIFT = 5;

export class Encoder {
  constructor(capacity = 1 << 16) {
    this.low = 0; // kept as a Number up to 2^33
    this.range = 0xffffffff;
    this.cache = 0;
    this.cacheSize = 1;
    this.out = new Uint8Array(capacity);
    this.pos = 0;
  }
  _push(b) {
    if (this.pos === this.out.length) { const n = new Uint8Array(this.out.length * 2); n.set(this.out); this.out = n; }
    this.out[this.pos++] = b;
  }
  _shiftLow() {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let c = this.cache;
      do { this._push((c + carry) & 0xff); c = 0xff; } while (--this.cacheSize !== 0);
      this.cache = (this.low >>> 24) & 0xff;
    }
    this.cacheSize++;
    this.low = (this.low & 0x00ffffff) * 256;
  }
  // probs: Uint16Array, idx: index of the probability of bit==0.
  bit(probs, idx, bit) {
    const p = probs[idx];
    const bound = (this.range >>> BITS) * p;
    if (bit === 0) {
      this.range = bound;
      probs[idx] = p + (((1 << BITS) - p) >>> SHIFT);
    } else {
      this.low += bound;
      this.range = (this.range - bound) >>> 0;
      probs[idx] = p - (p >>> SHIFT);
    }
    while (this.range < TOP) { this.range = (this.range << 8) >>> 0; this._shiftLow(); }
  }
  // Byte through a 256-node bit tree rooted at probs[base..base+256).
  byte(probs, base, value) {
    let node = 1;
    for (let i = 7; i >= 0; i--) {
      const b = (value >>> i) & 1;
      this.bit(probs, base + node, b);
      node = (node << 1) | b;
    }
  }
  finish() {
    for (let i = 0; i < 5; i++) this._shiftLow();
    return this.out.subarray(0, this.pos);
  }
}

export class Decoder {
  constructor(bytes) {
    this.buf = bytes;
    this.pos = 0;
    this.range = 0xffffffff;
    this.code = 0;
    this.pos++; // first byte is always 0 (cache init)
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
  }
  bit(probs, idx) {
    const p = probs[idx];
    const bound = (this.range >>> BITS) * p;
    let bit;
    if (this.code < bound) {
      this.range = bound;
      probs[idx] = p + (((1 << BITS) - p) >>> SHIFT);
      bit = 0;
    } else {
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      probs[idx] = p - (p >>> SHIFT);
      bit = 1;
    }
    while (this.range < TOP) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
    }
    return bit;
  }
  byte(probs, base) {
    let node = 1;
    for (let i = 0; i < 8; i++) node = (node << 1) | this.bit(probs, base + node);
    return node & 0xff;
  }
}

export function newProbs(n) { return new Uint16Array(n).fill(INIT); }

// Order-k byte model over a stream: context = last k bytes hashed into 2^ctxBits contexts.
export function encodeOrderK(bytes, k, ctxBits = 16) {
  const enc = new Encoder(bytes.length);
  const probs = newProbs((1 << ctxBits) * 256);
  const mask = (1 << ctxBits) - 1;
  let ctx = 0;
  for (let i = 0; i < bytes.length; i++) {
    enc.byte(probs, (ctx & mask) * 256, bytes[i]);
    ctx = k === 1 ? bytes[i] : (ctx * 0x9e3779b1 + bytes[i] + 1) >>> 0;
    if (k === 2) ctx = ((bytes[i] << 8) | (i > 0 ? bytes[i - 1] : 0)) & 0xffff;
  }
  return enc.finish();
}
export function decodeOrderK(data, length, k, ctxBits = 16) {
  const dec = new Decoder(data);
  const probs = newProbs((1 << ctxBits) * 256);
  const mask = (1 << ctxBits) - 1;
  const out = new Uint8Array(length);
  let ctx = 0;
  for (let i = 0; i < length; i++) {
    const b = dec.byte(probs, (ctx & mask) * 256);
    out[i] = b;
    ctx = k === 1 ? b : (ctx * 0x9e3779b1 + b + 1) >>> 0;
    if (k === 2) ctx = ((b << 8) | (i > 0 ? out[i - 1] : 0)) & 0xffff;
  }
  return out;
}
