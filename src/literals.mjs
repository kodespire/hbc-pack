// Literal value buffer and object key buffer as typed streams.
//
// Both buffers hold tagged runs (SerializedLiteralGenerator: tag byte = form:1 type:3 count:4,
// long form adds a count byte; then the values). They are packed like string storage: a literal's
// bytes may start inside another literal's payload. So the buffer is rebuilt from the list of
// references (offset, count) that the instructions and the shape table provide, in offset order:
// a literal that starts at or after everything reconstructed so far is coded as typed columns
// (tags, 16-bit string ids, 32-bit string ids, int32, doubles); bytes between literals go to a
// gap stream; the rare literal that starts inside an earlier one contributes only its bytes past
// the reconstructed end, raw, to a tail stream.
import { ByteReader, ByteWriter } from './bits.mjs';

const SIZE = [0, 0, 0, 8, 4, 2, 0, 4]; // null true false number longstring shortstring undefined integer

export const STREAM_NAMES = ['Tags', 'S16', 'S32', 'I32', 'Dbl', 'Gap', 'Tail'];

// spans: array of [offset, count]; returns them deduplicated and sorted (offset asc, count desc).
export function normalizeSpans(spans) {
  const seen = new Set(); const out = [];
  for (const [o, n] of spans) { const k = o * 65536 + n; if (!seen.has(k)) { seen.add(k); out.push([o, n]); } }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  return out;
}

// End offset of the literal with `count` values starting at `pos` in `buf`.
function literalEnd(buf, pos, count) {
  let p = pos, got = 0;
  while (got < count) {
    const tag = buf[p++]; let n = tag & 15;
    if (tag & 0x80) n = (n << 8) | buf[p++];
    const type = (tag >>> 4) & 7;
    p += n * SIZE[type]; got += n;
    if (p > buf.length) throw new Error('literal runs past buffer');
  }
  if (got !== count) throw new Error(`literal at ${pos}: ${got} values, expected ${count}`);
  return p;
}

export function encodeBuffer(buf, spans) {
  const W = Object.fromEntries(STREAM_NAMES.map((n) => [n, new ByteWriter(1024)]));
  let covered = 0;
  for (const [o, n] of spans) {
    if (o > buf.length) throw new Error(`span at ${o} beyond buffer ${buf.length}`);
    if (o >= covered) {
      W.Gap.bytes(buf.subarray(covered, o));
      let p = o, got = 0;
      while (got < n) {
        const tag = buf[p++]; W.Tags.u8(tag); let cnt = tag & 15;
        if (tag & 0x80) { const b = buf[p++]; W.Tags.u8(b); cnt = (cnt << 8) | b; }
        const type = (tag >>> 4) & 7, size = SIZE[type];
        if (size) {
          const dst = type === 5 ? W.S16 : type === 4 ? W.S32 : type === 7 ? W.I32 : W.Dbl;
          dst.bytes(buf.subarray(p, p + cnt * size)); p += cnt * size;
        }
        got += cnt;
        if (p > buf.length) throw new Error('literal runs past buffer');
      }
      if (got !== n) throw new Error(`literal at ${o}: ${got} values, expected ${n}`);
      covered = p;
    } else {
      const e = literalEnd(buf, o, n);
      if (e > covered) { W.Tail.bytes(buf.subarray(covered, e)); covered = e; }
    }
  }
  W.Gap.bytes(buf.subarray(covered));
  return Object.fromEntries(STREAM_NAMES.map((n) => [n, W[n].finish()]));
}

export function decodeBuffer(length, spans, S) {
  const R = Object.fromEntries(STREAM_NAMES.map((n) => [n, new ByteReader(S[n])]));
  const out = new Uint8Array(length);
  let covered = 0;
  for (const [o, n] of spans) {
    if (o >= covered) {
      out.set(R.Gap.bytes(o - covered), covered);
      let p = o, got = 0;
      while (got < n) {
        const tag = R.Tags.u8(); out[p++] = tag; let cnt = tag & 15;
        if (tag & 0x80) { const b = R.Tags.u8(); out[p++] = b; cnt = (cnt << 8) | b; }
        const type = (tag >>> 4) & 7, size = SIZE[type];
        if (size) {
          const src = type === 5 ? R.S16 : type === 4 ? R.S32 : type === 7 ? R.I32 : R.Dbl;
          out.set(src.bytes(cnt * size), p); p += cnt * size;
        }
        got += cnt;
      }
      covered = p;
    } else {
      // Overlapping literal: bytes before `covered` are already there; the rest come from Tail.
      let p = o, got = 0;
      const byte = () => { if (p >= covered) out[p] = R.Tail.u8(); return out[p++]; };
      while (got < n) {
        const tag = byte(); let cnt = tag & 15;
        if (tag & 0x80) cnt = (cnt << 8) | byte();
        const type = (tag >>> 4) & 7, size = SIZE[type];
        for (let k = cnt * size; k > 0; k--) byte();
        got += cnt;
      }
      if (p > covered) covered = p;
    }
  }
  out.set(R.Gap.bytes(length - covered), covered);
  return out;
}
