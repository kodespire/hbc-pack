// Hypothesis: within a function, the property cache index of GetById-family / PutById-family
// instructions equals the first-appearance rank of the property (string id) among that
// function's reads (resp. writes).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as hbc from '../src/hbc.mjs';
import * as funcs from '../src/funcs.mjs';
import * as isa from '../src/isa.mjs';
import { CORPUS } from '../src/corpus.mjs';
const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
const slugs = manifest.apps.filter((a) => a.hbc.bytes > 1.2e6 && a.hbc.bytes < 3e6).slice(0, 6).map((a) => a.slug);
const ops = isa.loadOpcodes();
// For each opcode with a cache operand: index of the cache operand and of the string-id operand.
const cacheOps = new Map();
for (const def of ops) if (def) {
  const si = def.operands.findIndex((o) => o.semantic === 'string_id');
  const ci = def.operands.findIndex((o) => o.semantic === 'uint' && o.size === 1);
  if (si >= 0 && ci >= 0 && /ById|ByVal/.test(def.name)) cacheOps.set(def.opcode, { si, ci, write: /Put|Define/.test(def.name), name: def.name });
}
console.log('cache ops:', [...cacheOps.values()].map((c) => `${c.name}${c.write ? '(w)' : ''}`).join(' '));
const stats = {}; let allRead = 0, allWrite = 0;
for (const slug of slugs) {
  const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', slug, 'index.android.hbc')));
  const h = hbc.parseHeader(buf); const off = hbc.tableOffsets(h);
  const region = funcs.parseFunctionRegion(buf, off.functionHeaders.start, h.functionCount, off.tablesEnd);
  for (const b of region.bodies) {
    const readRank = new Map(), writeRank = new Map();
    for (const ins of b.instructions) {
      const c = cacheOps.get(ins.opcode); if (!c) continue;
      const sid = ins.operands[c.si], idx = ins.operands[c.ci];
      const ranks = c.write ? writeRank : readRank;
      let r = ranks.get(sid); if (r === undefined) { r = ranks.size; ranks.set(sid, r); }
      const st = stats[c.name] ??= { n: 0, eqRank: 0, disabled: 0 };
      st.n++; if (idx === r) st.eqRank++; if (idx === 255) st.disabled++;
    }
  }
  process.stderr.write('.');
}
console.log();
for (const [k, s] of Object.entries(stats).sort((a, b) => b[1].n - a[1].n)) console.log(k.padEnd(22), String(s.n).padStart(8), 'eqRank', (100 * s.eqRank / s.n).toFixed(2).padStart(6) + '%', 'disabled(255)', (100 * s.disabled / s.n).toFixed(2) + '%');
