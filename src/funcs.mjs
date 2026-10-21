// Function region of an HBC v98 file: small headers, deduplicated bytecode bodies with inline
// switch tables, and the per-function "info" section (large header, exception table, debug
// offsets). Mirrors BytecodeSerializer in ref/BytecodeStream.cpp.
import * as isa from './isa.mjs';

export const LARGE_HEADER_SIZE = 40; // 8 x u32 + 4 x u8 + flags + 3 padding bytes
const align4 = (n) => (n + 3) & ~3;

const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

export function decodeFlags(f) {
  return { prohibitInvoke: f & 3, strictMode: (f >>> 2) & 1, hasExceptionHandler: (f >>> 3) & 1, hasDebugInfo: (f >>> 4) & 1, overflowed: (f >>> 5) & 1, kind: (f >>> 6) & 3 };
}
export function encodeFlags(x) {
  return (x.prohibitInvoke | (x.strictMode << 2) | (x.hasExceptionHandler << 3) | (x.hasDebugInfo << 4) | (x.overflowed << 5) | (x.kind << 6)) & 0xff;
}

export function decodeSmallHeader(b, p) {
  const w1 = u32(b, p), w2 = u32(b, p + 4);
  return {
    offset: w1 & 0x1ffffff, paramCount: (w1 >>> 25) & 31, loopDepth: (w1 >>> 30) & 3,
    bytecodeSize: w2 & 0x3fff, functionName: (w2 >>> 14) & 0xff, numberRegCount: (w2 >>> 22) & 31, nonPtrRegCount: (w2 >>> 27) & 31,
    frameSize: b[p + 8], readCacheSize: b[p + 9], writeCacheSize: b[p + 10] & 63, numCacheNewObject: (b[p + 10] >>> 6) & 1, privateNameCacheSize: (b[p + 10] >>> 7) & 1,
    flags: decodeFlags(b[p + 11]),
  };
}

export function encodeSmallHeader(h, out, p) {
  const w1 = (h.offset | (h.paramCount << 25) | (h.loopDepth << 30)) >>> 0;
  const w2 = (h.bytecodeSize | (h.functionName << 14) | (h.numberRegCount << 22) | (h.nonPtrRegCount << 27)) >>> 0;
  out[p] = w1 & 0xff; out[p + 1] = (w1 >>> 8) & 0xff; out[p + 2] = (w1 >>> 16) & 0xff; out[p + 3] = (w1 >>> 24) & 0xff;
  out[p + 4] = w2 & 0xff; out[p + 5] = (w2 >>> 8) & 0xff; out[p + 6] = (w2 >>> 16) & 0xff; out[p + 7] = (w2 >>> 24) & 0xff;
  out[p + 8] = h.frameSize; out[p + 9] = h.readCacheSize;
  out[p + 10] = (h.writeCacheSize | (h.numCacheNewObject << 6) | (h.privateNameCacheSize << 7)) & 0xff;
  out[p + 11] = encodeFlags(h.flags);
}

export function decodeLargeHeader(b, p) {
  return {
    offset: u32(b, p), paramCount: u32(b, p + 4), loopDepth: u32(b, p + 8), bytecodeSize: u32(b, p + 12), functionName: u32(b, p + 16),
    numberRegCount: u32(b, p + 20), nonPtrRegCount: u32(b, p + 24), frameSize: u32(b, p + 28),
    readCacheSize: b[p + 32], writeCacheSize: b[p + 33], numCacheNewObject: b[p + 34], privateNameCacheSize: b[p + 35],
    flags: decodeFlags(b[p + 36]), pad: [b[p + 37], b[p + 38], b[p + 39]],
  };
}

export function encodeLargeHeader(h, out, p) {
  const put = (o, v) => { out[p + o] = v & 0xff; out[p + o + 1] = (v >>> 8) & 0xff; out[p + o + 2] = (v >>> 16) & 0xff; out[p + o + 3] = (v >>> 24) & 0xff; };
  put(0, h.offset); put(4, h.paramCount); put(8, h.loopDepth); put(12, h.bytecodeSize); put(16, h.functionName);
  put(20, h.numberRegCount); put(24, h.nonPtrRegCount); put(28, h.frameSize);
  out[p + 32] = h.readCacheSize; out[p + 33] = h.writeCacheSize; out[p + 34] = h.numCacheNewObject; out[p + 35] = h.privateNameCacheSize;
  out[p + 36] = encodeFlags(h.flags); out[p + 37] = h.pad[0]; out[p + 38] = h.pad[1]; out[p + 39] = h.pad[2];
}

// A header fits the small form when every field is within its bit width.
export function fitsSmall(h) {
  return h.offset < (1 << 25) && h.paramCount < 32 && h.loopDepth < 4 && h.bytecodeSize < (1 << 14) && h.functionName < 256 &&
    h.numberRegCount < 32 && h.nonPtrRegCount < 32 && h.frameSize < 256 && h.readCacheSize < 256 && h.writeCacheSize < 64 &&
    h.numCacheNewObject < 2 && h.privateNameCacheSize < 2;
}

// Total bytes of switch tables appended after a body's opcodes, from its switch instructions.
function switchTableBytes(instructions, ops) {
  let bytes = 0;
  for (const ins of instructions) {
    const name = ops[ins.opcode].name;
    if (name === 'UIntSwitchImm') bytes += 4 * (ins.operands[4] - ins.operands[3] + 1);
    else if (name === 'StringSwitchImm') bytes += 8 * ins.operands[4];
  }
  return bytes;
}

/**
 * Parses the function region. `buf` is the whole file, `start` the first function's offset,
 * `headerTable` the offset of the small headers. Returns:
 *   functions[i] = { small, large|null, hasInfo, body: index into bodies or -1 when reusing,
 *                    reuseOf: function index whose body is shared, exceptions: [...]|null,
 *                    debugOffset: number|null }
 *   bodies[k]    = { offset, size, instructions, tableBytes, tables: Uint8Array, padAfterOps }
 *   infoStart, infoEnd, padBytes (bytes in alignment gaps inside the info section)
 */
export function parseFunctionRegion(buf, headerTable, functionCount, start) {
  const ops = isa.loadOpcodes();
  const functions = new Array(functionCount);
  const bodies = [];
  const bodyByOffset = new Map();
  let loc = start;

  // Pass 1: headers (small, and large via the info pointer).
  for (let i = 0; i < functionCount; i++) {
    const small = decodeSmallHeader(buf, headerTable + 12 * i);
    let large = null, infoOffset = -1;
    if (small.flags.overflowed) {
      infoOffset = ((small.functionName << 24) | small.offset) >>> 0;
      large = decodeLargeHeader(buf, infoOffset);
    }
    functions[i] = { small, large, infoOffset, h: large ?? small };
  }

  // Pass 2: bytecode bodies in function order, with deduplication. The serializer keys its
  // dedup map on the body bytes; (offset, size) identifies a body here. Empty bodies all share
  // the offset of the first empty function (nothing is written for them).
  for (let i = 0; i < functionCount; i++) {
    const f = functions[i];
    const h = f.h;
    const key = `${h.offset}:${h.bytecodeSize}`;
    const existing = bodyByOffset.get(key);
    if (existing !== undefined) {
      f.body = existing; f.reuse = true;
      continue;
    }
    if (h.offset !== loc) throw new Error(`function ${i}: offset ${h.offset} != expected ${loc}`);
    const { ops: instructions, end } = isa.walk(buf, h.offset, h.offset + h.bytecodeSize);
    if (end !== h.offset + h.bytecodeSize) throw new Error(`function ${i}: walked to ${end}, size says ${h.offset + h.bytecodeSize}`);
    const tableBytes = switchTableBytes(instructions, ops);
    let bodyEnd = h.offset + h.bytecodeSize;
    let padAfterOps = null;
    let tables = null;
    if (tableBytes) {
      const aligned = align4(bodyEnd);
      padAfterOps = buf.slice(bodyEnd, aligned);
      tables = buf.slice(aligned, aligned + tableBytes);
      bodyEnd = aligned + tableBytes;
    }
    const k = bodies.length;
    bodies.push({ offset: h.offset, size: h.bytecodeSize, instructions, tableBytes, tables, padAfterOps, end: bodyEnd });
    bodyByOffset.set(key, k);
    f.body = k; f.reuse = false;
    loc = bodyEnd;
  }
  const bytecodeEnd = loc;

  // Pass 3: info section, in function order.
  const infoStart = align4(loc);
  loc = infoStart;
  const padBytes = [];
  for (let i = 0; i < functionCount; i++) {
    const f = functions[i];
    if (f.infoOffset < 0) continue;
    const aligned = align4(loc);
    if (aligned !== f.infoOffset) throw new Error(`function ${i}: infoOffset ${f.infoOffset} != expected ${aligned}`);
    for (let p = loc; p < aligned; p++) padBytes.push(buf[p]);
    loc = aligned + LARGE_HEADER_SIZE;
    const h = f.large;
    if (h.flags.hasExceptionHandler) {
      const count = u32(buf, loc); loc += 4;
      f.exceptions = new Array(count);
      for (let e = 0; e < count; e++) { f.exceptions[e] = [u32(buf, loc), u32(buf, loc + 4), u32(buf, loc + 8)]; loc += 12; }
    } else f.exceptions = null;
    if (h.flags.hasDebugInfo) { f.debugOffset = u32(buf, loc); loc += 4; } else f.debugOffset = null;
    // The small header of a function with info must be the pointer form.
    if (!(f.small.paramCount === 0 && f.small.loopDepth === 0 && f.small.bytecodeSize === 0 && f.small.numberRegCount === 0 &&
      f.small.nonPtrRegCount === 0 && f.small.frameSize === 0 && f.small.readCacheSize === 0 && f.small.writeCacheSize === 0 &&
      f.small.numCacheNewObject === 0 && f.small.privateNameCacheSize === 0 && encodeFlags(f.small.flags) === 0x20)) {
      throw new Error(`function ${i}: pointer-form small header has unexpected fields`);
    }
    // A function has an info block iff it needs one.
    if (!(h.flags.hasExceptionHandler || h.flags.hasDebugInfo || !fitsSmall(h))) throw new Error(`function ${i}: has info but would not need it`);
  }
  for (let i = 0; i < functionCount; i++) {
    const f = functions[i];
    if (f.infoOffset < 0 && (f.small.flags.hasExceptionHandler || f.small.flags.hasDebugInfo)) throw new Error(`function ${i}: needs info but has none`);
  }
  return { functions, bodies, bytecodeEnd, infoStart, infoEnd: loc, padBytes };
}

// Re-serialises headers + region from the parsed structure, into `out` (whole-file buffer).
export function writeFunctionRegion(parsed, out, headerTable, start) {
  const { functions, bodies } = parsed;
  // Bodies.
  let loc = start;
  for (const b of bodies) {
    if (b.offset !== loc) throw new Error(`body offset ${b.offset} != ${loc}`);
    loc = isa.emit(b.instructions, out, loc);
    if (b.tableBytes) {
      out.set(b.padAfterOps, loc); loc += b.padAfterOps.length;
      out.set(b.tables, loc); loc += b.tableBytes;
    }
  }
  // Info section.
  let padPos = 0;
  loc = align4(loc);
  for (let i = 0; i < functions.length; i++) {
    const f = functions[i];
    if (f.infoOffset < 0) {
      encodeSmallHeader(f.small, out, headerTable + 12 * i);
      continue;
    }
    const aligned = align4(loc);
    for (let p = loc; p < aligned; p++) out[p] = parsed.padBytes[padPos++];
    loc = aligned;
    const ptr = { offset: loc & 0xffffff, paramCount: 0, loopDepth: 0, bytecodeSize: 0, functionName: (loc >>> 24) & 0xff, numberRegCount: 0, nonPtrRegCount: 0,
      frameSize: 0, readCacheSize: 0, writeCacheSize: 0, numCacheNewObject: 0, privateNameCacheSize: 0, flags: decodeFlags(0x20) };
    encodeSmallHeader(ptr, out, headerTable + 12 * i);
    encodeLargeHeader(f.large, out, loc); loc += LARGE_HEADER_SIZE;
    if (f.exceptions) {
      const n = f.exceptions.length;
      out[loc] = n & 0xff; out[loc + 1] = (n >>> 8) & 0xff; out[loc + 2] = (n >>> 16) & 0xff; out[loc + 3] = (n >>> 24) & 0xff; loc += 4;
      for (const [s, e, t] of f.exceptions) {
        for (const v of [s, e, t]) { out[loc] = v & 0xff; out[loc + 1] = (v >>> 8) & 0xff; out[loc + 2] = (v >>> 16) & 0xff; out[loc + 3] = (v >>> 24) & 0xff; loc += 4; }
      }
    }
    if (f.debugOffset !== null) { const v = f.debugOffset; out[loc] = v & 0xff; out[loc + 1] = (v >>> 8) & 0xff; out[loc + 2] = (v >>> 16) & 0xff; out[loc + 3] = (v >>> 24) & 0xff; loc += 4; }
  }
  return loc;
}
