// Delta containers: the literal buffers (objKeyBuffer, arrayBuffer) gain almost nothing from the
// base (delta/plain 0.99 and 0.65, experiments/delta-streams-lab.mjs) because the string ids inside
// them are renumbered. Measures what canonicalising those ids would buy: both buffers are split
// into typed columns from their references (src/literals.mjs, as codec-v4 did), the 16/32-bit
// string-id columns are rewritten as u32 canonical ids, and each column is compressed against the
// base's column. Overlapping literals (the Tail column) stay raw.
//   node experiments/delta-literals-lab.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CORPUS } from '../src/corpus.mjs';
import * as hbc from '../src/hbc.mjs';
import * as funcs from '../src/funcs.mjs';
import * as isa from '../src/isa.mjs';
import * as T from '../src/tables.mjs';
import * as lit from '../src/literals.mjs';
import { canonicalIds, stringKeysOf } from '../src/codec.mjs';
import { encodeStream } from '../src/streams.mjs';
import { ByteReader, ByteWriter } from '../src/bits.mjs';

const PAIRS = path.join(CORPUS, 'bundles-pairs');
const BUFFER_OPS = { NewArrayWithBuffer: ['array', 2, 3], NewArrayWithBufferLong: ['array', 2, 3], NewObjectWithBuffer: ['object', 1, 2],
  NewObjectWithBufferLong: ['object', 1, 2], NewObjectWithBufferAndParent: ['object', 2, 3] };
function shapeEntries(bytes) {
  const n = bytes.length / 8, out = new Array(n);
  for (let i = 0; i < n; i++) { const p = 8 * i; out[i] = [(bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0, (bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16) | (bytes[p + 7] << 24)) >>> 0]; }
  return out;
}
// Typed columns of both buffers, string ids mapped through `map` (identity when null) as u32.
function typedBuffers(buf, map) {
  const h = hbc.parseHeader(buf), off = hbc.tableOffsets(h), ops = isa.opcodes(h.version);
  const region = funcs.parseFunctionRegion(buf, h, off.functionHeaders.start, off.tablesEnd);
  const shapes = shapeEntries(T.slice(buf, off.objShapeTable));
  const valueSpans = [], keySpans = shapes.map(([o, n]) => [o, n]);
  for (const b of region.bodies) for (const ins of b.instructions) {
    const bo = BUFFER_OPS[ops[ins.opcode].name];
    if (bo) valueSpans.push([ins.operands[bo[2]], bo[0] === 'array' ? ins.operands[bo[1]] : shapes[ins.operands[bo[1]]][1]]);
  }
  const widen = (bytes, width) => { const r = new ByteReader(bytes), w = new ByteWriter(bytes.length * 2 + 8); while (r.remaining) { const v = width === 2 ? r.u16() : r.u32(); w.u32(map ? map[v] : v); } return w.finish(); };
  const out = {};
  for (const [name, section, spans] of [['key', off.objKeyBuffer, keySpans], ['val', off.arrayBuffer, valueSpans]]) {
    const bytes = T.slice(buf, section);
    const cols = lit.encodeBuffer(bytes, lit.normalizeSpans(spans));
    cols.S16 = widen(cols.S16, 2); cols.S32 = widen(cols.S32, 4);
    out[name] = { bytes, cols };
  }
  return out;
}
const Z = (b, dict) => (b.length ? encodeStream(b, { brotliVariants: false, backends: dict && dict.length >= 64 ? ['zstd', 'brotli', 'zstd-dict'] : ['zstd', 'brotli'], dict }).data.length : 0);
const mb = (n) => (n / 1e6).toFixed(3);
const tot = { key: { raw: 0, plain: 0, delta: 0, typed: 0, canon: 0, tail: 0 }, val: { raw: 0, plain: 0, delta: 0, typed: 0, canon: 0, tail: 0 } };
let pairs = 0;
for (const slug of readdirSync(PAIRS).sort()) {
  const dir = path.join(PAIRS, slug);
  if (!existsSync(path.join(dir, 'new/index.android.hbc'))) continue;
  const base = new Uint8Array(readFileSync(path.join(dir, 'old/index.android.hbc'))), next = new Uint8Array(readFileSync(path.join(dir, 'new/index.android.hbc')));
  const { toCanonical } = canonicalIds(stringKeysOf(base), stringKeysOf(next));
  const B = typedBuffers(base, null), N = typedBuffers(next, null), C = typedBuffers(next, toCanonical);
  const line = [slug.padEnd(44)];
  for (const k of ['key', 'val']) {
    const raw = N[k].bytes.length, plain = Z(N[k].bytes), delta = Z(N[k].bytes, B[k].bytes);
    const sum = (cols, basecols) => Object.keys(cols).reduce((a, c) => a + Z(cols[c], basecols[c]), 0);
    const typed = sum(N[k].cols, B[k].cols), canon = sum(C[k].cols, B[k].cols);
    tot[k].raw += raw; tot[k].plain += plain; tot[k].delta += delta; tot[k].typed += typed; tot[k].canon += canon; tot[k].tail += N[k].cols.Tail.length;
    line.push(`${k}: raw ${(raw / 1e3).toFixed(0)}K plain ${(plain / 1e3).toFixed(0)}K delta ${(delta / 1e3).toFixed(0)}K typed+base ${(typed / 1e3).toFixed(0)}K canon+base ${(canon / 1e3).toFixed(0)}K (tail ${(100 * N[k].cols.Tail.length / raw).toFixed(0)}%)`);
  }
  console.log(line.join(' | ')); pairs++;
}
console.log(`\n${pairs} pairs, MB:`);
console.log('| buffer | raw | plain (no base) | delta today (bytes vs base) | typed columns vs base | typed + canonical string ids vs base | raw bytes in Tail (overlaps) |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const k of ['key', 'val']) console.log(`| ${k === 'key' ? 'objKeyBuffer' : 'arrayBuffer'} | ${mb(tot[k].raw)} | ${mb(tot[k].plain)} | ${mb(tot[k].delta)} | ${mb(tot[k].typed)} | **${mb(tot[k].canon)}** | ${mb(tot[k].tail)} |`);
