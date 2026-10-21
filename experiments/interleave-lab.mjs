// Does keeping opcodes and register operands in ONE stream beat separating them?
// Variants over the instruction stream: (S) separate opcodes / reg8 / rest-by-class (v1);
// (I1) opcode+reg8 interleaved, rest by class; (I2) opcode + all 1-byte operands interleaved.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as hbc from '../src/hbc.mjs';
import * as funcs from '../src/funcs.mjs';
import * as isa from '../src/isa.mjs';
import { ByteWriter } from '../src/bits.mjs';
import { encodeStream } from '../src/streams.mjs';
import { CORPUS } from '../src/corpus.mjs';
const Z = (b) => (b.length ? encodeStream(b, {}).data.length : 0);
const CLASS_OF = { register: 'reg', uint: 'u', string_id: 'str', function_id: 'fn', bigint_id: 'bi', jump_offset: 'addr', immediate: 'imm', double: 'dbl' };
const key = (o) => `${CLASS_OF[o.semantic]}${o.size * 8}`;
function put(w, type, v) {
  switch (type) { case 'Reg8': case 'UInt8': case 'Addr8': w.u8(v); break; case 'UInt16': w.u16(v); break;
    case 'Reg32': case 'UInt32': case 'Addr32': case 'Imm32': w.u32(v >>> 0); break;
    case 'Double': { w.ensure(8); new DataView(w.buf.buffer, w.buf.byteOffset + w.pos, 8).setFloat64(0, v, true); w.pos += 8; break; } }
}
const W = () => new ByteWriter(1 << 12);
const total = (m) => Object.values(m).reduce((a, w) => a + Z(w.finish()), 0);
const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
const slugs = manifest.apps.filter((a) => a.hbc.bytes > 1.2e6 && a.hbc.bytes < 3e6).slice(0, 6).map((a) => a.slug);
const ops = isa.loadOpcodes();
const R = {}; const add = (k, v) => (R[k] = (R[k] ?? 0) + v);
for (const slug of slugs) {
  const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', slug, 'index.android.hbc')));
  const h = hbc.parseHeader(buf); const off = hbc.tableOffsets(h);
  const region = funcs.parseFunctionRegion(buf, off.functionHeaders.start, h.functionCount, off.tablesEnd);
  const S = { op: W() }, I1 = { opreg: W() }, I2 = { op1: W() };
  for (const b of region.bodies) for (const ins of b.instructions) {
    const def = ops[ins.opcode];
    S.op.u8(ins.opcode); I1.opreg.u8(ins.opcode); I2.op1.u8(ins.opcode);
    def.operands.forEach((o, j) => {
      const v = ins.operands[j]; const k = key(o);
      put(S[k] ??= W(), o.type, v);
      if (k === 'reg8') I1.opreg.u8(v); else put(I1[k] ??= W(), o.type, v);
      if (o.size === 1) I2.op1.u8(v); else put(I2[k] ??= W(), o.type, v);
    });
  }
  add('S  separate (v1)', total(S)); add('I1 opcode+reg8 interleaved', total(I1)); add('I2 opcode+all 1-byte operands', total(I2));
  process.stderr.write('.');
}
console.log(`\n${slugs.length} files`); for (const [k, v] of Object.entries(R)) console.log(k.padEnd(34), String(v).padStart(9));
