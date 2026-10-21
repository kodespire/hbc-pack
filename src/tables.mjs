// Table sections (everything between the file header and the first function body) as streams,
// and their exact reconstruction. Shared by the codec versions.
import * as hbc from './hbc.mjs';
import { ByteWriter, concat, readSvarints, readVarints, svarintArray, varintArray } from './bits.mjs';

export const MISC = ['bigIntTable', 'bigIntStorage', 'regExpTable', 'regExpStorage', 'cjsModuleTable', 'functionSourceTable'];

export const slice = (buf, sec) => buf.subarray(sec.start, sec.start + sec.size);

// Bytes in the alignment gaps between sections (normally zero), in order. `names` is the
// profile's section order (hbc.sectionNames(h)).
export function paddingBytes(buf, off, names) {
  const parts = [];
  let o = hbc.HEADER_SIZE;
  for (const name of names) {
    const s = off[name];
    parts.push(buf.subarray(o, s.start));
    o = s.start + s.size;
  }
  parts.push(buf.subarray(o, off.tablesEnd));
  return concat(parts);
}

// String table as three columns: utf16 flag, length, offset delta from the previous string of
// the same kind run.
// With `relEnd`, the delta is taken from the previous string's end (offset + byte length), so
// contiguous strings code as 0 and overlapping ones as small negatives.
export function stringColumns(kinds, strings, relEnd = false) {
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
      prev = relEnd ? s.offset + s.length * (s.utf16 ? 2 : 1) : s.offset;
    }
  }
  return { flags, lens: varintArray(lens), deltas: svarintArray(deltas) };
}

export function parseKindsBytes(kindsBytes, count) {
  const kinds = [];
  for (let i = 0; i < count; i++) {
    const v = kindsBytes[4 * i] | (kindsBytes[4 * i + 1] << 8) | (kindsBytes[4 * i + 2] << 16) | (kindsBytes[4 * i + 3] << 24);
    kinds.push({ identifier: (v >>> 31) === 1, count: v & 0x7fffffff });
  }
  return kinds;
}

// Rebuilds string table, overflow table and identifier hashes from the columns + storage.
export function rebuildStringTables(h, kinds, flags, lensBytes, deltasBytes, storage, relEnd = false) {
  const lens = readVarints(lensBytes, h.stringCount);
  const deltas = readSvarints(deltasBytes, h.stringCount);
  const entries = new Array(h.stringCount);
  let si = 0;
  for (const run of kinds) {
    let prev = 0;
    for (let k = 0; k < run.count; k++, si++) {
      const offset = prev + deltas[si];
      const utf16 = flags[si] === 1;
      entries[si] = { utf16, offset, length: lens[si] };
      prev = relEnd ? offset + lens[si] * (utf16 ? 2 : 1) : offset;
    }
  }
  const stringTable = new ByteWriter(4 * h.stringCount + 4);
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
      if (run.identifier) hashes.u32(hbc.hashUnits(hbc.unitsFromStorage(storage, entries[si])));
    }
  }
  return { stringTable: stringTable.finish(), overflow: overflow.finish(), hashes: hashes.finish(), entries };
}

// Writes every table section except functionHeaders into `out`; the caller writes headers.
// `names` is the profile's section order; `parts` maps section names (or kinds/hashes/
// stringTable/overflow/storage/misc) to bytes. Throws on size mismatch.
export function placeTables(out, h, off, names, parts) {
  const bytesFor = { stringKinds: parts.kinds, identifierHashes: parts.hashes, stringTable: parts.stringTable, overflowStringTable: parts.overflow, stringStorage: parts.storage };
  let padPos = 0, mo = 0;
  let o = hbc.HEADER_SIZE;
  for (const name of names) {
    const s = off[name];
    out.set(parts.padding.subarray(padPos, padPos + (s.start - o)), o); padPos += s.start - o;
    let bytes = null;
    if (name === 'functionHeaders') bytes = null;
    else if (name in bytesFor) bytes = bytesFor[name];
    else if (MISC.includes(name)) { bytes = parts.misc.subarray(mo, mo + s.size); mo += s.size; }
    else bytes = parts[name];
    if (bytes && bytes.length !== s.size) throw new Error(`${name}: ${bytes.length} != ${s.size}`);
    if (bytes) out.set(bytes, s.start);
    o = s.start + s.size;
  }
  out.set(parts.padding.subarray(padPos, padPos + (off.tablesEnd - o)), o);
}
