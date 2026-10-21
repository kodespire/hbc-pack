// How are literal buffers referenced? Collect (offset, count) from instructions and the shape
// table, then look at coverage and overlaps of the value and key buffers.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as hbc from '../src/hbc.mjs';
import * as funcs from '../src/funcs.mjs';
import * as isa from '../src/isa.mjs';
import { parseLiteralRuns } from './literals-lab.mjs';
import { CORPUS } from '../src/corpus.mjs';
const slug = process.argv[2] ?? 'az11k-dev__jarvis-app';
const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', slug, 'index.android.hbc')));
const h = hbc.parseHeader(buf); const off = hbc.tableOffsets(h);
const region = funcs.parseFunctionRegion(buf, off.functionHeaders.start, h.functionCount, off.tablesEnd);
const ops = isa.loadOpcodes();
const vals = buf.subarray(off.arrayBuffer.start, off.arrayBuffer.start + off.arrayBuffer.size);
const keys = buf.subarray(off.objKeyBuffer.start, off.objKeyBuffer.start + off.objKeyBuffer.size);
const shapes = []; for (let i = 0; i < h.objShapeTableCount; i++) { const p = off.objShapeTable.start + 8 * i; shapes.push({ off: buf[p] | (buf[p+1]<<8) | (buf[p+2]<<16) | (buf[p+3]<<24), n: buf[p+4] | (buf[p+5]<<8) | (buf[p+6]<<16) | (buf[p+7]<<24) }); }
const valRefs = new Map(), keyRefs = new Map();
for (const b of region.bodies) for (const ins of b.instructions) {
  const nm = ops[ins.opcode].name;
  if (nm === 'NewArrayWithBuffer' || nm === 'NewArrayWithBufferLong') valRefs.set(ins.operands[3], ins.operands[2]);
  else if (nm === 'NewObjectWithBuffer' || nm === 'NewObjectWithBufferLong') { const s = shapes[ins.operands[1]]; valRefs.set(ins.operands[2], s.n); keyRefs.set(s.off, s.n); }
  else if (nm === 'NewObjectWithBufferAndParent') { const s = shapes[ins.operands[2]]; valRefs.set(ins.operands[3], s.n); keyRefs.set(s.off, s.n); }
}
for (const s of shapes) keyRefs.set(s.off, s.n);
// Parse `count` values starting at offset; return end offset.
function parseN(bytes, start, count) {
  let p = start, got = 0;
  while (got < count) {
    const tag = bytes[p++]; const type = (tag & 0x70) >>> 4; let n = tag & 0x0f; if (tag & 0x80) n = (n << 8) | bytes[p++];
    const sz = [0, 0, 0, 8, 4, 2, 0, 4][type];
    p += n * sz; got += n;
  }
  if (got !== count) throw new Error(`ref at ${start}: got ${got} want ${count}`);
  return p;
}
for (const [name, bytes, refs] of [['values', vals, valRefs], ['keys', keys, keyRefs]]) {
  const sorted = [...refs.entries()].sort((a, b) => a[0] - b[0]);
  const cover = new Uint8Array(bytes.length); let overlaps = 0, bad = 0, gaps = 0, contained = 0;
  let prevEnd = 0;
  const spans = [];
  for (const [o, n] of sorted) { let e; try { e = parseN(bytes, o, n); } catch (err) { bad++; continue; } spans.push([o, e]); if (o < prevEnd) { overlaps++; if (e <= prevEnd) contained++; } else if (o > prevEnd) gaps++; for (let p = o; p < e; p++) cover[p] = 1; prevEnd = Math.max(prevEnd, e); }
  let uncovered = 0; for (const c of cover) if (!c) uncovered++;
  console.log(`${name}: ${bytes.length} bytes, ${sorted.length} refs, bad ${bad}, overlapping starts ${overlaps} (fully contained ${contained}), gaps ${gaps}, uncovered bytes ${uncovered}`);
  // Show the first overlap.
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i-1][1]) { console.log('  e.g.', spans[i-1], spans[i], 'bytes', Buffer.from(bytes.subarray(spans[i-1][0], Math.min(spans[i-1][1], spans[i-1][0]+24))).toString('hex'), '|', Buffer.from(bytes.subarray(spans[i][0], Math.min(spans[i][1], spans[i][0]+24))).toString('hex')); break; }
  console.log('  first 40 bytes:', Buffer.from(bytes.subarray(0, 40)).toString('hex'), 'first refs', sorted.slice(0, 4));
}
