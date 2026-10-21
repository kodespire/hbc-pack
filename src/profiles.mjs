// Everything that differs between HBC bytecode versions: header field offsets, table sections,
// small/large function header layouts, how the info section is laid out, debug-offset size and
// the opcode table. Sources: ref/ (v98, tag hermes-v250829098.0.9) and ref/v96/ (tag hermes-v0.14.0).
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const align4 = (n) => (n + 3) & ~3;

// FunctionHeaderFlag, same bit layout in both versions:
// prohibitInvoke:2 strictMode:1 hasExceptionHandler:1 hasDebugInfo:1 overflowed:1 kind:2 (kind unused in 96)
export function decodeFlags(f) {
  return { prohibitInvoke: f & 3, strictMode: (f >>> 2) & 1, hasExceptionHandler: (f >>> 3) & 1, hasDebugInfo: (f >>> 4) & 1, overflowed: (f >>> 5) & 1, kind: (f >>> 6) & 3 };
}
export function encodeFlags(x) {
  return (x.prohibitInvoke | (x.strictMode << 2) | (x.hasExceptionHandler << 3) | (x.hasDebugInfo << 4) | (x.overflowed << 5) | (x.kind << 6)) & 0xff;
}

const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const put32 = (b, p, v) => { b[p] = v & 0xff; b[p + 1] = (v >>> 8) & 0xff; b[p + 2] = (v >>> 16) & 0xff; b[p + 3] = (v >>> 24) & 0xff; };

// Header u32 fields shared by both versions, at the same offsets up to objKeyBufferSize.
const COMMON_HEADER = {
  fileLength: 32, globalCodeIndex: 36, functionCount: 40, stringKindCount: 44, identifierCount: 48, stringCount: 52, overflowStringCount: 56,
  stringStorageSize: 60, bigIntCount: 64, bigIntStorageSize: 68, regExpCount: 72, regExpStorageSize: 76, arrayBufferSize: 80, objKeyBufferSize: 84,
};

// Sections after the file header, in file order; third literal table differs per version.
const sections = (third) => [
  ['functionHeaders', (h, p) => p.smallHeaderSize * h.functionCount], ['stringKinds', (h) => 4 * h.stringKindCount], ['identifierHashes', (h) => 4 * h.identifierCount],
  ['stringTable', (h) => 4 * h.stringCount], ['overflowStringTable', (h) => 8 * h.overflowStringCount], ['stringStorage', (h) => h.stringStorageSize],
  ['arrayBuffer', (h) => h.arrayBufferSize], ['objKeyBuffer', (h) => h.objKeyBufferSize], third,
  ['bigIntTable', (h) => 8 * h.bigIntCount], ['bigIntStorage', (h) => h.bigIntStorageSize], ['regExpTable', (h) => 8 * h.regExpCount], ['regExpStorage', (h) => h.regExpStorageSize],
  ['cjsModuleTable', (h) => 8 * h.cjsModuleCount], ['functionSourceTable', (h) => 8 * h.functionSourceCount],
];

export const PROFILES = {
  98: {
    version: 98,
    header: { ...COMMON_HEADER, objShapeTableCount: 88, stringSwitchImmCount: 92, segmentID: 96, cjsModuleCount: 100, functionSourceCount: 104, debugInfoOffset: 108 },
    optionsOffset: 112,
    sections: sections(['objShapeTable', (h) => 8 * h.objShapeTableCount]),
    thirdLiteralTable: 'objShapeTable',
    smallHeaderSize: 12, largeHeaderSize: 40, debugOffsetsSize: 4,
    opcodesFile: path.join(HERE, '../ref/opcodes.json'),
    switchOps: { UIntSwitchImm: 'uint', StringSwitchImm: 'string' },
    // Header fields coded as columns (everything but offset/infoOffset, which are derived).
    columns: [['paramCount', 'u8'], ['loopDepth', 'u8'], ['numberRegCount', 'u8'], ['nonPtrRegCount', 'u8'], ['readCacheSize', 'u8'], ['writeCacheSize', 'u8'],
      ['flagsByte', 'u8'], ['privateNameCacheSize', 'u8'], ['numCacheNewObject', 'u8'], ['bytecodeSize', 'varint'], ['functionName', 'varint'], ['frameSize', 'varint']],
    decodeSmall(b, p) {
      const w1 = u32(b, p), w2 = u32(b, p + 4);
      return { offset: w1 & 0x1ffffff, paramCount: (w1 >>> 25) & 31, loopDepth: (w1 >>> 30) & 3, bytecodeSize: w2 & 0x3fff, functionName: (w2 >>> 14) & 0xff,
        numberRegCount: (w2 >>> 22) & 31, nonPtrRegCount: (w2 >>> 27) & 31, frameSize: b[p + 8], readCacheSize: b[p + 9], writeCacheSize: b[p + 10] & 63,
        numCacheNewObject: (b[p + 10] >>> 6) & 1, privateNameCacheSize: (b[p + 10] >>> 7) & 1, flags: decodeFlags(b[p + 11]) };
    },
    encodeSmall(h, out, p) {
      put32(out, p, (h.offset | (h.paramCount << 25) | (h.loopDepth << 30)) >>> 0);
      put32(out, p + 4, (h.bytecodeSize | (h.functionName << 14) | (h.numberRegCount << 22) | (h.nonPtrRegCount << 27)) >>> 0);
      out[p + 8] = h.frameSize; out[p + 9] = h.readCacheSize; out[p + 10] = (h.writeCacheSize | (h.numCacheNewObject << 6) | (h.privateNameCacheSize << 7)) & 0xff; out[p + 11] = encodeFlags(h.flags);
    },
    // Pointer form: everything zero except the 32-bit large-header offset split over offset (24 bits) and functionName (8 bits), flags = overflowed only.
    largeOffset(small) { return ((small.functionName << 24) | small.offset) >>> 0; },
    encodePointerSmall(large, largeOffset, out, p) {
      out.fill(0, p, p + 12);
      put32(out, p, largeOffset & 0xffffff); put32(out, p + 4, ((largeOffset >>> 24) & 0xff) << 14); out[p + 11] = 0x20;
    },
    isPointerSmallValid(small) { // what the writer produces for the pointer form
      return small.paramCount === 0 && small.loopDepth === 0 && small.bytecodeSize === 0 && small.numberRegCount === 0 && small.nonPtrRegCount === 0 &&
        small.frameSize === 0 && small.readCacheSize === 0 && small.writeCacheSize === 0 && small.numCacheNewObject === 0 && small.privateNameCacheSize === 0 && encodeFlags(small.flags) === 0x20;
    },
    decodeLarge(b, p) {
      return { offset: u32(b, p), paramCount: u32(b, p + 4), loopDepth: u32(b, p + 8), bytecodeSize: u32(b, p + 12), functionName: u32(b, p + 16), numberRegCount: u32(b, p + 20),
        nonPtrRegCount: u32(b, p + 24), frameSize: u32(b, p + 28), readCacheSize: b[p + 32], writeCacheSize: b[p + 33], numCacheNewObject: b[p + 34], privateNameCacheSize: b[p + 35],
        flags: decodeFlags(b[p + 36]), pad: [b[p + 37], b[p + 38], b[p + 39]] };
    },
    encodeLarge(h, out, p) {
      put32(out, p, h.offset); put32(out, p + 4, h.paramCount); put32(out, p + 8, h.loopDepth); put32(out, p + 12, h.bytecodeSize); put32(out, p + 16, h.functionName);
      put32(out, p + 20, h.numberRegCount); put32(out, p + 24, h.nonPtrRegCount); put32(out, p + 28, h.frameSize);
      out[p + 32] = h.readCacheSize; out[p + 33] = h.writeCacheSize; out[p + 34] = h.numCacheNewObject; out[p + 35] = h.privateNameCacheSize; out[p + 36] = encodeFlags(h.flags);
      out[p + 37] = out[p + 38] = out[p + 39] = 0;
    },
    fitsSmall(h) {
      return h.offset < (1 << 25) && h.paramCount < 32 && h.loopDepth < 4 && h.bytecodeSize < (1 << 14) && h.functionName < 256 && h.numberRegCount < 32 && h.nonPtrRegCount < 32 &&
        h.frameSize < 256 && h.readCacheSize < 256 && h.writeCacheSize < 64 && h.numCacheNewObject < 2 && h.privateNameCacheSize < 2;
    },
    // v98: a function has an info block iff it has exceptions, debug info, or does not fit; the
    // block always starts with the large header.
    infoPolicy: 'needed',
  },

  96: {
    version: 96,
    header: { ...COMMON_HEADER, objValueBufferSize: 88, segmentID: 92, cjsModuleCount: 96, functionSourceCount: 100, debugInfoOffset: 104 },
    optionsOffset: 108,
    sections: sections(['objValueBuffer', (h) => h.objValueBufferSize]),
    thirdLiteralTable: 'objValueBuffer',
    smallHeaderSize: 16, largeHeaderSize: 32, debugOffsetsSize: 8,
    opcodesFile: path.join(HERE, '../ref/v96/opcodes.json'),
    switchOps: { SwitchImm: 'uint' },
    columns: [['readCacheSize', 'u8'], ['writeCacheSize', 'u8'], ['flagsByte', 'u8'], ['paramCount', 'varint'], ['bytecodeSize', 'varint'], ['functionName', 'varint'],
      ['frameSize', 'varint'], ['environmentSize', 'varint']],
    decodeSmall(b, p) {
      const w1 = u32(b, p), w2 = u32(b, p + 4), w3 = u32(b, p + 8);
      return { offset: w1 & 0x1ffffff, paramCount: w1 >>> 25, bytecodeSize: w2 & 0x7fff, functionName: w2 >>> 15, infoOffset: w3 & 0x1ffffff, frameSize: w3 >>> 25,
        environmentSize: b[p + 12], readCacheSize: b[p + 13], writeCacheSize: b[p + 14], flags: decodeFlags(b[p + 15]) };
    },
    encodeSmall(h, out, p) {
      put32(out, p, (h.offset | (h.paramCount << 25)) >>> 0); put32(out, p + 4, (h.bytecodeSize | (h.functionName << 15)) >>> 0); put32(out, p + 8, (h.infoOffset | (h.frameSize << 25)) >>> 0);
      out[p + 12] = h.environmentSize; out[p + 13] = h.readCacheSize; out[p + 14] = h.writeCacheSize; out[p + 15] = encodeFlags(h.flags);
    },
    largeOffset(small) { return ((small.infoOffset << 16) | small.offset) >>> 0; },
    // Pointer form (SmallFuncHeader(const FunctionHeader&)): fields are copied in order until the
    // first one that does not fit; then offset/infoOffset take the large-header offset and flags
    // get the overflowed bit. Fields after the overflowing one stay zero.
    encodePointerSmall(large, largeOffset, out, p) {
      const fields = [['offset', 25], ['paramCount', 7], ['bytecodeSize', 15], ['functionName', 17], ['infoOffset', 25], ['frameSize', 7], ['environmentSize', 8], ['readCacheSize', 8], ['writeCacheSize', 8]];
      const h = { offset: 0, paramCount: 0, bytecodeSize: 0, functionName: 0, infoOffset: 0, frameSize: 0, environmentSize: 0, readCacheSize: 0, writeCacheSize: 0, flags: { ...large.flags, overflowed: 1 } };
      for (const [name, bits] of fields) {
        if (large[name] > (2 ** bits) - 1) break;
        h[name] = large[name];
      }
      h.offset = largeOffset & 0xffff; h.infoOffset = largeOffset >>> 16;
      this.encodeSmall(h, out, p);
    },
    isPointerSmallValid() { return true; }, // checked by re-encoding in the gate instead
    decodeLarge(b, p) {
      return { offset: u32(b, p), paramCount: u32(b, p + 4), bytecodeSize: u32(b, p + 8), functionName: u32(b, p + 12), infoOffset: u32(b, p + 16), frameSize: u32(b, p + 20),
        environmentSize: u32(b, p + 24), readCacheSize: b[p + 28], writeCacheSize: b[p + 29], flags: decodeFlags(b[p + 30]), pad: [b[p + 31]] };
    },
    encodeLarge(h, out, p) {
      put32(out, p, h.offset); put32(out, p + 4, h.paramCount); put32(out, p + 8, h.bytecodeSize); put32(out, p + 12, h.functionName); put32(out, p + 16, h.infoOffset);
      put32(out, p + 20, h.frameSize); put32(out, p + 24, h.environmentSize); out[p + 28] = h.readCacheSize; out[p + 29] = h.writeCacheSize; out[p + 30] = encodeFlags(h.flags); out[p + 31] = 0;
    },
    fitsSmall(h) {
      return h.offset < (1 << 25) && h.paramCount < 128 && h.bytecodeSize < (1 << 15) && h.functionName < (1 << 17) && h.infoOffset < (1 << 25) && h.frameSize < 128 &&
        h.environmentSize < 256 && h.readCacheSize < 256 && h.writeCacheSize < 256;
    },
    // v96: every function gets infoOffset = align4(position) in order; the large header is written
    // only when the small one overflows; exceptions and debug offsets follow when present.
    infoPolicy: 'always',
  },
};

// HBC 99 (hermes-compiler 260318099.x, React Native 0.88): same header and serializer as 98; the
// function header drops NumCacheNewObject and widens WriteCacheSize to 7 bits (large header 36
// bytes); opcodes: +NewTypedObjectWithBuffer +ToUint32 -CacheNewObject (numbering shifts).
PROFILES[99] = {
  ...PROFILES[98],
  version: 99,
  largeHeaderSize: 36,
  opcodesFile: path.join(HERE, '../ref/v99/opcodes.json'),
  columns: [['paramCount', 'u8'], ['loopDepth', 'u8'], ['numberRegCount', 'u8'], ['nonPtrRegCount', 'u8'], ['readCacheSize', 'u8'], ['writeCacheSize', 'u8'],
    ['flagsByte', 'u8'], ['privateNameCacheSize', 'u8'], ['bytecodeSize', 'varint'], ['functionName', 'varint'], ['frameSize', 'varint']],
  decodeSmall(b, p) {
    const w1 = u32(b, p), w2 = u32(b, p + 4);
    return { offset: w1 & 0x1ffffff, paramCount: (w1 >>> 25) & 31, loopDepth: (w1 >>> 30) & 3, bytecodeSize: w2 & 0x3fff, functionName: (w2 >>> 14) & 0xff,
      numberRegCount: (w2 >>> 22) & 31, nonPtrRegCount: (w2 >>> 27) & 31, frameSize: b[p + 8], readCacheSize: b[p + 9], writeCacheSize: b[p + 10] & 127,
      privateNameCacheSize: (b[p + 10] >>> 7) & 1, flags: decodeFlags(b[p + 11]) };
  },
  encodeSmall(h, out, p) {
    put32(out, p, (h.offset | (h.paramCount << 25) | (h.loopDepth << 30)) >>> 0);
    put32(out, p + 4, (h.bytecodeSize | (h.functionName << 14) | (h.numberRegCount << 22) | (h.nonPtrRegCount << 27)) >>> 0);
    out[p + 8] = h.frameSize; out[p + 9] = h.readCacheSize; out[p + 10] = (h.writeCacheSize | (h.privateNameCacheSize << 7)) & 0xff; out[p + 11] = encodeFlags(h.flags);
  },
  isPointerSmallValid(small) {
    return small.paramCount === 0 && small.loopDepth === 0 && small.bytecodeSize === 0 && small.numberRegCount === 0 && small.nonPtrRegCount === 0 &&
      small.frameSize === 0 && small.readCacheSize === 0 && small.writeCacheSize === 0 && small.privateNameCacheSize === 0 && encodeFlags(small.flags) === 0x20;
  },
  decodeLarge(b, p) {
    return { offset: u32(b, p), paramCount: u32(b, p + 4), loopDepth: u32(b, p + 8), bytecodeSize: u32(b, p + 12), functionName: u32(b, p + 16), numberRegCount: u32(b, p + 20),
      nonPtrRegCount: u32(b, p + 24), frameSize: u32(b, p + 28), readCacheSize: b[p + 32], writeCacheSize: b[p + 33], privateNameCacheSize: b[p + 34],
      flags: decodeFlags(b[p + 35]), pad: [] };
  },
  encodeLarge(h, out, p) {
    put32(out, p, h.offset); put32(out, p + 4, h.paramCount); put32(out, p + 8, h.loopDepth); put32(out, p + 12, h.bytecodeSize); put32(out, p + 16, h.functionName);
    put32(out, p + 20, h.numberRegCount); put32(out, p + 24, h.nonPtrRegCount); put32(out, p + 28, h.frameSize);
    out[p + 32] = h.readCacheSize; out[p + 33] = h.writeCacheSize; out[p + 34] = h.privateNameCacheSize; out[p + 35] = encodeFlags(h.flags);
  },
  fitsSmall(h) {
    return h.offset < (1 << 25) && h.paramCount < 32 && h.loopDepth < 4 && h.bytecodeSize < (1 << 14) && h.functionName < 256 && h.numberRegCount < 32 && h.nonPtrRegCount < 32 &&
      h.frameSize < 256 && h.readCacheSize < 256 && h.writeCacheSize < 128 && h.privateNameCacheSize < 2;
  },
};

// HBC 94 (React Native 0.72's bundled hermesc, hermes-2024-04-29-RNv0.72.14): identical to 96 in
// header, function headers, serializer, strings and hashes; the same 206 opcodes, numbered
// differently.
PROFILES[94] = { ...PROFILES[96], version: 94, opcodesFile: path.join(HERE, '../ref/v94/opcodes.json') };

export function profileFor(version) {
  const p = PROFILES[version];
  if (!p) throw new Error(`unsupported HBC bytecode version ${version}`);
  return p;
}

export { align4 };
