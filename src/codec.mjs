// hbc-pack codec (container version 2): HBC versions 96 and 98 through profiles.mjs.
//
//   tables as streams (identifier hashes dropped, string table as columns), function headers as
//   columns (offsets, info pointers and large headers derived), exception tables as deltas,
//   instructions split into an opcode stream + one stream per operand class and width,
//   property-cache indices as rank residuals, switch tables raw. See ../FORMAT.md.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as hbc from './hbc.mjs';
import * as funcs from './funcs.mjs';
import * as isa from './isa.mjs';
import * as T from './tables.mjs';
import { decodeFlags, encodeFlags } from './profiles.mjs';
import { ByteReader, ByteWriter, concat } from './bits.mjs';
import { packStreams, unpackStreams } from './streams.mjs';

let lastReport = null;
export const lastStats = () => lastReport;
const align4 = (n) => (n + 3) & ~3;

const FIXED_STREAMS = ['header', 'kinds', 'strFlags', 'strLens', 'strDeltas', 'storage', 'arrayBuffer', 'objKeyBuffer', 'literalTable3', 'misc', 'padding', 'debug'];
const TAIL_STREAMS = ['excCount', 'excStart', 'excEnd', 'excTarget', 'debugOff', 'opcodes', ...isa.OPERAND_STREAMS, 'switchTables', 'cacheRes'];
export const streamNames = (profile) => [...FIXED_STREAMS, ...profile.columns.map(([name]) => `fh:${name}`), ...TAIL_STREAMS];

function writeFixed(w, type, v) {
  switch (type) {
    case 'Reg8': case 'UInt8': case 'Addr8': w.u8(v); break;
    case 'UInt16': w.u16(v); break;
    case 'Reg32': case 'UInt32': case 'Addr32': case 'Imm32': w.u32(v >>> 0); break;
    case 'Double': { w.ensure(8); new DataView(w.buf.buffer, w.buf.byteOffset + w.pos, 8).setFloat64(0, v, true); w.pos += 8; break; }
    default: throw new Error(type);
  }
}

// Content key of a string entry (kind-independent; the corpus has no duplicate contents, and
// canonicalIds() handles a duplicate by giving the second one a fresh id).
export function stringKey(storage, e) {
  return (e.utf16 ? 'u:' : 'a:') + Buffer.from(storage.subarray(e.offset, e.offset + e.length * (e.utf16 ? 2 : 1))).toString('latin1');
}

// Delta mode: new string ids renumbered into the base's table. Returns { toCanonical: Int32Array
// (newId -> canonical), fromCanonical: Int32Array (canonical -> newId) }. Strings the base lacks
// get fresh ids from baseCount up, in new-id order. Both sides compute this from the two tables.
export function canonicalIds(baseKeys, newKeys) {
  const baseByKey = new Map();
  baseKeys.forEach((k, i) => { if (!baseByKey.has(k)) baseByKey.set(k, i); });
  const toCanonical = new Int32Array(newKeys.length);
  const used = new Uint8Array(baseKeys.length);
  let fresh = baseKeys.length;
  newKeys.forEach((k, i) => {
    const b = baseByKey.get(k);
    if (b !== undefined && !used[b]) { used[b] = 1; toCanonical[i] = b; } else toCanonical[i] = fresh++;
  });
  const fromCanonical = new Int32Array(fresh).fill(-1);
  toCanonical.forEach((c, i) => { fromCanonical[c] = i; });
  return { toCanonical, fromCanonical };
}

const ID_STREAMS = new Set(['str8', 'str16', 'str32']);

export function stringKeysOf(buf) {
  const h = hbc.parseHeader(buf);
  const off = hbc.tableOffsets(h);
  const storage = T.slice(buf, off.stringStorage);
  return hbc.parseStringTable(buf, off, h).map((e) => stringKey(storage, e));
}

// The raw streams, before entropy coding (also used for dictionary training).
// opts.delta: string-id operands are written as u32 canonical ids (opts.toCanonical, identity
// when absent) and fh:functionName is mapped too; that is the form delta containers use.
export function extractStreams(buf, opts = {}) {
  const delta = !!opts.delta;
  const toCanonical = opts.toCanonical ?? null;
  const mapId = (id) => (toCanonical ? toCanonical[id] : id);
  const h = hbc.parseHeader(buf);
  const P = h.profile;
  const off = hbc.tableOffsets(h);
  const kinds = hbc.parseStringKinds(buf, off, h);
  const strings = hbc.parseStringTable(buf, off, h);
  const cols = T.stringColumns(kinds, strings, true);
  const region = funcs.parseFunctionRegion(buf, h, off.functionHeaders.start, off.tablesEnd);
  const ops = isa.opcodes(h.version);
  const n = h.functionCount;

  // Function header columns.
  const W = {};
  for (const [name, kind] of P.columns) W[name] = new ByteWriter(kind === 'u8' ? n + 16 : 2 * n + 16);
  for (const k of ['fhReuse', 'excCount', 'excStart', 'excEnd', 'excTarget', 'debugOff']) W[k] = new ByteWriter(2 * n + 16);
  const firstFunctionOfBody = new Int32Array(region.bodies.length).fill(-1);
  for (let i = 0; i < n; i++) {
    const f = region.functions[i];
    const x = { ...f.h, flagsByte: encodeFlags({ ...f.h.flags, overflowed: 0 }) };
    for (const [name, kind] of P.columns) {
      if (x[name] === undefined) throw new Error(`function ${i}: header field ${name} missing`);
      const v = delta && name === 'functionName' ? mapId(x[name]) : x[name];
      if (kind === 'u8') { if (v > 255) throw new Error(`function ${i}: ${name}=${v} does not fit a byte`); W[name].u8(v); } else W[name].varint(v);
    }
    if (f.reuse) W.fhReuse.varint(i - firstFunctionOfBody[f.body]);
    else { W.fhReuse.varint(0); firstFunctionOfBody[f.body] = i; }
    if (f.exceptions) {
      W.excCount.varint(f.exceptions.length);
      let prevStart = 0;
      for (const [s, e, t] of f.exceptions) { W.excStart.svarint(s - prevStart); W.excEnd.svarint(e - s); W.excTarget.svarint(t - e); prevStart = s; }
    }
    if (f.debugOffsets) W.debugOff.bytes(f.debugOffsets);
  }
  if (region.padBytes.some((x) => x)) throw new Error('non-zero padding in info section');

  // Instruction streams.
  const S = {};
  for (const k of isa.OPERAND_STREAMS) S[k] = new ByteWriter(1 << 16);
  const opcodes = new ByteWriter(1 << 20), tables = new ByteWriter(1 << 12), cacheRes = new ByteWriter(1 << 16);
  for (const b of region.bodies) {
    const readRank = new Map(), writeRank = new Map();
    for (const ins of b.instructions) {
      opcodes.u8(ins.opcode);
      const def = ops[ins.opcode];
      const c = def.cache;
      for (let j = 0; j < def.operands.length; j++) {
        const od = def.operands[j];
        if (c && j === c.ci) {
          const ranks = c.write ? writeRank : readRank; const sid = ins.operands[c.si];
          let r = ranks.get(sid); if (r === undefined) { r = ranks.size; ranks.set(sid, r); }
          cacheRes.svarint(ins.operands[j] - r);
        } else if (delta && ID_STREAMS.has(od.key)) S[od.key].u32(mapId(ins.operands[j]));
        else writeFixed(S[od.key], od.type, ins.operands[j]);
      }
    }
    if (b.tableBytes) {
      if (b.padAfterOps.some((x) => x)) throw new Error('non-zero padding before switch table');
      tables.bytes(b.tables);
    }
  }

  const streams = [
    { name: 'header', bytes: buf.subarray(0, hbc.HEADER_SIZE) },
    { name: 'kinds', bytes: T.slice(buf, off.stringKinds) },
    { name: 'strFlags', bytes: cols.flags }, { name: 'strLens', bytes: cols.lens }, { name: 'strDeltas', bytes: cols.deltas },
    { name: 'storage', bytes: T.slice(buf, off.stringStorage) },
    { name: 'arrayBuffer', bytes: T.slice(buf, off.arrayBuffer) },
    { name: 'objKeyBuffer', bytes: T.slice(buf, off.objKeyBuffer) },
    { name: 'literalTable3', bytes: T.slice(buf, off[P.thirdLiteralTable]) },
    { name: 'misc', bytes: concat(T.MISC.map((nm) => T.slice(buf, off[nm]))) },
    { name: 'padding', bytes: T.paddingBytes(buf, off, hbc.sectionNames(h)) },
    { name: 'debug', bytes: buf.subarray(h.debugInfoOffset, buf.length - 20) },
    ...P.columns.map(([name]) => ({ name: `fh:${name}`, bytes: W[name].finish() })),
    { name: 'fhReuse', bytes: W.fhReuse.finish() },
    ...['excCount', 'excStart', 'excEnd', 'excTarget', 'debugOff'].map((k) => ({ name: k, bytes: W[k].finish() })),
    { name: 'opcodes', bytes: opcodes.finish() },
    ...isa.OPERAND_STREAMS.map((name) => ({ name, bytes: S[name].finish() })),
    { name: 'switchTables', bytes: tables.finish() },
    { name: 'cacheRes', bytes: cacheRes.finish() },
  ];
  // fhReuse sits right after the header columns; include it in the stream name list.
  return streams;
}

export function pack(buf, opts = {}) {
  if (!opts.base) {
    const streams = extractStreams(buf);
    const { bytes, report } = packStreams(streams, withDicts(opts));
    lastReport = report;
    return bytes;
  }
  // Delta: the installed file's streams are the dictionaries; ids are renumbered into its table.
  const base = opts.base;
  const { toCanonical } = canonicalIds(stringKeysOf(base), stringKeysOf(buf));
  const baseStreams = extractStreams(base, { delta: true });
  const streams = extractStreams(buf, { delta: true, toCanonical });
  const dicts = Object.fromEntries(baseStreams.filter((s) => s.bytes.length >= 64).map((s) => [s.name, s.bytes]));
  const { bytes, report } = packStreams(streams, { ...opts, dicts, backends: opts.backends ?? ['zstd', 'brotli', 'zstd-dict'], baseFooter: base.subarray(base.length - 20) });
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
  let baseKeys = null;
  const resolveDicts = (footer) => {
    if (!opts.base) throw new Error('delta container: pass the installed .hbc as opts.base');
    const base = opts.base;
    if (Buffer.compare(Buffer.from(base.subarray(base.length - 20)), Buffer.from(footer)) !== 0) throw new Error('delta container: the base file does not match (footer differs)');
    baseKeys = stringKeysOf(base);
    return Object.fromEntries(extractStreams(base, { delta: true }).map((s) => [s.name, s.bytes]));
  };
  const raw = unpackStreams(bytes, { ...withDicts(opts), resolveDicts });
  const delta = raw.version === 3;
  const h = hbc.parseHeaderLoose(raw[0]);
  const P = h.profile;
  const names = [...FIXED_STREAMS, ...P.columns.map(([name]) => `fh:${name}`), 'fhReuse', ...TAIL_STREAMS];
  if (raw.length !== names.length) throw new Error(`expected ${names.length} streams for HBC ${h.version}, got ${raw.length}`);
  const s = Object.fromEntries(names.map((nm, i) => [nm, raw[i]]));
  const off = hbc.tableOffsets(h);
  const out = new Uint8Array(h.fileLength);
  out.set(s.header, 0);

  // Tables.
  const kinds = T.parseKindsBytes(s.kinds, h.stringKindCount);
  const st = T.rebuildStringTables(h, kinds, s.strFlags, s.strLens, s.strDeltas, s.storage, true);
  // Delta: canonical id -> this file's id, from the two string tables.
  const fromCanonical = delta ? canonicalIds(baseKeys, st.entries.map((e) => stringKey(s.storage, e))).fromCanonical : null;
  const unmap = (c) => { const v = fromCanonical[c]; if (v === undefined || v < 0) throw new Error(`delta: unknown canonical string id ${c}`); return v; };
  T.placeTables(out, h, off, hbc.sectionNames(h), { padding: s.padding, kinds: s.kinds, hashes: st.hashes, stringTable: st.stringTable, overflow: st.overflow,
    storage: s.storage, arrayBuffer: s.arrayBuffer, objKeyBuffer: s.objKeyBuffer, [P.thirdLiteralTable]: s.literalTable3, misc: s.misc });

  // Function headers from columns.
  const n = h.functionCount;
  const R = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, new ByteReader(v)]));
  const headers = new Array(n);
  const reuse = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = { offset: 0, infoOffset: 0 };
    for (const [name, kind] of P.columns) x[name] = kind === 'u8' ? R[`fh:${name}`].u8() : R[`fh:${name}`].varint();
    if (delta) x.functionName = unmap(x.functionName);
    x.flags = decodeFlags(x.flagsByte);
    headers[i] = x;
    reuse[i] = R.fhReuse.varint();
  }

  // Bodies: decode instructions until each body's size is reached. Hot loop: operand streams are
  // indexed by integer, bytes copied by width (little-endian in both places, so no decoding).
  const ops = isa.opcodes(h.version);
  const desc = ops.map((def) => def && {
    n: def.operands.length, stream: Int32Array.from(def.operands.map((o) => o.streamIndex)), width: Int32Array.from(def.operands.map((o) => o.size)),
    sw: def.switchKind, cache: def.cache,
  });
  const sb = isa.OPERAND_STREAMS.map((k) => s[k]);
  const isIdStream = isa.OPERAND_STREAMS.map((k) => ID_STREAMS.has(k));
  const sp = new Int32Array(isa.OPERAND_STREAMS.length);
  const opBytes = s.opcodes; let opPos = 0;
  const tables = s.switchTables; let tablePos = 0;
  const cacheRes = R.cacheRes;
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
        const src = sb[si]; const p = sp[si];
        if (delta && isIdStream[si]) {
          const id = unmap((src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0);
          out[loc] = id & 0xff; if (w > 1) out[loc + 1] = (id >>> 8) & 0xff; if (w > 2) { out[loc + 2] = (id >>> 16) & 0xff; out[loc + 3] = (id >>> 24) & 0xff; }
          sp[si] = p + 4;
        } else {
          out[loc] = src[p];
          if (w > 1) out[loc + 1] = src[p + 1];
          if (w > 2) { out[loc + 2] = src[p + 2]; out[loc + 3] = src[p + 3]; }
          if (w > 4) { out[loc + 4] = src[p + 4]; out[loc + 5] = src[p + 5]; out[loc + 6] = src[p + 6]; out[loc + 7] = src[p + 7]; }
          sp[si] = p + w;
        }
        if (d.sw) {
          const v = (out[loc] | (out[loc + 1] << 8) | (out[loc + 2] << 16) | (out[loc + 3] << 24)) >>> 0;
          if (d.sw === 'uint') { if (j === 3) switchMin = v; else if (j === 4) tableBytes += 4 * (v - switchMin + 1); }
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
    const sh = ht + P.smallHeaderSize * i;
    const hasExc = x.flags.hasExceptionHandler, hasDbg = x.flags.hasDebugInfo;
    if (P.infoPolicy === 'needed') {
      if (!(hasExc || hasDbg || !P.fitsSmall(x))) { P.encodeSmall(x, out, sh); continue; }
      loc = align4(loc);
      P.encodePointerSmall(x, loc, out, sh);
      P.encodeLarge(x, out, loc); loc += P.largeHeaderSize;
    } else {
      loc = align4(loc);
      x.infoOffset = loc;
      if (P.fitsSmall(x)) P.encodeSmall(x, out, sh);
      else { P.encodePointerSmall(x, loc, out, sh); P.encodeLarge(x, out, loc); loc += P.largeHeaderSize; }
    }
    if (hasExc) {
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
    if (hasDbg) { out.set(R.debugOff.bytes(P.debugOffsetsSize), loc); loc += P.debugOffsetsSize; }
  }
  out.set(s.debug, h.debugInfoOffset);
  const sha = createHash('sha1').update(out.subarray(0, out.length - 20)).digest();
  out.set(sha, out.length - 20);
  return out;
}
