// hbc-pack v3: v2 + property-cache indices coded as residuals from the per-function
// first-appearance rank of the property (reads and writes separately); see isa.cacheInfo().
//   tables as in v0, plus
//   function headers as columns (offsets, info pointers and large-header copies derived),
//   exception tables as delta columns,
//   instructions split into opcode stream + one stream per operand class/width,
//   switch tables raw.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as hbc from './hbc.mjs';
import * as funcs from './funcs.mjs';
import * as isa from './isa.mjs';
import * as T from './tables.mjs';
import { ByteReader, ByteWriter, concat } from './bits.mjs';
import { packStreams, unpackStreams } from './streams.mjs';
import { MTFDecoder, encodeMTF } from './mtf.mjs';

let lastReport = null;
export const lastStats = () => lastReport;
const align4 = (n) => (n + 3) & ~3;

// Operand stream key: semantic class + width.
const CLASS_OF = { register: 'reg', uint: 'u', string_id: 'str', function_id: 'fn', bigint_id: 'bi', jump_offset: 'addr', immediate: 'imm', double: 'dbl' };
function streamKey(operand) {
  return `${CLASS_OF[operand.semantic] ?? operand.semantic}${operand.size * 8}`;
}
const OPERAND_STREAMS = ['reg8', 'reg32', 'u8', 'u16', 'u32', 'str8', 'str16', 'str32', 'fn16', 'fn32', 'bi16', 'bi32', 'addr8', 'addr32', 'imm32', 'dbl64'];
const STREAM_INDEX = Object.fromEntries(OPERAND_STREAMS.map((k, i) => [k, i]));
// Width codes for the decoder's hot loop: 1, 2, 4 bytes or 8 (double).
const WIDTH_CODE = { Reg8: 1, UInt8: 1, Addr8: 1, UInt16: 2, Reg32: 4, UInt32: 4, Addr32: 4, Imm32: 4, Double: 8 };
let DESC = null; // per opcode: { n, stream: Int32Array, width: Int32Array, uintSwitch, stringSwitch }
function descriptors(ops) {
  if (DESC) return DESC;
  const cacheOps = isa.cacheInfo();
  DESC = ops.map((def, opcode) => def && {
    n: def.operands.length,
    stream: Int32Array.from(def.operands.map((o) => STREAM_INDEX[streamKey(o)])),
    width: Int32Array.from(def.operands.map((o) => WIDTH_CODE[o.type])),
    uintSwitch: def.name === 'UIntSwitchImm', stringSwitch: def.name === 'StringSwitchImm',
    cache: cacheOps[opcode], // { si, ci, write } or null
  });
  return DESC;
}
const DEFAULT_MTF = []; // MTF ranks lost once first occurrences were counted (NOTES.md)
const MTF_STREAMS = ['str8', 'str16', 'str32', 'fn16', 'fn32'];

function writeFixed(w, type, v) {
  switch (type) {
    case 'Reg8': case 'UInt8': case 'Addr8': w.u8(v); break;
    case 'UInt16': w.u16(v); break;
    case 'Reg32': case 'UInt32': case 'Addr32': case 'Imm32': w.u32(v >>> 0); break;
    case 'Double': { w.ensure(8); new DataView(w.buf.buffer, w.buf.byteOffset + w.pos, 8).setFloat64(0, v, true); w.pos += 8; break; }
    default: throw new Error(type);
  }
}
function readFixed(r, type) {
  switch (type) {
    case 'Reg8': case 'UInt8': return r.u8();
    case 'Addr8': return (r.u8() << 24) >> 24;
    case 'UInt16': return r.u16();
    case 'Reg32': case 'UInt32': return r.u32();
    case 'Addr32': case 'Imm32': return r.u32() | 0;
    case 'Double': { const v = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 8).getFloat64(0, true); r.pos += 8; return v; }
    default: throw new Error(type);
  }
}

// The raw streams, before entropy coding (also used for dictionary training).
export function extractStreams(buf, opts = {}) {
  const h = hbc.parseHeader(buf);
  const off = hbc.tableOffsets(h);
  const kinds = hbc.parseStringKinds(buf, off, h);
  const strings = hbc.parseStringTable(buf, off, h);
  const cols = T.stringColumns(kinds, strings, opts.strEnd ?? true);
  const mtfSet = new Set(opts.mtf ?? DEFAULT_MTF);
  const mtfValues = Object.fromEntries([...mtfSet].map((k) => [k, []]));
  const region = funcs.parseFunctionRegion(buf, off.functionHeaders.start, h.functionCount, off.tablesEnd);
  const ops = isa.loadOpcodes();
  const n = h.functionCount;

  // Function header columns.
  const W = {};
  for (const k of ['fhParam', 'fhLoop', 'fhNumReg', 'fhNonPtr', 'fhReadCache', 'fhWriteCache', 'fhFlags', 'fhPrivate', 'fhNewObj']) W[k] = new ByteWriter(n + 16);
  for (const k of ['fhSize', 'fhName', 'fhFrame', 'fhReuse', 'excCount', 'excStart', 'excEnd', 'excTarget', 'debugOff']) W[k] = new ByteWriter(2 * n + 16);
  const firstFunctionOfBody = new Int32Array(region.bodies.length).fill(-1);
  for (let i = 0; i < n; i++) {
    const f = region.functions[i];
    const x = f.h;
    if (f.large && (f.large.pad[0] | f.large.pad[1] | f.large.pad[2])) throw new Error(`function ${i}: non-zero large header padding`);
    if (f.large && f.large.flags.overflowed) throw new Error(`function ${i}: large header has overflowed flag`);
    W.fhParam.u8(x.paramCount); W.fhLoop.u8(x.loopDepth); W.fhSize.varint(x.bytecodeSize); W.fhName.varint(x.functionName);
    W.fhNumReg.u8(x.numberRegCount); W.fhNonPtr.u8(x.nonPtrRegCount); W.fhFrame.varint(x.frameSize);
    W.fhReadCache.u8(x.readCacheSize); W.fhWriteCache.u8(x.writeCacheSize);
    W.fhFlags.u8(funcs.encodeFlags({ ...x.flags, overflowed: 0 }));
    W.fhPrivate.u8(x.privateNameCacheSize);
    W.fhNewObj.u8(x.numCacheNewObject);
    if (f.reuse) W.fhReuse.varint(i - firstFunctionOfBody[f.body]);
    else { W.fhReuse.varint(0); firstFunctionOfBody[f.body] = i; }
    if (f.exceptions) {
      W.excCount.varint(f.exceptions.length);
      let prevStart = 0;
      for (const [s, e, t] of f.exceptions) { W.excStart.svarint(s - prevStart); W.excEnd.svarint(e - s); W.excTarget.svarint(t - e); prevStart = s; }
    }
    if (f.debugOffset !== null && f.debugOffset !== undefined) W.debugOff.u32(f.debugOffset);
  }

  // Instruction streams.
  const S = {};
  for (const k of OPERAND_STREAMS) S[k] = new ByteWriter(1 << 16);
  const opcodes = new ByteWriter(1 << 20);
  const tables = new ByteWriter(1 << 12);
  const cacheOps = isa.cacheInfo();
  const cacheRes = new ByteWriter(1 << 16);
  for (const b of region.bodies) {
    const readRank = new Map(), writeRank = new Map();
    for (const ins of b.instructions) {
      opcodes.u8(ins.opcode);
      const def = ops[ins.opcode];
      const c = cacheOps[ins.opcode];
      for (let j = 0; j < def.operands.length; j++) {
        const od = def.operands[j]; const k = od.key ??= streamKey(od);
        if (c && j === c.ci) {
          const ranks = c.write ? writeRank : readRank; const sid = ins.operands[c.si];
          let r = ranks.get(sid); if (r === undefined) { r = ranks.size; ranks.set(sid, r); }
          cacheRes.svarint(ins.operands[j] - r);
        } else if (mtfSet.has(k)) mtfValues[k].push(ins.operands[j]);
        else writeFixed(S[k], od.type, ins.operands[j]);
      }
    }
    if (b.tableBytes) {
      for (const p of b.padAfterOps) if (p) throw new Error('non-zero padding before switch table');
      tables.bytes(b.tables);
    }
  }
  if (region.padBytes.some((x) => x)) throw new Error('non-zero padding in info section');

  const streams = [
    { name: 'header', bytes: buf.subarray(0, hbc.HEADER_SIZE) },
    { name: 'kinds', bytes: T.slice(buf, off.stringKinds) },
    { name: 'strFlags', bytes: cols.flags }, { name: 'strLens', bytes: cols.lens }, { name: 'strDeltas', bytes: cols.deltas },
    { name: 'storage', bytes: T.slice(buf, off.stringStorage) },
    { name: 'arrayBuffer', bytes: T.slice(buf, off.arrayBuffer) },
    { name: 'objKeyBuffer', bytes: T.slice(buf, off.objKeyBuffer) },
    { name: 'objShapeTable', bytes: T.slice(buf, off.objShapeTable) },
    { name: 'misc', bytes: concat(T.MISC.map((nm) => T.slice(buf, off[nm]))) },
    { name: 'padding', bytes: T.paddingBytes(buf, off) },
    { name: 'debug', bytes: buf.subarray(h.debugInfoOffset, buf.length - 20) },
    ...Object.entries(W).map(([name, w]) => ({ name, bytes: w.finish() })),
    { name: 'mtfConfig', bytes: Uint8Array.from(MTF_STREAMS.map((k) => (mtfSet.has(k) ? 1 : 0)).concat([opts.strEnd ?? true ? 1 : 0])) },
    { name: 'opcodes', bytes: opcodes.finish() },
    ...OPERAND_STREAMS.map((name) => ({ name, bytes: S[name].finish() })),
    ...MTF_STREAMS.flatMap((k) => { const e = mtfSet.has(k) ? encodeMTF(mtfValues[k]) : { ranks: new Uint8Array(0), fresh: new Uint8Array(0) }; return [{ name: `${k}R`, bytes: e.ranks }, { name: `${k}F`, bytes: e.fresh }]; }),
    { name: 'switchTables', bytes: tables.finish() },
    { name: 'cacheRes', bytes: cacheRes.finish() },
  ];
  return streams;
}

export function pack(buf, opts = {}) {
  const streams = extractStreams(buf, opts);
  const { bytes, report } = packStreams(streams, withDicts(opts));
  lastReport = report;
  return bytes;
}

// opts.dictDir: directory of <stream>.zdict files; a stream whose dictionary exists may use the
// zstd+dictionary backend. The decoder must be given the same directory.
const dictCache = new Map();
function withDicts(opts) {
  if (!opts.dictDir) return opts;
  if (!dictCache.has(opts.dictDir)) {
    const dicts = {};
    for (const f of readdirSync(opts.dictDir)) if (f.endsWith('.zdict')) dicts[f.slice(0, -6)] = new Uint8Array(readFileSync(path.join(opts.dictDir, f)));
    dictCache.set(opts.dictDir, dicts);
  }
  return { ...opts, dicts: dictCache.get(opts.dictDir), backends: opts.backends ?? ['zstd', 'brotli', 'zstd-dict'] };
}

export function unpack(bytes, opts = {}) {
  const raw = unpackStreams(bytes, withDicts(opts));
  const names = ['header', 'kinds', 'strFlags', 'strLens', 'strDeltas', 'storage', 'arrayBuffer', 'objKeyBuffer', 'objShapeTable', 'misc', 'padding', 'debug',
    'fhParam', 'fhLoop', 'fhNumReg', 'fhNonPtr', 'fhReadCache', 'fhWriteCache', 'fhFlags', 'fhPrivate', 'fhNewObj',
    'fhSize', 'fhName', 'fhFrame', 'fhReuse', 'excCount', 'excStart', 'excEnd', 'excTarget', 'debugOff', 'mtfConfig', 'opcodes', ...OPERAND_STREAMS,
    ...MTF_STREAMS.flatMap((k) => [`${k}R`, `${k}F`]), 'switchTables', 'cacheRes'];
  const s = Object.fromEntries(names.map((nm, i) => [nm, raw[i]]));
  const h = hbc.parseHeaderLoose(s.header);
  const off = hbc.tableOffsets(h);
  const out = new Uint8Array(h.fileLength);
  out.set(s.header, 0);

  // Tables.
  const kinds = T.parseKindsBytes(s.kinds, h.stringKindCount);
  const mtfOn = Object.fromEntries(MTF_STREAMS.map((k, i) => [k, s.mtfConfig[i] === 1]));
  const strEnd = s.mtfConfig[MTF_STREAMS.length] === 1;
  const st = T.rebuildStringTables(h, kinds, s.strFlags, s.strLens, s.strDeltas, s.storage, strEnd);
  const mtfDec = Object.fromEntries(MTF_STREAMS.filter((k) => mtfOn[k]).map((k) => [k, new MTFDecoder(s[`${k}R`], s[`${k}F`], s.opcodes.length)]));
  T.placeTables(out, h, off, { padding: s.padding, kinds: s.kinds, hashes: st.hashes, stringTable: st.stringTable, overflow: st.overflow,
    storage: s.storage, arrayBuffer: s.arrayBuffer, objKeyBuffer: s.objKeyBuffer, objShapeTable: s.objShapeTable, misc: s.misc });

  // Function headers from columns.
  const n = h.functionCount;
  const R = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, new ByteReader(v)]));
  const ops = isa.loadOpcodes();
  const headers = new Array(n);
  const reuse = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const flagsByte = R.fhFlags.u8();
    headers[i] = {
      offset: 0, paramCount: R.fhParam.u8(), loopDepth: R.fhLoop.u8(), bytecodeSize: R.fhSize.varint(), functionName: R.fhName.varint(),
      numberRegCount: R.fhNumReg.u8(), nonPtrRegCount: R.fhNonPtr.u8(), frameSize: R.fhFrame.varint(),
      readCacheSize: R.fhReadCache.u8(), writeCacheSize: R.fhWriteCache.u8(), numCacheNewObject: R.fhNewObj.u8(), privateNameCacheSize: R.fhPrivate.u8(),
      flags: funcs.decodeFlags(flagsByte), pad: [0, 0, 0],
    };
    reuse[i] = R.fhReuse.varint();
  }

  // Bodies: decode instructions until each body's size is reached. Hot loop: operand streams are
  // indexed by integer, bytes are copied by width (little-endian in both places, so no decoding).
  const desc = descriptors(ops);
  const sb = OPERAND_STREAMS.map((k) => s[k]);      // stream bytes
  const sp = new Int32Array(OPERAND_STREAMS.length); // stream positions
  const mtfFor = OPERAND_STREAMS.map((k) => mtfDec[k] ?? null);
  const opBytes = s.opcodes; let opPos = 0;
  const tables = s.switchTables; let tablePos = 0;
  const cacheRes = new ByteReader(s.cacheRes);
  let loc = off.tablesEnd;
  const bodyOffset = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = headers[i];
    if (reuse[i]) { x.offset = bodyOffset[i - reuse[i]]; bodyOffset[i] = x.offset; continue; }
    x.offset = loc; bodyOffset[i] = loc;
    const end = loc + x.bytecodeSize;
    let tableBytes = 0, switchMin = 0;
    const readRank = new Map(), writeRank = new Map();
    while (loc < end) {
      const opcode = opBytes[opPos++];
      const d = desc[opcode];
      out[loc++] = opcode;
      let cacheLoc = -1, sidLoc = -1;
      for (let j = 0; j < d.n; j++) {
        const si = d.stream[j], w = d.width[j];
        if (d.cache && j === d.cache.ci) { cacheLoc = loc; loc += 1; continue; }
        if (d.cache && j === d.cache.si) sidLoc = loc;
        if (mtfFor[si]) {
          const v = mtfFor[si].next();
          out[loc] = v & 0xff; if (w > 1) out[loc + 1] = (v >>> 8) & 0xff; if (w > 2) { out[loc + 2] = (v >>> 16) & 0xff; out[loc + 3] = (v >>> 24) & 0xff; }
        } else {
          const src = sb[si]; let p = sp[si];
          out[loc] = src[p];
          if (w > 1) out[loc + 1] = src[p + 1];
          if (w > 2) { out[loc + 2] = src[p + 2]; out[loc + 3] = src[p + 3]; }
          if (w > 4) { out[loc + 4] = src[p + 4]; out[loc + 5] = src[p + 5]; out[loc + 6] = src[p + 6]; out[loc + 7] = src[p + 7]; }
          sp[si] = p + w;
        }
        if (d.uintSwitch || d.stringSwitch) {
          const v = (out[loc] | (out[loc + 1] << 8) | (out[loc + 2] << 16) | (out[loc + 3] << 24)) >>> 0;
          if (d.uintSwitch) { if (j === 3) switchMin = v; else if (j === 4) tableBytes += 4 * (v - switchMin + 1); }
          else if (j === 4) tableBytes += 8 * v;
        }
        loc += w;
      }
      if (cacheLoc >= 0) {
        const sw = d.width[d.cache.si];
        const sid = sw === 1 ? out[sidLoc] : sw === 2 ? out[sidLoc] | (out[sidLoc + 1] << 8) : (out[sidLoc] | (out[sidLoc + 1] << 8) | (out[sidLoc + 2] << 16) | (out[sidLoc + 3] << 24)) >>> 0;
        const ranks = d.cache.write ? writeRank : readRank;
        let r = ranks.get(sid); if (r === undefined) { r = ranks.size; ranks.set(sid, r); }
        out[cacheLoc] = (r + cacheRes.svarint()) & 0xff;
      }
    }
    if (loc !== end) throw new Error(`body ${i} overran`);
    if (tableBytes) {
      loc = align4(loc);
      out.set(tables.subarray(tablePos, tablePos + tableBytes), loc);
      tablePos += tableBytes; loc += tableBytes;
    }
  }

  // Info section + small headers.
  loc = align4(loc);
  const ht = off.functionHeaders.start;
  for (let i = 0; i < n; i++) {
    const x = headers[i];
    const needsInfo = x.flags.hasExceptionHandler || x.flags.hasDebugInfo || !funcs.fitsSmall(x);
    if (!needsInfo) { funcs.encodeSmallHeader(x, out, ht + 12 * i); continue; }
    loc = align4(loc);
    const ptr = { offset: loc & 0xffffff, paramCount: 0, loopDepth: 0, bytecodeSize: 0, functionName: (loc >>> 24) & 0xff, numberRegCount: 0, nonPtrRegCount: 0,
      frameSize: 0, readCacheSize: 0, writeCacheSize: 0, numCacheNewObject: 0, privateNameCacheSize: 0, flags: funcs.decodeFlags(0x20) };
    funcs.encodeSmallHeader(ptr, out, ht + 12 * i);
    funcs.encodeLargeHeader(x, out, loc); loc += funcs.LARGE_HEADER_SIZE;
    if (x.flags.hasExceptionHandler) {
      const count = R.excCount.varint();
      const w = new ByteWriter(4 + 12 * count);
      w.u32(count);
      let prevStart = 0;
      for (let e = 0; e < count; e++) {
        const st = prevStart + R.excStart.svarint(); const en = st + R.excEnd.svarint(); const tg = en + R.excTarget.svarint();
        w.u32(st); w.u32(en); w.u32(tg); prevStart = st;
      }
      out.set(w.finish(), loc); loc += 4 + 12 * count;
    }
    if (x.flags.hasDebugInfo) { const v = R.debugOff.u32(); out[loc] = v & 0xff; out[loc + 1] = (v >>> 8) & 0xff; out[loc + 2] = (v >>> 16) & 0xff; out[loc + 3] = (v >>> 24) & 0xff; loc += 4; }
  }
  out.set(s.debug, h.debugInfoOffset);
  const sha = createHash('sha1').update(out.subarray(0, out.length - 20)).digest();
  out.set(sha, out.length - 20);
  return out;
}
