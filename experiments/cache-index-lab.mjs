// Are property-cache index operands predictable from a per-function counter?
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as hbc from '../src/hbc.mjs';
import * as funcs from '../src/funcs.mjs';
import * as isa from '../src/isa.mjs';
import { CORPUS } from '../src/corpus.mjs';
const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
const slugs = manifest.apps.filter((a) => a.hbc.bytes > 1.2e6 && a.hbc.bytes < 3e6).slice(0, 6).map((a) => a.slug);
const ops = isa.loadOpcodes();
// Which (opcode, operand index) pairs are u8/u16 "uint" operands? Count value patterns per pair.
const stats = new Map(); // key -> {n, eqCounter, eqPrev, eqPrevPlus1, zero, hist}
for (const slug of slugs) {
  const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', slug, 'index.android.hbc')));
  const h = hbc.parseHeader(buf); const off = hbc.tableOffsets(h);
  const region = funcs.parseFunctionRegion(buf, off.functionHeaders.start, h.functionCount, off.tablesEnd);
  for (const b of region.bodies) {
    const counters = new Map(); const prev = new Map();
    for (const ins of b.instructions) {
      const def = ops[ins.opcode];
      def.operands.forEach((o, j) => {
        if (o.semantic !== 'uint') return;
        const k = `${def.name}[${j}]`; const v = ins.operands[j];
        const st = stats.get(k) ?? { n: 0, eqCounter: 0, eqPrevPlus1: 0, zero: 0, is255: 0, bytes: 0 };
        const c = counters.get(k) ?? 0;
        st.n++; st.bytes += o.size; if (v === c) st.eqCounter++; if (v === (prev.get(k) ?? -1) + 1) st.eqPrevPlus1++; if (v === 0) st.zero++; if (v === 255) st.is255++;
        counters.set(k, c + 1); prev.set(k, v); stats.set(k, st);
      });
    }
  }
  process.stderr.write('.');
}
console.log();
const rows = [...stats.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 24);
for (const [k, s] of rows) console.log(k.padEnd(30), String(s.n).padStart(8), 'bytes', String(s.bytes).padStart(8), 'eqCounter', (100 * s.eqCounter / s.n).toFixed(1).padStart(5) + '%', 'eqPrev+1', (100 * s.eqPrevPlus1 / s.n).toFixed(1).padStart(5) + '%', 'zero', (100 * s.zero / s.n).toFixed(1).padStart(5) + '%', '255', (100 * s.is255 / s.n).toFixed(1).padStart(5) + '%');
