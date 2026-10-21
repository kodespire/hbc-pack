// Move-to-front (recency rank) transform for id streams, O(log n) per symbol with a Fenwick tree
// over "last use" times. Ranks go in one stream, first occurrences (raw ids) in another.
import { ByteReader, ByteWriter } from './bits.mjs';

class Fenwick {
  constructor(n) { this.n = n; this.t = new Int32Array(n + 1); }
  add(i, v) { for (i++; i <= this.n; i += i & -i) this.t[i] += v; }
  prefix(i) { let s = 0; for (i++; i > 0; i -= i & -i) s += this.t[i]; return s; } // sum of [0..i]
  // Smallest index p with prefix(p) >= k (k >= 1).
  find(k) {
    let pos = 0, bit = 1 << (31 - Math.clz32(this.n));
    for (; bit; bit >>= 1) {
      const next = pos + bit;
      if (next <= this.n && this.t[next] < k) { pos = next; k -= this.t[next]; }
    }
    return pos; // 0-based index = pos (since tree is 1-based, element pos+1 -> index pos)
  }
}

// values: array of non-negative integers. Returns { ranks: Uint8Array (varints), fresh: Uint8Array (varints) }.
export function encodeMTF(values) {
  const n = values.length;
  const ranks = new ByteWriter(n + 16), fresh = new ByteWriter(64);
  const fw = new Fenwick(n + 1);
  const lastTime = new Map();
  let active = 0;
  for (let t = 0; t < n; t++) {
    const v = values[t];
    const prev = lastTime.get(v);
    if (prev === undefined) {
      ranks.varint(active); // escape: rank == number of active symbols
      fresh.varint(v);
    } else {
      const rank = active - fw.prefix(prev); // symbols used after prev
      ranks.varint(rank);
      fw.add(prev, -1); active--;
    }
    fw.add(t, 1); active++;
    lastTime.set(v, t);
  }
  return { ranks: ranks.finish(), fresh: fresh.finish() };
}

export function decodeMTF(ranksBytes, freshBytes, n) {
  const ranks = new ByteReader(ranksBytes), fresh = new ByteReader(freshBytes);
  const fw = new Fenwick(n + 1);
  const idAtTime = new Int32Array(n);
  const out = new Array(n);
  let active = 0;
  for (let t = 0; t < n; t++) {
    const r = ranks.varint();
    let v;
    if (r === active) {
      v = fresh.varint();
    } else {
      // The symbol whose last time p has exactly r active times after it: prefix(p) = active - r.
      const p = fw.find(active - r);
      v = idAtTime[p];
      fw.add(p, -1); active--;
    }
    fw.add(t, 1); active++;
    idAtTime[t] = v;
    out[t] = v;
  }
  return out;
}

// Streaming decoder: one symbol per next() call, for use while decoding instructions.
export class MTFDecoder {
  constructor(ranksBytes, freshBytes, capacity) {
    this.ranks = new ByteReader(ranksBytes); this.fresh = new ByteReader(freshBytes);
    this.fw = new Fenwick(capacity + 1); this.idAtTime = new Int32Array(capacity + 1);
    this.active = 0; this.t = 0;
  }
  next() {
    const r = this.ranks.varint();
    let v;
    if (r === this.active) v = this.fresh.varint();
    else { const p = this.fw.find(this.active - r); v = this.idAtTime[p]; this.fw.add(p, -1); this.active--; }
    this.fw.add(this.t, 1); this.active++;
    this.idAtTime[this.t++] = v;
    return v;
  }
}
