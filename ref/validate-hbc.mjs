// validate-hbc.mjs <file.hbc> <dump.txt> <opcodes.json>
// Independent check of the HBC v98 layout described in SPEC.md against a
// hermesc -dump-bytecode -pretty listing of the same file.
import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , hbcPath, dumpPath, opsPath] = process.argv;
const buf = fs.readFileSync(hbcPath);
const dumpLines = fs.readFileSync(dumpPath, 'utf8').split('\n');
const ops = JSON.parse(fs.readFileSync(opsPath, 'utf8')).opcodes;
const opByByte = ops; // index == opcode byte

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};
const u32 = (o) => buf.readUInt32LE(o);
const align4 = (p) => (p + 3) & ~3;

// ---- header ----
const H = {
  magic: buf.readBigUInt64LE(0),
  version: u32(8),
  fileLength: u32(32),
  globalCodeIndex: u32(36),
  functionCount: u32(40),
  stringKindCount: u32(44),
  identifierCount: u32(48),
  stringCount: u32(52),
  overflowStringCount: u32(56),
  stringStorageSize: u32(60),
  bigIntCount: u32(64),
  bigIntStorageSize: u32(68),
  regExpCount: u32(72),
  regExpStorageSize: u32(76),
  literalValueBufferSize: u32(80),
  objKeyBufferSize: u32(84),
  objShapeTableCount: u32(88),
  numStringSwitchImms: u32(92),
  segmentID: u32(96),
  cjsModuleCount: u32(100),
  functionSourceCount: u32(104),
  debugInfoOffset: u32(108),
  optionsByte: buf[112],
};
check(H.magic === 0x1f1903c103bc1fc6n, 'magic');
check(H.version === 98, 'version');
check(H.fileLength === buf.length, `fileLength ${H.fileLength} != ${buf.length}`);

// footer
{
  const h = crypto.createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  check(h.equals(buf.subarray(buf.length - 20)), 'footer SHA-1 mismatch');
}
const sourceHashHex = buf.subarray(12, 32).toString('hex');

// ---- section walk (serializer order) ----
const sec = {};
let pos = 128;
const place = (name, count, size) => {
  pos = align4(pos);
  sec[name] = { off: pos, count, bytes: count * size };
  pos += count * size;
};
const placeBytes = (name, n) => {
  pos = align4(pos);
  sec[name] = { off: pos, count: n, bytes: n };
  pos += n;
};
place('functionHeaders', H.functionCount, 12);
place('stringKinds', H.stringKindCount, 4);
place('identifierHashes', H.identifierCount, 4);
place('smallStringTable', H.stringCount, 4);
place('overflowStringTable', H.overflowStringCount, 8);
placeBytes('stringStorage', H.stringStorageSize);
placeBytes('literalValueBuffer', H.literalValueBufferSize);
placeBytes('objKeyBuffer', H.objKeyBufferSize);
place('objShapeTable', H.objShapeTableCount, 8);
place('bigIntTable', H.bigIntCount, 8);
placeBytes('bigIntStorage', H.bigIntStorageSize);
place('regExpTable', H.regExpCount, 8);
placeBytes('regExpStorage', H.regExpStorageSize);
place('cjsModuleTable', H.cjsModuleCount, 8);
place('functionSourceTable', H.functionSourceCount, 8);
const bytecodeStart = pos;
check(bytecodeStart === align4(bytecodeStart), 'bytecodeStart align');
// Note: no alignment is applied before the first bytecode blob.

// ---- function headers ----
const funcs = [];
for (let i = 0; i < H.functionCount; i++) {
  const o = sec.functionHeaders.off + 12 * i;
  const w1 = u32(o);
  const w2 = u32(o + 4);
  const b1 = buf[o + 8];
  const b2 = buf[o + 9];
  const b3 = buf[o + 10];
  const fl = buf[o + 11];
  const f = {
    idx: i,
    small: true,
    smallFlagsByte: fl,
    offset: w1 & 0x1ffffff,
    paramCount: (w1 >>> 25) & 0x1f,
    loopDepth: (w1 >>> 30) & 3,
    bytecodeSize: w2 & 0x3fff,
    functionName: (w2 >>> 14) & 0xff,
    numberRegCount: (w2 >>> 22) & 0x1f,
    nonPtrRegCount: (w2 >>> 27) & 0x1f,
    frameSize: b1,
    readCacheSize: b2,
    writeCacheSize: b3 & 0x3f,
    numCacheNewObject: (b3 >> 6) & 1,
    privateNameCacheSize: (b3 >> 7) & 1,
    prohibitInvoke: fl & 3,
    strictMode: (fl >> 2) & 1,
    hasExceptionHandler: (fl >> 3) & 1,
    hasDebugInfo: (fl >> 4) & 1,
    overflowed: (fl >> 5) & 1,
    kind: (fl >> 6) & 3,
  };
  if (f.overflowed) {
    f.small = false;
    f.infoOffset = (f.functionName << 24) | (f.offset); // overflow encoding: low 24 bits in offset? see SPEC
    f.infoOffsetRaw = ((w1 & 0x1ffffff) & 0xffffff) | (((w2 >>> 14) & 0xff) << 24);
    f.infoOffset = f.infoOffsetRaw;
  }
  funcs.push(f);
}

// ---- large headers (FunctionHeader, 37 bytes, packed) and function info ----
const LARGE = 37;
let loc = null;
{
  // Walk the info region in function-table order exactly as serializeFunctionInfo does.
  // First find the end of the bytecode region: the info region starts at align4(end of bytecode).
  let minInfo = Infinity;
  for (const f of funcs) if (!f.small) minInfo = Math.min(minInfo, f.infoOffset);
  loc = minInfo === Infinity ? null : minInfo;
}
const largeHeaders = [];
{
  let p = null;
  for (const f of funcs) {
    if (f.small) continue;
    const at = f.infoOffset;
    check(at % 4 === 0, `info offset ${at} unaligned (func ${f.idx})`);
    const L = {
      offset: u32(at),
      paramCount: u32(at + 4),
      loopDepth: u32(at + 8),
      bytecodeSize: u32(at + 12),
      functionName: u32(at + 16),
      numberRegCount: u32(at + 20),
      nonPtrRegCount: u32(at + 24),
      frameSize: u32(at + 28),
      readCacheSize: buf[at + 32],
      writeCacheSize: buf[at + 33],
      numCacheNewObject: buf[at + 34],
      privateNameCacheSize: buf[at + 35],
      flags: buf[at + 36],
    };
    Object.assign(f, {
      largeBytecodeSize: L.bytecodeSize,
      largeOffset: L.offset,
      large: L,
    });
    // In the overflowed small form only the Overflowed flag is set; the real
    // flags live in the large header's flags byte.
    const lf = L.flags;
    check(f.smallFlagsByte === 0x20, `small overflowed header has flags other than Overflowed f${f.idx}`);
    f.prohibitInvoke = lf & 3;
    f.strictMode = (lf >> 2) & 1;
    f.hasExceptionHandler = (lf >> 3) & 1;
    f.hasDebugInfo = (lf >> 4) & 1;
    f.kind = (lf >> 6) & 3;
    // Walk the info region.
    p = at + LARGE;
    if (f.hasExceptionHandler) {
      p = align4(p);
      const cnt = u32(p);
      f.exceptionHandlers = [];
      p += 4;
      for (let k = 0; k < cnt; k++) {
        f.exceptionHandlers.push([u32(p), u32(p + 4), u32(p + 8)]);
        p += 12;
      }
    }
    if (f.hasDebugInfo) {
      p = align4(p);
      f.debugSourceLocations = u32(p);
      p += 4;
    }
    f.infoEnd = p;
    largeHeaders.push(f);
  }
  // Info region end, then debug info must start at align4(end).
  if (largeHeaders.length) {
    const last = largeHeaders[largeHeaders.length - 1];
    const dbgExpected = align4(last.infoEnd);
    check(
      dbgExpected === H.debugInfoOffset,
      `debugInfoOffset ${H.debugInfoOffset} != align4(end of info ${last.infoEnd}) = ${dbgExpected}`,
    );
  }
}

// ---- the function bytecode region ----
{
  let minOff = Infinity;
  let maxEnd = 0;
  for (const f of funcs) {
    const size = f.small ? f.bytecodeSize : f.largeBytecodeSize;
    f.size = size;
    const o = f.offset; // for overflowed functions the offset is in the small header bits too
    if (!f.small) f.offset = f.largeOffset;
    minOff = Math.min(minOff, f.offset);
    maxEnd = Math.max(maxEnd, f.offset + size);
  }
  check(minOff === bytecodeStart || minOff >= bytecodeStart, `first function offset ${minOff} < bytecode start ${bytecodeStart}`);
  H.bytecodeStart = bytecodeStart;
  H.minFunctionOffset = minOff;
  H.maxFunctionEnd = maxEnd;
}

// ---- debug info ----
const dbg = {};
{
  const d = H.debugInfoOffset;
  dbg.filenameCount = u32(d);
  dbg.filenameStorageSize = u32(d + 4);
  dbg.fileRegionCount = u32(d + 8);
  dbg.debugDataSize = u32(d + 12);
  let q = d + 16;
  dbg.filenameTableOff = q;
  q += 8 * dbg.filenameCount;
  dbg.filenameStorageOff = q;
  q += dbg.filenameStorageSize;
  dbg.fileRegionsOff = q;
  q += 12 * dbg.fileRegionCount;
  dbg.dataOff = q;
  q += dbg.debugDataSize;
  dbg.end = q;
  check(q + 20 === buf.length, `debug section end ${q}+20 != fileLength ${buf.length}`);
}

// ---- string table (SmallStringTableEntry / overflow) ----
const storage = buf.subarray(sec.stringStorage.off, sec.stringStorage.off + H.stringStorageSize);
const strings = [];
{
  for (let i = 0; i < H.stringCount; i++) {
    const v = u32(sec.smallStringTable.off + 4 * i);
    const isUTF16 = v & 1;
    let off = (v >>> 1) & 0x7fffff;
    let len = (v >>> 24) & 0xff;
    if (len === 255) {
      const ov = sec.overflowStringTable.off + 8 * off;
      off = u32(ov);
      len = u32(ov + 4);
    }
    strings.push({ i, isUTF16: !!isUTF16, off, len });
  }
}
// string kinds RLE
const kinds = [];
{
  for (let i = 0; i < H.stringKindCount; i++) {
    const v = u32(sec.stringKinds.off + 4 * i);
    const kind = v >>> 31 ? 'identifier' : 'string';
    const count = v & 0x7fffffff;
    for (let k = 0; k < count; k++) kinds.push(kind);
  }
}
check(kinds.length === H.stringCount, `kinds ${kinds.length} != stringCount ${H.stringCount}`);

// Jenkins hash exactly as hermes::updateJenkinsHash.
function jenkins(units) {
  let h = 0;
  for (const c of units) {
    h = (h + c) >>> 0;
    h = (h + ((h << 10) >>> 0)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  return h >>> 0;
}
function unitsOf(s) {
  const out = [];
  if (s.isUTF16) {
    for (let k = 0; k < s.len; k++) out.push(storage.readUInt16LE(s.off + 2 * k));
  } else {
    for (let k = 0; k < s.len; k++) out.push(storage[s.off + k]);
  }
  return out;
}
const text = (s) => Buffer.from(
  s.isUTF16 ? Array.from({ length: s.len }, (_, k) => storage.readUInt16LE(s.off + 2 * k)) : [],
).toString('utf16le') + (s.isUTF16 ? '' : storage.subarray(s.off, s.off + s.len).toString('latin1'));

// identifier hashes in string table order
{
  const idStrings = strings.filter((s) => kinds[s.i] === 'identifier');
  check(idStrings.length === H.identifierCount, 'identifier count');
  let mism = 0;
  idStrings.forEach((s, k) => {
    const hh = u32(sec.identifierHashes.off + 4 * k);
    if (jenkins(unitsOf(s)) !== hh) mism++;
  });
  check(mism === 0, `identifier hash mismatches: ${mism}`);
  // Cross-check the dump's printed hashes for identifiers
  const dumpIds = dumpLines.filter((l) => /^i\d+\[/.test(l));
  let dumpMism = 0;
  for (const l of dumpIds) {
    const m = l.match(/^i(\d+)\[.*?\] #([0-9A-F]{8}): /);
    if (!m) continue;
    const idx = +m[1];
    const want = parseInt(m[2], 16) >>> 0;
    const s = strings[idx];
    if (!s || jenkins(unitsOf(s)) !== want) dumpMism++;
  }
  check(dumpMism === 0, `dump-printed identifier hash mismatches: ${dumpMism} of ${dumpIds.length}`);
  console.log(`identifier hashes: ${idStrings.length} ok; dump-printed identifier lines checked: ${dumpIds.length}, mismatches ${dumpMism}`);
}

// ---- instruction decode and comparison with dump ----
function decodeFunction(f) {
  const out = [];
  const start = f.offset;
  const end = f.offset + f.size;
  let p = start;
  while (p < end) {
    const b = buf[p];
    const op = opByByte[b];
    if (!op) {
      problems.push(`func ${f.idx}: unknown opcode byte ${b} at ${p}`);
      return { error: true, out };
    }
    let q = p + 1;
    const operands = [];
    for (const od of op.operands) {
      let v;
      switch (od.size) {
        case 1: v = od.signed ? buf.readInt8(q) : buf[q]; break;
        case 2: v = buf.readUInt16LE(q); break;
        case 4: v = od.signed ? buf.readInt32LE(q) : buf.readUInt32LE(q); break;
        case 8: v = buf.readDoubleLE(q); break;
      }
      operands.push(v);
      q += od.size;
    }
    if (q > end) {
      problems.push(`func ${f.idx}: instruction ${op.name} at ${p} overruns function end ${end}`);
      return { error: true, out };
    }
    out.push({ at: p, op, operands });
    p = q;
  }
  if (p !== end) problems.push(`func ${f.idx}: decode ended at ${p}, expected ${end}`);
  return { error: p !== end, out };
}

// Parse dump function listings: header lines "Function<...>(...)" then 4-space instruction lines.
const dumpFuncs = [];
let dumpContinuations = 0;
const opNamesGlobal = new Set(ops.map((o) => o.name));
{
  let cur = null;
  for (const line of dumpLines) {
    if (/^(NC)?Function</.test(line)) {
      cur = { header: line, instrs: [] };
      dumpFuncs.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^    [A-Za-z]/.test(line)) {
      const m = line.trim().match(/^([A-Za-z0-9_]+)/);
      if (opNamesGlobal.has(m[1])) cur.instrs.push(m[1]); else dumpContinuations++;
    } else if (['Function Source Table:', 'Debug filename table:', 'Debug file table:', 'Debug source table:'].includes(line)) {
      cur = null; // top-level section after the function listings
    }
  }
}
console.log(`dump functions: ${dumpFuncs.length}, file functions: ${funcs.length}, raw-newline string continuation lines skipped: ${dumpContinuations}`);
// The dump omits the header line for class constructors and prints their bodies after the
// previous function, so header counts can differ. Then fall back to a whole-file sequence check.
const headerless = dumpFuncs.length !== funcs.length;
if (headerless) {
  const allDecoded = [];
  for (const f of funcs) for (const x of decodeFunction(f).out) allDecoded.push(x.op.name);
  const allDump = dumpFuncs.flatMap((d) => d.instrs);
  const same = allDecoded.length === allDump.length && allDecoded.every((n2, k) => n2 === allDump[k]);
  check(same, 'headerless dump: full instruction sequence differs');
  console.log('note: dump has ' + dumpFuncs.length + ' headers for ' + funcs.length + ' functions; compared full instruction sequences: ' + (same ? 'identical' : 'DIFFERENT'));
} else {
  check(true, '');
}

// Fix: the dump lists functions in ID order; compare decoded mnemonic lists.
let compared = 0;
let mismatchFuncs = 0;
let unknownNames = new Set();
const opNames = new Set(ops.map((o) => o.name));
for (let i = 0; !headerless && i < Math.min(funcs.length, dumpFuncs.length); i++) {
  const f = funcs[i];
  const dec = decodeFunction(f);
  const got = dec.out.map((x) => x.op.name);
  for (const n of dumpFuncs[i].instrs) if (!opNames.has(n)) unknownNames.add(n);
  compared++;
  if (got.length !== dumpFuncs[i].instrs.length || got.some((n, k) => n !== dumpFuncs[i].instrs[k])) {
    mismatchFuncs++;
    if (mismatchFuncs <= 5) {
      const k = got.findIndex((n, j) => n !== dumpFuncs[i].instrs[j]);
      problems.push(
        `func ${i}: decoded ${got.length} instrs vs dump ${dumpFuncs[i].instrs.length}; first diff at ${k}: ${got[k]} vs ${dumpFuncs[i].instrs[k]}`,
      );
    }
  }
}
check(unknownNames.size === 0, `dump mnemonics not in table: ${[...unknownNames].join(',')}`);

// Header field checks vs dump header "Function<...>(N params, R registers, M numbers, P non-pointers)"
let hdrMismatch = 0;
for (let i = 0; i < Math.min(funcs.length, dumpFuncs.length); i++) {
  const m = dumpFuncs[i].header.match(/\((\d+) params, (\d+) registers, (\d+) numbers, (\d+) non-pointers\)/);
  if (!m) continue;
  const f = funcs[i];
  const F = f.small ? f : { paramCount: f.large.paramCount, frameSize: f.large.frameSize, numberRegCount: f.large.numberRegCount, nonPtrRegCount: f.large.nonPtrRegCount };
  const want = [F.paramCount, F.frameSize, F.numberRegCount, F.nonPtrRegCount].join(',');
  const have = [+m[1], +m[2], +m[3], +m[4]].join(',');
  if (want !== have) {
    hdrMismatch++;
    if (hdrMismatch <= 3) problems.push(`func ${i} header: file ${want} vs dump ${have}`);
  }
}
check(hdrMismatch === 0, `function header field mismatches: ${hdrMismatch}`);

// Jump target boundary check (Addr8/Addr32 relative to instruction start).
let badTargets = 0;
for (const f of funcs) {
  const dec = decodeFunction(f);
  const starts = new Set(dec.out.map((x) => x.at));
  for (const x of dec.out) {
    x.op.operands.forEach((od, k) => {
      if (od.semantic !== 'jump_offset') return;
      const tgt = x.at + x.operands[k];
      if (!starts.has(tgt) && tgt !== f.offset + f.size) badTargets++;
    });
  }
}
check(badTargets === 0, `jump targets not on instruction boundaries: ${badTargets}`);


// ---- debug source tables (only when present) ----
let debugFuncsChecked = 0, debugMismatch = 0, debugEntries = 0;
{
  const readSLEB = (pos) => {
    let result = 0n, shift = 0n, byte;
    do {
      byte = dataBuf[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    if (byte & 0x40) result -= 1n << shift;
    return [Number(result), pos];
  };
  const dataBuf = buf.subarray(dbg.dataOff, dbg.dataOff + dbg.debugDataSize);
  // dump blocks keyed by data offset
  const dumpBlocks = new Map();
  let curBlk = null;
  for (const line of dumpLines) {
    const m = line.match(/^  0x([0-9a-f]{4})  function idx (\d+), starts at line (\d+) col (\d+)/);
    if (m) { curBlk = { off: parseInt(m[1], 16), idx: +m[2], entries: [] }; dumpBlocks.set(curBlk.off, curBlk); continue; }
    if (curBlk && /^    bc \d+: line \d+ col \d+$/.test(line)) curBlk.entries.push(line.trim());
    else if (/^  0x[0-9a-f]{4}  end of debug source table/.test(line)) curBlk = null;
  }
  for (const f of funcs) {
    if (!f.hasDebugInfo || f.debugSourceLocations === undefined) continue;
    let q = f.debugSourceLocations;
    let fidx, line, col, env;
    [fidx, q] = readSLEB(q); [line, q] = readSLEB(q); [col, q] = readSLEB(q); [env, q] = readSLEB(q);
    let addr = 0; const mine = [];
    let guard = 0;
    for (;;) {
      if (guard++ > 100000) { problems.push("debug loop guard"); break; }
      let ad; [ad, q] = readSLEB(q);
      if (ad === -1) break;
      addr += ad;
      let ld; [ld, q] = readSLEB(q);
      if ((ld & 1) === 0) continue;
      let cd; [cd, q] = readSLEB(q);
      let sd = 0, ed = 0;
      if (ld & 2) [sd, q] = readSLEB(q);
      if (ld & 4) [ed, q] = readSLEB(q);
      line += ld >> 3; col += cd; env += ed;
      mine.push("bc " + addr + ": line " + line + " col " + col);
    }
    debugFuncsChecked++;
    debugEntries += mine.length;
    const blk = dumpBlocks.get(f.debugSourceLocations);
    if (!blk || blk.idx !== fidx || blk.entries.length !== mine.length || blk.entries.some((e, k) => e !== mine[k])) {
      debugMismatch++;
      if (debugMismatch <= 3) problems.push("debug mismatch for func " + f.idx + " at data offset " + f.debugSourceLocations + " (dump block found: " + !!blk + ")");
    }
  }
  check(debugMismatch === 0, "debug table mismatches: " + debugMismatch);
}

console.log(JSON.stringify({
  file: hbcPath,
  bytes: buf.length,
  version: H.version,
  sourceHashHex,
  header: H,
  sections: sec,
  bytecodeStart,
  debug: dbg,
  largeHeaderFunctions: largeHeaders.length,
  overflowedFunctions: funcs.filter((f) => !f.small).length,
  functionsCompared: compared,
  functionsWithMismatch: mismatchFuncs,
  badJumpTargets: badTargets,
  problems: problems.slice(0, 40),
  problemCount: problems.length,
  debugFuncsChecked,
  debugEntries,
  debugMismatch,
}, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
