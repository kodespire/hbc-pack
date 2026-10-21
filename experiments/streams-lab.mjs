// Compares instruction-stream layouts and operand transforms, measured with best-of{zstd,brotli}
// per stream. Usage: node experiments/streams-lab.mjs [slug ...]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as hbc from '../src/hbc.mjs';
import * as funcs from '../src/funcs.mjs';
import * as isa from '../src/isa.mjs';
import { ByteWriter } from '../src/bits.mjs';
import { encodeStream } from '../src/streams.mjs';
import { Encoder, newProbs } from '../src/rc.mjs';

import { CORPUS } from '../src/corpus.mjs';
const Z = (b) => encodeStream(b, {}).data.length;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const CLASS_OF = { register: 'reg', uint: 'u', string_id: 'str', function_id: 'fn', bigint_id: 'bi', jump_offset: 'addr', immediate: 'imm', double: 'dbl' };
const key = (o) => `${CLASS_OF[o.semantic]}${o.size * 8}`;

function put(w, type, v) {
  switch (type) {
    case 'Reg8': case 'UInt8': case 'Addr8': w.u8(v); break;
    case 'UInt16': w.u16(v); break;
    case 'Reg32': case 'UInt32': case 'Addr32': case 'Imm32': w.u32(v >>> 0); break;
    case 'Double': { w.ensure(8); new DataView(w.buf.buffer, w.buf.byteOffset + w.pos, 8).setFloat64(0, v, true); w.pos += 8; break; }
  }
}
const W = () => new ByteWriter(1 << 12);
const finishAll = (m) => Object.fromEntries(Object.entries(m).map(([k, w]) => [k, w.finish()]));
const total = (m) => sum(Object.values(m).map(Z));

// Order-2 adaptive byte coder (context = previous two symbols) for the opcode stream.
function rcOrder2(bytes) {
  const enc = new Encoder(bytes.length); const probs = newProbs(65536 * 256 >>> 0);
  let c1 = 0, c2 = 0;
  for (let i = 0; i < bytes.length; i++) { enc.byte(probs, ((c2 << 8) | c1) * 256, bytes[i]); c2 = c1; c1 = bytes[i]; }
  return enc.finish().length;
}
function rcOrder1(bytes) {
  const enc = new Encoder(bytes.length); const probs = newProbs(256 * 256);
  let c1 = 0;
  for (let i = 0; i < bytes.length; i++) { enc.byte(probs, c1 * 256, bytes[i]); c1 = bytes[i]; }
  return enc.finish().length;
}

// Move-to-front over 16-bit ids, emitting varint ranks.
function mtf16(values) {
  const list = [];
  const w = W();
  for (const v of values) {
    let i = list.indexOf(v);
    if (i < 0) { w.varint(list.length + 1); list.unshift(v); if (list.length > 4096) list.pop(); }
    else { w.varint(i); list.splice(i, 1); list.unshift(v); }
  }
  return w.finish();
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const slugs = process.argv.slice(2).length ? process.argv.slice(2) : manifest.apps.filter((a) => a.hbc.bytes > 1.2e6 && a.hbc.bytes < 3e6).slice(0, 6).map((a) => a.slug);
  const ops = isa.loadOpcodes();
  const R = {};
  const add = (k, v) => (R[k] = (R[k] ?? 0) + v);
  for (const slug of slugs) {
    const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', slug, 'index.android.hbc')));
    const h = hbc.parseHeader(buf); const off = hbc.tableOffsets(h);
    const region = funcs.parseFunctionRegion(buf, off.functionHeaders.start, h.functionCount, off.tablesEnd);
    const all = []; for (const b of region.bodies) for (const ins of b.instructions) all.push(ins);

    // A: by class+width (v1).
    const A = {}; const opc = W();
    // B: per-opcode operand tuples.
    const B = {};
    // C: per (opcode, operand index).
    const C = {};
    // D: class+width, but string/function ids split into byte planes, registers by operand index.
    const D = {};
    const regByPos = {};
    for (const ins of all) {
      opc.u8(ins.opcode);
      const def = ops[ins.opcode];
      for (let j = 0; j < def.operands.length; j++) {
        const o = def.operands[j]; const v = ins.operands[j];
        put(A[key(o)] ??= W(), o.type, v);
        put(B[ins.opcode] ??= W(), o.type, v);
        put(C[`${ins.opcode}:${j}`] ??= W(), o.type, v);
        if (o.semantic === 'register' && o.size === 1) (regByPos[j] ??= W()).u8(v);
        else if ((o.semantic === 'string_id' || o.semantic === 'function_id') && o.size === 2) { (D[key(o) + 'lo'] ??= W()).u8(v & 0xff); (D[key(o) + 'hi'] ??= W()).u8(v >>> 8); }
        else put(D[key(o)] ??= W(), o.type, v);
      }
    }
    const opcodes = opc.finish();
    const a = finishAll(A), b = finishAll(B), c = finishAll(C), d = finishAll(D), rp = finishAll(regByPos);
    add('opcodes best-of', Z(opcodes));
    add('opcodes rc-order1', rcOrder1(opcodes));
    add('opcodes rc-order2', rcOrder2(opcodes));
    add('A operands by class+width', total(a));
    add('B operands per opcode', total(b));
    add('C operands per (opcode,index)', total(c));
    add('D A + id byte planes + reg by position', total(d) + total(rp));
    add('  A reg8 alone', Z(a.reg8));
    add('  reg8 by operand position', total(rp));
    add('  A str16 alone', Z(a.str16));
    add('  str16 byte planes', Z(d.str16lo) + Z(d.str16hi));
    // MTF on str16 ids.
    const str16vals = []; for (const ins of all) { const def = ops[ins.opcode]; def.operands.forEach((o, j) => { if (o.semantic === 'string_id' && o.size === 2) str16vals.push(ins.operands[j]); }); }
    add('  str16 MTF ranks', Z(mtf16(str16vals)));
    // Opcode-conditioned register stream: registers of the top-N opcodes get their own streams, rest shared.
    const counts = new Map(); for (const ins of all) counts.set(ins.opcode, (counts.get(ins.opcode) ?? 0) + 1);
    const topN = new Set([...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 24).map((e) => e[0]));
    const E = {};
    for (const ins of all) { const def = ops[ins.opcode]; def.operands.forEach((o, j) => { if (o.semantic === 'register' && o.size === 1) (E[topN.has(ins.opcode) ? `${ins.opcode}` : 'rest'] ??= W()).u8(ins.operands[j]); }); }
    add('  reg8 per opcode (top 24) + rest', total(finishAll(E)));
    process.stderr.write('.');
  }
  console.log(`\n${slugs.length} files`);
  for (const [k, v] of Object.entries(R)) console.log(k.padEnd(44), String(v).padStart(9));
}
await main();
