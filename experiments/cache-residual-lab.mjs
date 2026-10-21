// Compressed size of the u8 operand stream as is, vs with cache indices replaced by residuals
// (idx - first-appearance rank of the property within the function, reads and writes separate).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as hbc from '../src/hbc.mjs';
import * as funcs from '../src/funcs.mjs';
import * as isa from '../src/isa.mjs';
import { ByteWriter } from '../src/bits.mjs';
import { encodeStream } from '../src/streams.mjs';
import { CORPUS } from '../src/corpus.mjs';
const Z = (b) => (b.length ? encodeStream(b, {}).data.length : 0);
const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
const slugs = manifest.apps.filter((a) => a.hbc.bytes > 1.2e6 && a.hbc.bytes < 3e6).slice(0, 6).map((a) => a.slug);
const ops = isa.loadOpcodes();
const cacheOps = new Map();
for (const def of ops) if (def) {
  const si = def.operands.findIndex((o) => o.semantic === 'string_id');
  const ci = def.operands.findIndex((o) => o.semantic === 'uint' && o.size === 1);
  if (si >= 0 && ci >= 0 && /ById/.test(def.name)) cacheOps.set(def.opcode, { si, ci, write: /Put|Define/.test(def.name) });
}
let u8Plain = 0, u8Rest = 0, resid = 0, residZeros = 0, residN = 0;
for (const slug of slugs) {
  const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', slug, 'index.android.hbc')));
  const h = hbc.parseHeader(buf); const off = hbc.tableOffsets(h);
  const region = funcs.parseFunctionRegion(buf, off.functionHeaders.start, h.functionCount, off.tablesEnd);
  const plain = new ByteWriter(1 << 16), rest = new ByteWriter(1 << 16), res = new ByteWriter(1 << 16);
  for (const b of region.bodies) {
    const rr = new Map(), wr = new Map();
    for (const ins of b.instructions) {
      const def = ops[ins.opcode]; const c = cacheOps.get(ins.opcode);
      def.operands.forEach((o, j) => {
        if (!(o.semantic === 'uint' && o.size === 1)) return;
        const v = ins.operands[j]; plain.u8(v);
        if (c && j === c.ci) {
          const ranks = c.write ? wr : rr; const sid = ins.operands[c.si];
          let r = ranks.get(sid); if (r === undefined) { r = ranks.size; ranks.set(sid, r); }
          res.svarint(v - r); residN++; if (v === r) residZeros++;
        } else rest.u8(v);
      });
    }
  }
  u8Plain += Z(plain.finish()); u8Rest += Z(rest.finish()); resid += Z(res.finish());
  process.stderr.write('.');
}
console.log(`\nu8 as is: ${u8Plain}   |   u8 without cache idx: ${u8Rest} + residuals: ${resid} = ${u8Rest + resid}   (${((1 - (u8Rest + resid) / u8Plain) * 100).toFixed(1)}% smaller); residual zeros ${(100 * residZeros / residN).toFixed(1)}%`);
