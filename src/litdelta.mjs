// Literal buffers as typed columns, for delta containers (FORMAT.md, "Delta containers"). The
// object key buffer, the array (literal value) buffer and, before HBC 98, the object value buffer
// hold tagged runs of values (SerializedLiteralGenerator: tag byte = long:1 type:3 count:4, a
// second count byte in the long form, then the values). Compressed as bytes they gain nothing from
// the installed version because the string ids inside were renumbered. Here each buffer is taken
// apart from the references the instructions and the shape table make, in offset order: tags,
// string ids (one u32 column of canonical ids whatever their width in the buffer), int32s,
// doubles, the bytes between references (gap) and, for a reference that starts inside an earlier
// one, its bytes past what is already covered (tail, raw). Runs are consumed whole, so a reference
// that is a prefix of a longer literal takes the whole run; both sides apply the same rule.
import { ByteReader, ByteWriter } from './bits.mjs';

const SIZE = [0, 0, 0, 8, 4, 2, 0, 4]; // null true false number longstring shortstring undefined integer
export const COLUMNS = ['tags', 'str', 'i32', 'dbl', 'gap', 'tail'];

// spans: array of [offset, count]; deduplicated and sorted (offset ascending, count descending).
export function normalizeSpans(spans) {
  const seen = new Set(); const out = [];
  for (const [o, n] of spans) { const k = `${o}:${n}`; if (!seen.has(k)) { seen.add(k); out.push([o, n]); } }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  return out;
}

export function encodeColumns(buf, spans, mapId) {
  const W = Object.fromEntries(COLUMNS.map((c) => [c, new ByteWriter(1024)]));
  let covered = 0;
  for (const [o, n] of spans) {
    if (o > buf.length) throw new Error(`literal reference at ${o} beyond buffer ${buf.length}`);
    if (o >= covered) {
      W.gap.bytes(buf.subarray(covered, o));
      let p = o, got = 0;
      while (got < n) {
        if (p >= buf.length) throw new Error('literal runs past buffer');
        const tag = buf[p++]; W.tags.u8(tag); let cnt = tag & 15;
        if (tag & 0x80) { if (p >= buf.length) throw new Error('literal runs past buffer'); const b = buf[p++]; W.tags.u8(b); cnt = (cnt << 8) | b; }
        const type = (tag >>> 4) & 7, w = SIZE[type];
        if (p + cnt * w > buf.length) throw new Error('literal runs past buffer');
        if (type === 4 || type === 5) {
          for (let k = 0; k < cnt; k++, p += w) W.str.u32(mapId(w === 2 ? buf[p] | (buf[p + 1] << 8) : (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0));
        } else if (type === 7) { W.i32.bytes(buf.subarray(p, p + 4 * cnt)); p += 4 * cnt; }
        else if (type === 3) { W.dbl.bytes(buf.subarray(p, p + 8 * cnt)); p += 8 * cnt; }
        got += cnt;
      }
      covered = p;
    } else {
      // Starts inside an earlier reference: only the bytes past `covered` are new.
      let p = o, got = 0;
      while (got < n) {
        if (p >= buf.length) throw new Error('literal runs past buffer');
        const tag = buf[p++]; let cnt = tag & 15;
        if (tag & 0x80) { if (p >= buf.length) throw new Error('literal runs past buffer'); cnt = (cnt << 8) | buf[p++]; }
        p += cnt * SIZE[(tag >>> 4) & 7]; got += cnt;
        if (p > buf.length) throw new Error('literal runs past buffer');
      }
      if (p > covered) { W.tail.bytes(buf.subarray(covered, p)); covered = p; }
    }
  }
  W.gap.bytes(buf.subarray(covered));
  return Object.fromEntries(COLUMNS.map((c) => [c, W[c].finish()]));
}

export function decodeColumns(length, spans, cols, unmapId) {
  const R = Object.fromEntries(COLUMNS.map((c) => [c, new ByteReader(cols[c])]));
  const out = new Uint8Array(length);
  let covered = 0;
  for (const [o, n] of spans) {
    if (o > length) throw new Error(`literal reference at ${o} beyond buffer ${length}`);
    if (o >= covered) {
      out.set(R.gap.bytes(o - covered), covered);
      let p = o, got = 0;
      while (got < n) {
        if (p >= length) throw new Error('literal runs past buffer');
        const tag = R.tags.u8(); out[p++] = tag; let cnt = tag & 15;
        if (tag & 0x80) { if (p >= length) throw new Error('literal runs past buffer'); const b = R.tags.u8(); out[p++] = b; cnt = (cnt << 8) | b; }
        const type = (tag >>> 4) & 7, w = SIZE[type];
        if (p + cnt * w > length) throw new Error('literal runs past buffer');
        if (type === 4 || type === 5) {
          for (let k = 0; k < cnt; k++, p += w) {
            const id = unmapId(R.str.u32());
            if (w === 2) { if (id > 0xffff) throw new Error(`string id ${id} does not fit a short string tag`); out[p] = id & 0xff; out[p + 1] = id >>> 8; }
            else { out[p] = id & 0xff; out[p + 1] = (id >>> 8) & 0xff; out[p + 2] = (id >>> 16) & 0xff; out[p + 3] = id >>> 24; }
          }
        } else if (type === 7) { out.set(R.i32.bytes(4 * cnt), p); p += 4 * cnt; }
        else if (type === 3) { out.set(R.dbl.bytes(8 * cnt), p); p += 8 * cnt; }
        got += cnt;
      }
      covered = p;
    } else {
      let p = o, got = 0;
      const byte = () => { if (p >= length) throw new Error('literal runs past buffer'); if (p >= covered) out[p] = R.tail.u8(); return out[p++]; };
      while (got < n) {
        const tag = byte(); let cnt = tag & 15;
        if (tag & 0x80) cnt = (cnt << 8) | byte();
        for (let k = cnt * SIZE[(tag >>> 4) & 7]; k > 0; k--) byte();
        got += cnt;
      }
      if (p > covered) covered = p;
    }
  }
  out.set(R.gap.bytes(length - covered), covered);
  for (const c of COLUMNS) if (R[c].remaining) throw new Error(`literal column ${c}: ${R[c].remaining} bytes left over`);
  return out;
}
