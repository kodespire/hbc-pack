// hbc-pack v0: table-level transforms, function region still opaque.
//   header raw | function headers transposed | kinds raw | identifier hashes DROPPED (recomputed) |
//   string table as columns (utf16 flags, lengths, offset deltas) | storage raw | literal buffers raw |
//   misc tables raw | section padding | function region raw | debug info raw | footer DROPPED (SHA-1)
import { createHash } from 'node:crypto';
import * as hbc from './hbc.mjs';
import { ByteWriter, concat, readSvarints, readVarints, svarintArray, transpose, untranspose, varintArray } from './bits.mjs';
import { packStreams, unpackStreams } from './streams.mjs';

let lastReport = null;
export const lastStats = () => lastReport;

const SECTION_ORDER = ['functionHeaders', 'stringKinds', 'identifierHashes', 'stringTable', 'overflowStringTable', 'stringStorage',
  'arrayBuffer', 'objKeyBuffer', 'objShapeTable', 'bigIntTable', 'bigIntStorage', 'regExpTable', 'regExpStorage', 'cjsModuleTable', 'functionSourceTable'];
const MISC = ['bigIntTable', 'bigIntStorage', 'regExpTable', 'regExpStorage', 'cjsModuleTable', 'functionSourceTable'];
const align4 = (n) => (n + 3) & ~3;

function slice(buf, sec) { return buf.subarray(sec.start, sec.start + sec.size); }

// Bytes in the alignment gaps between sections (usually zero, not always), in order.
function paddingBytes(buf, off) {
  const parts = [];
  let o = hbc.HEADER_SIZE;
  for (const name of SECTION_ORDER) {
    const s = off[name];
    parts.push(buf.subarray(o, s.start));
    o = s.start + s.size;
  }
  parts.push(buf.subarray(o, off.tablesEnd));
  return concat(parts);
}

export function pack(buf, opts = {}) {
  const h = hbc.parseHeader(buf);
  const off = hbc.tableOffsets(h);
  const kinds = hbc.parseStringKinds(buf, off, h);
  const strings = hbc.parseStringTable(buf, off, h);

  // String table columns.
  const flags = new Uint8Array(strings.length);
  const lens = new Array(strings.length);
  const deltas = new Array(strings.length);
  let si = 0;
  for (const run of kinds) {
    let prev = 0;
    for (let k = 0; k < run.count; k++, si++) {
      const s = strings[si];
      flags[si] = s.utf16 ? 1 : 0;
      lens[si] = s.length;
      deltas[si] = s.offset - prev;
      prev = s.offset;
    }
  }

  const streams = [
    { name: 'header', bytes: buf.subarray(0, hbc.HEADER_SIZE) },
    { name: 'funcHeaders', bytes: transpose(slice(buf, off.functionHeaders), hbc.SMALL_FUNC_HEADER_SIZE) },
    { name: 'kinds', bytes: slice(buf, off.stringKinds) },
    { name: 'strFlags', bytes: flags },
    { name: 'strLens', bytes: varintArray(lens) },
    { name: 'strDeltas', bytes: svarintArray(deltas) },
    { name: 'storage', bytes: slice(buf, off.stringStorage) },
    { name: 'arrayBuffer', bytes: slice(buf, off.arrayBuffer) },
    { name: 'objKeyBuffer', bytes: slice(buf, off.objKeyBuffer) },
    { name: 'objShapeTable', bytes: slice(buf, off.objShapeTable) },
    { name: 'misc', bytes: concat(MISC.map((n) => slice(buf, off[n]))) },
    { name: 'padding', bytes: paddingBytes(buf, off) },
    { name: 'funcs', bytes: buf.subarray(off.tablesEnd, h.debugInfoOffset) },
    { name: 'debug', bytes: buf.subarray(h.debugInfoOffset, buf.length - 20) },
  ];
  const { bytes, report } = packStreams(streams, opts);
  lastReport = report;
  return bytes;
}

export function unpack(bytes) {
  const [header, funcHeadersT, kindsBytes, flags, lensBytes, deltasBytes, storage, arrayBuffer, objKeyBuffer, objShapeTable, misc, padding, funcs, debug] = unpackStreams(bytes);
  const h = hbc.parseHeaderLoose(header);
  const off = hbc.tableOffsets(h);
  const out = new Uint8Array(h.fileLength);
  out.set(header, 0);

  // Padding gaps are consumed in order.
  let padPos = 0;
  let o = hbc.HEADER_SIZE;
  const place = (name, bytesFn) => {
    const s = off[name];
    out.set(padding.subarray(padPos, padPos + (s.start - o)), o); padPos += s.start - o;
    const b = bytesFn();
    if (b.length !== s.size) throw new Error(`${name}: ${b.length} != ${s.size}`);
    out.set(b, s.start);
    o = s.start + s.size;
  };

  // Strings: rebuild entries from columns, then hashes from kinds + storage.
  const kinds = [];
  for (let i = 0; i < h.stringKindCount; i++) {
    const v = kindsBytes[4 * i] | (kindsBytes[4 * i + 1] << 8) | (kindsBytes[4 * i + 2] << 16) | (kindsBytes[4 * i + 3] << 24);
    kinds.push({ identifier: (v >>> 31) === 1, count: v & 0x7fffffff });
  }
  const lens = readVarints(lensBytes, h.stringCount);
  const deltas = readSvarints(deltasBytes, h.stringCount);
  const entries = new Array(h.stringCount);
  let si = 0;
  for (const run of kinds) {
    let prev = 0;
    for (let k = 0; k < run.count; k++, si++) {
      const offset = prev + deltas[si];
      entries[si] = { utf16: flags[si] === 1, offset, length: lens[si] };
      prev = offset;
    }
  }
  const stringTable = new ByteWriter(4 * h.stringCount);
  const overflow = new ByteWriter(8 * h.overflowStringCount + 8);
  let overflowCount = 0;
  for (const e of entries) {
    if (e.length >= 255) {
      stringTable.u32(((255 << 24) | (overflowCount << 1) | (e.utf16 ? 1 : 0)) >>> 0);
      overflow.u32(e.offset); overflow.u32(e.length);
      overflowCount++;
    } else {
      stringTable.u32(((e.length << 24) | (e.offset << 1) | (e.utf16 ? 1 : 0)) >>> 0);
    }
  }
  const hashes = new ByteWriter(4 * h.identifierCount + 4);
  si = 0;
  for (const run of kinds) {
    for (let k = 0; k < run.count; k++, si++) {
      if (!run.identifier) continue;
      const e = entries[si];
      hashes.u32(hbc.hashUnits(hbc.unitsFromStorage(storage, e)));
    }
  }

  place('functionHeaders', () => untranspose(funcHeadersT, hbc.SMALL_FUNC_HEADER_SIZE));
  place('stringKinds', () => kindsBytes);
  place('identifierHashes', () => hashes.finish());
  place('stringTable', () => stringTable.finish());
  place('overflowStringTable', () => overflow.finish());
  place('stringStorage', () => storage);
  place('arrayBuffer', () => arrayBuffer);
  place('objKeyBuffer', () => objKeyBuffer);
  place('objShapeTable', () => objShapeTable);
  let mo = 0;
  for (const name of MISC) place(name, () => { const b = misc.subarray(mo, mo + off[name].size); mo += off[name].size; return b; });
  out.set(padding.subarray(padPos, padPos + (off.tablesEnd - o)), o);
  out.set(funcs, off.tablesEnd);
  out.set(debug, h.debugInfoOffset);
  const sha = createHash('sha1').update(out.subarray(0, out.length - 20)).digest();
  out.set(sha, out.length - 20);
  return out;
}
