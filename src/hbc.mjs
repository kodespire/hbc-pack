// Parser for Hermes bytecode files, version 98 (Static Hermes, hermes-compiler 250829098.0.9).
// Layout facts verified against hermesc's own dump; see ../ref/SPEC.md for the source-derived spec.
//
// This module only reads. Every structure keeps enough information to re-serialise the file
// byte for byte (that is the whole point of the codec built on top of it).

export const HEADER_SIZE = 128;
export const SMALL_FUNC_HEADER_SIZE = 12;
export const MAGIC = Buffer.from('c61fbc03c103191f', 'hex');

export class FormatError extends Error {}

export function parseHeader(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  if (!Buffer.from(buf.subarray(0, 8)).equals(MAGIC)) throw new FormatError('bad magic');
  const h = {
    version: u32(8), sourceHash: buf.slice(12, 32), fileLength: u32(32),
    globalCodeIndex: u32(36), functionCount: u32(40), stringKindCount: u32(44), identifierCount: u32(48),
    stringCount: u32(52), overflowStringCount: u32(56), stringStorageSize: u32(60), bigIntCount: u32(64),
    bigIntStorageSize: u32(68), regExpCount: u32(72), regExpStorageSize: u32(76), arrayBufferSize: u32(80),
    objKeyBufferSize: u32(84), objShapeTableCount: u32(88), stringSwitchImmCount: u32(92), segmentID: u32(96),
    cjsModuleCount: u32(100), functionSourceCount: u32(104), debugInfoOffset: u32(108), options: buf[112],
    padding: buf.slice(113, 128),
  };
  if (h.version !== 98) throw new FormatError(`bytecode version ${h.version}, expected 98`);
  if (h.fileLength !== buf.length) throw new FormatError(`fileLength ${h.fileLength} != ${buf.length}`);
  return h;
}

const align4 = (n) => (n + 3) & ~3;

// Section offsets for everything before the per-function region.
export function tableOffsets(h) {
  const off = {};
  let o = HEADER_SIZE;
  const sec = (name, size) => { o = align4(o); off[name] = { start: o, size }; o += size; };
  sec('functionHeaders', SMALL_FUNC_HEADER_SIZE * h.functionCount);
  sec('stringKinds', 4 * h.stringKindCount);
  sec('identifierHashes', 4 * h.identifierCount);
  sec('stringTable', 4 * h.stringCount);
  sec('overflowStringTable', 8 * h.overflowStringCount);
  sec('stringStorage', h.stringStorageSize);
  sec('arrayBuffer', h.arrayBufferSize);
  sec('objKeyBuffer', h.objKeyBufferSize);
  sec('objShapeTable', 8 * h.objShapeTableCount); // ShapeTableEntry {keyBufferOffset, numProps}
  sec('bigIntTable', 8 * h.bigIntCount);
  sec('bigIntStorage', h.bigIntStorageSize);
  sec('regExpTable', 8 * h.regExpCount);
  sec('regExpStorage', h.regExpStorageSize);
  sec('cjsModuleTable', 8 * h.cjsModuleCount);
  sec('functionSourceTable', 8 * h.functionSourceCount);
  off.tablesEnd = align4(o);
  return off;
}

// String kinds: runs of (kind, count). Bit 31 = identifier, low 31 bits = run length.
export function parseStringKinds(buf, off, h) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const runs = [];
  for (let i = 0; i < h.stringKindCount; i++) {
    const v = dv.getUint32(off.stringKinds.start + 4 * i, true);
    runs.push({ identifier: (v >>> 31) === 1, count: v & 0x7fffffff });
  }
  return runs;
}

// Per string: { utf16, offset, length, overflow } where overflow is the index into the overflow
// table when the small entry's length field is 255.
export function parseStringTable(buf, off, h) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries = new Array(h.stringCount);
  for (let i = 0; i < h.stringCount; i++) {
    const e = dv.getUint32(off.stringTable.start + 4 * i, true);
    const utf16 = (e & 1) === 1;
    const field = (e >>> 1) & 0x7fffff;
    const len = e >>> 24;
    if (len === 255) {
      const ob = off.overflowStringTable.start + 8 * field;
      entries[i] = { utf16, offset: dv.getUint32(ob, true), length: dv.getUint32(ob + 4, true), overflow: field };
    } else {
      entries[i] = { utf16, offset: field, length: len, overflow: -1 };
    }
  }
  return entries;
}

// Jenkins one-at-a-time without the final avalanche, over code units (bytes for ASCII strings,
// uint16 for UTF-16 strings). Matches hermes::hashString.
export function hashUnits(units) {
  let h = 0;
  for (let i = 0; i < units.length; i++) {
    h = (h + units[i]) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  return h >>> 0;
}

export function stringUnits(buf, off, entry) {
  const start = off.stringStorage.start + entry.offset;
  if (entry.utf16) {
    const units = new Uint16Array(entry.length);
    for (let i = 0; i < entry.length; i++) units[i] = buf[start + 2 * i] | (buf[start + 2 * i + 1] << 8);
    return units;
  }
  return buf.subarray(start, start + entry.length);
}

// Recomputes the identifier hash array from kinds + strings; returns it as Uint32Array.
export function recomputeIdentifierHashes(buf, off, h, kinds, strings) {
  const out = new Uint32Array(h.identifierCount);
  let si = 0, ii = 0;
  for (const run of kinds) {
    for (let k = 0; k < run.count; k++, si++) {
      if (run.identifier) out[ii++] = hashUnits(stringUnits(buf, off, strings[si]));
    }
  }
  if (si !== h.stringCount || ii !== h.identifierCount) throw new FormatError(`kinds cover ${si} strings / ${ii} identifiers`);
  return out;
}

export function storedIdentifierHashes(buf, off, h) {
  const out = new Uint32Array(h.identifierCount);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < h.identifierCount; i++) out[i] = dv.getUint32(off.identifierHashes.start + 4 * i, true);
  return out;
}

// Header parse for the decoder: the header stream alone, so no file-length check.
export function parseHeaderLoose(headerBytes) {
  const full = new Uint8Array(Math.max(HEADER_SIZE, headerBytes.length));
  full.set(headerBytes);
  const dv = new DataView(full.buffer);
  const u32 = (o) => dv.getUint32(o, true);
  return {
    version: u32(8), fileLength: u32(32), globalCodeIndex: u32(36), functionCount: u32(40), stringKindCount: u32(44),
    identifierCount: u32(48), stringCount: u32(52), overflowStringCount: u32(56), stringStorageSize: u32(60),
    bigIntCount: u32(64), bigIntStorageSize: u32(68), regExpCount: u32(72), regExpStorageSize: u32(76),
    arrayBufferSize: u32(80), objKeyBufferSize: u32(84), objShapeTableCount: u32(88), stringSwitchImmCount: u32(92),
    segmentID: u32(96), cjsModuleCount: u32(100), functionSourceCount: u32(104), debugInfoOffset: u32(108), options: full[112],
  };
}

// Code units of a string entry, read from the storage bytes alone.
export function unitsFromStorage(storage, entry) {
  if (entry.utf16) {
    const units = new Uint16Array(entry.length);
    for (let i = 0; i < entry.length; i++) units[i] = storage[entry.offset + 2 * i] | (storage[entry.offset + 2 * i + 1] << 8);
    return units;
  }
  return storage.subarray(entry.offset, entry.offset + entry.length);
}
