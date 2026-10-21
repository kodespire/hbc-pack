// Parser for Hermes bytecode files (HBC versions 96 and 98; see profiles.mjs for what differs).
// Layout facts verified against hermesc's own dump and the Hermes source in ref/.
//
// This module only reads. Every structure keeps enough information to re-serialise the file
// byte for byte (that is the whole point of the codec built on top of it).
import { profileFor } from './profiles.mjs';

export const HEADER_SIZE = 128;
export const MAGIC = Buffer.from('c61fbc03c103191f', 'hex');

export class FormatError extends Error {}

const align4 = (n) => (n + 3) & ~3;

// Reads the header. `loose` skips the file-length check (decoder side, header stream only).
export function parseHeader(buf, loose = false) {
  const full = loose && buf.length < HEADER_SIZE ? (() => { const f = new Uint8Array(HEADER_SIZE); f.set(buf); return f; })() : buf;
  if (!Buffer.from(full.subarray(0, 8)).equals(MAGIC)) throw new FormatError('bad magic');
  const dv = new DataView(full.buffer, full.byteOffset, full.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  const version = u32(8);
  const profile = profileFor(version);
  const h = { version, profile, sourceHash: full.slice(12, 32) };
  for (const [name, off] of Object.entries(profile.header)) h[name] = u32(off);
  h.options = full[profile.optionsOffset];
  if (!loose && h.fileLength !== buf.length) throw new FormatError(`fileLength ${h.fileLength} != ${buf.length}`);
  return h;
}
export const parseHeaderLoose = (headerBytes) => parseHeader(headerBytes, true);

// Section offsets for everything before the per-function region, from the header counts.
export function tableOffsets(h) {
  const off = {};
  let o = HEADER_SIZE;
  for (const [name, sizeFn] of h.profile.sections) {
    o = align4(o);
    const size = sizeFn(h, h.profile);
    off[name] = { start: o, size };
    o += size;
  }
  off.tablesEnd = align4(o);
  return off;
}

// Names of the table sections in file order (profile dependent in the third literal table).
export const sectionNames = (h) => h.profile.sections.map(([name]) => name);

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
// uint16 for UTF-16 strings). Matches hermes::hashString in both versions.
export function hashUnits(units) {
  let h = 0;
  for (let i = 0; i < units.length; i++) {
    h = (h + units[i]) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  return h >>> 0;
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

export function stringUnits(buf, off, entry) {
  return unitsFromStorage(buf.subarray(off.stringStorage.start, off.stringStorage.start + off.stringStorage.size), entry);
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
