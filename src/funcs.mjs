// Function region of an HBC file: small headers, deduplicated bytecode bodies with inline
// switch tables, and the per-function "info" section (large header, exception table, debug
// offsets). Mirrors BytecodeSerializer in ref/BytecodeStream.cpp (v98) and ref/v96/ (v96);
// the version differences live in profiles.mjs.
import * as isa from './isa.mjs';
import { encodeFlags } from './profiles.mjs';

const align4 = (n) => (n + 3) & ~3;
const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const put32 = (b, p, v) => { b[p] = v & 0xff; b[p + 1] = (v >>> 8) & 0xff; b[p + 2] = (v >>> 16) & 0xff; b[p + 3] = (v >>> 24) & 0xff; };

/**
 * Parses the function region. Returns:
 *   functions[i] = { small, large|null, infoOffset (-1 when no info block), h (effective header),
 *                    body (index into bodies), reuse (bool), exceptions: [[s,e,t]...]|null,
 *                    debugOffsets: Uint8Array|null }
 *   bodies[k]    = { offset, size, instructions, tableBytes, tables, padAfterOps, end }
 *   bytecodeEnd, infoStart, infoEnd, padBytes (bytes in alignment gaps inside the info section)
 */
export function parseFunctionRegion(buf, h, headerTable, start) {
  const P = h.profile;
  const ops = isa.opcodes(h.version);
  const n = h.functionCount;
  const functions = new Array(n);
  const bodies = [];
  const bodyByKey = new Map();
  let loc = start;

  // Pass 1: headers (small, and large via the pointer form).
  for (let i = 0; i < n; i++) {
    const small = P.decodeSmall(buf, headerTable + P.smallHeaderSize * i);
    let large = null, largeOffset = -1;
    if (small.flags.overflowed) {
      largeOffset = P.largeOffset(small);
      large = P.decodeLarge(buf, largeOffset);
      if (large.flags.overflowed) throw new Error(`function ${i}: large header has the overflowed flag`);
      if (large.pad.some((x) => x)) throw new Error(`function ${i}: non-zero large header padding`);
      if (!P.isPointerSmallValid(small)) throw new Error(`function ${i}: pointer-form small header has unexpected fields`);
    }
    functions[i] = { small, large, largeOffset, h: large ?? small };
  }

  // Pass 2: bytecode bodies in function order, with deduplication. The serializer keys its
  // dedup map on the body bytes; (offset, size) identifies a body here. Empty bodies all share
  // the offset of the first empty function (nothing is written for them).
  for (let i = 0; i < n; i++) {
    const f = functions[i];
    const x = f.h;
    const key = `${x.offset}:${x.bytecodeSize}`;
    const existing = bodyByKey.get(key);
    if (existing !== undefined) { f.body = existing; f.reuse = true; continue; }
    if (x.offset !== loc) throw new Error(`function ${i}: offset ${x.offset} != expected ${loc}`);
    const { ops: instructions, end } = isa.walk(ops, buf, x.offset, x.offset + x.bytecodeSize);
    if (end !== x.offset + x.bytecodeSize) throw new Error(`function ${i}: walked to ${end}, size says ${x.offset + x.bytecodeSize}`);
    const tableBytes = isa.switchTableBytes(ops, instructions);
    let bodyEnd = x.offset + x.bytecodeSize, padAfterOps = null, tables = null;
    if (tableBytes) {
      const aligned = align4(bodyEnd);
      padAfterOps = buf.slice(bodyEnd, aligned);
      tables = buf.slice(aligned, aligned + tableBytes);
      bodyEnd = aligned + tableBytes;
    }
    const k = bodies.length;
    bodies.push({ offset: x.offset, size: x.bytecodeSize, instructions, tableBytes, tables, padAfterOps, end: bodyEnd });
    bodyByKey.set(key, k);
    f.body = k; f.reuse = false;
    loc = bodyEnd;
  }
  const bytecodeEnd = loc;

  // Pass 3: info section, in function order.
  const infoStart = align4(loc);
  loc = infoStart;
  const padBytes = [];
  for (let i = 0; i < n; i++) {
    const f = functions[i];
    const x = f.h;
    const hasExc = x.flags.hasExceptionHandler, hasDbg = x.flags.hasDebugInfo;
    if (P.infoPolicy === 'needed') {
      // v98: an info block iff needed; it starts with the large header and the small header is a pointer to it.
      const needs = !!(hasExc || hasDbg || !P.fitsSmall(x));
      if (needs !== (f.large !== null)) throw new Error(`function ${i}: info block ${f.large ? 'present' : 'absent'} but ${needs ? 'needed' : 'not needed'}`);
      if (!needs) { f.infoOffset = -1; f.exceptions = null; f.debugOffsets = null; continue; }
      const aligned = align4(loc);
      if (aligned !== f.largeOffset) throw new Error(`function ${i}: info at ${f.largeOffset}, expected ${aligned}`);
      for (let p = loc; p < aligned; p++) padBytes.push(buf[p]);
      f.infoOffset = aligned;
      loc = aligned + P.largeHeaderSize;
    } else {
      // v96: every function gets infoOffset = align4(loc); the large header only when overflowed.
      const aligned = align4(loc);
      for (let p = loc; p < aligned; p++) padBytes.push(buf[p]);
      f.infoOffset = aligned;
      loc = aligned;
      if (f.large) {
        if (f.largeOffset !== aligned) throw new Error(`function ${i}: large header at ${f.largeOffset}, expected ${aligned}`);
        if (f.large.infoOffset !== aligned) throw new Error(`function ${i}: large header infoOffset ${f.large.infoOffset} != ${aligned}`);
        loc += P.largeHeaderSize;
      } else {
        if (f.small.infoOffset !== aligned) throw new Error(`function ${i}: small header infoOffset ${f.small.infoOffset} != ${aligned}`);
        if (!P.fitsSmall({ ...x })) throw new Error(`function ${i}: small header holds a value that does not fit`);
      }
    }
    if (hasExc) {
      const count = u32(buf, loc); loc += 4;
      f.exceptions = new Array(count);
      for (let e = 0; e < count; e++) { f.exceptions[e] = [u32(buf, loc), u32(buf, loc + 4), u32(buf, loc + 8)]; loc += 12; }
    } else f.exceptions = null;
    if (hasDbg) { f.debugOffsets = buf.slice(loc, loc + P.debugOffsetsSize); loc += P.debugOffsetsSize; } else f.debugOffsets = null;
  }
  return { functions, bodies, bytecodeEnd, infoStart, infoEnd: loc, padBytes };
}

// Re-serialises headers + region from the parsed structure into `out` (whole-file buffer).
export function writeFunctionRegion(h, parsed, out, headerTable, start) {
  const P = h.profile;
  const ops = isa.opcodes(h.version);
  const { functions, bodies } = parsed;
  let loc = start;
  for (const b of bodies) {
    if (b.offset !== loc) throw new Error(`body offset ${b.offset} != ${loc}`);
    loc = isa.emit(ops, b.instructions, out, loc);
    if (b.tableBytes) { out.set(b.padAfterOps, loc); loc += b.padAfterOps.length; out.set(b.tables, loc); loc += b.tableBytes; }
  }
  let padPos = 0;
  loc = align4(loc);
  for (let i = 0; i < functions.length; i++) {
    const f = functions[i];
    const x = f.h;
    const sh = headerTable + P.smallHeaderSize * i;
    if (P.infoPolicy === 'needed') {
      if (f.infoOffset < 0) { P.encodeSmall(x, out, sh); continue; }
      const aligned = align4(loc);
      for (let p = loc; p < aligned; p++) out[p] = parsed.padBytes[padPos++];
      loc = aligned;
      P.encodePointerSmall(x, loc, out, sh);
      P.encodeLarge(x, out, loc); loc += P.largeHeaderSize;
    } else {
      const aligned = align4(loc);
      for (let p = loc; p < aligned; p++) out[p] = parsed.padBytes[padPos++];
      loc = aligned;
      const full = { ...x, infoOffset: aligned };
      if (f.large) {
        P.encodePointerSmall(full, aligned, out, sh);
        P.encodeLarge(full, out, loc); loc += P.largeHeaderSize;
      } else {
        P.encodeSmall(full, out, sh);
      }
    }
    if (f.exceptions) {
      put32(out, loc, f.exceptions.length); loc += 4;
      for (const [s, e, t] of f.exceptions) { put32(out, loc, s); put32(out, loc + 4, e); put32(out, loc + 8, t); loc += 12; }
    }
    if (f.debugOffsets) { out.set(f.debugOffsets, loc); loc += f.debugOffsets.length; }
  }
  return loc;
}

export { encodeFlags };
