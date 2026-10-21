// Literal value buffer and object key buffer: can the whole buffer be parsed as back-to-back
// tagged runs (no overlaps)? And how much do typed columns save over the raw bytes?
// Also: order-2 CM vs best-of{zstd,brotli} on string storage.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as hbc from '../src/hbc.mjs';
import { ByteWriter } from '../src/bits.mjs';
import { encodeStream } from '../src/streams.mjs';
import { Encoder, newProbs } from '../src/rc.mjs';

import { CORPUS } from '../src/corpus.mjs';
const Z = (b) => (b.length ? encodeStream(b, {}).data.length : 0);

// Parses a buffer of tagged runs. Returns runs [{type, count, values}] or throws.
export function parseLiteralRuns(buf) {
  const runs = [];
  let p = 0;
  while (p < buf.length) {
    const tag = buf[p++];
    const type = (tag & 0x70) >>> 4;
    let count = tag & 0x0f;
    if (tag & 0x80) count = (count << 8) | buf[p++];
    if (count === 0) throw new Error(`zero-length run at ${p - 1}`);
    const values = [];
    for (let i = 0; i < count; i++) {
      switch (type) {
        case 0: case 1: case 2: case 6: break;
        case 3: values.push(buf.subarray(p, p + 8)); p += 8; break;
        case 4: values.push(buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)); p += 4; break;
        case 5: values.push(buf[p] | (buf[p + 1] << 8)); p += 2; break;
        case 7: values.push((buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) | 0); p += 4; break;
      }
      if (p > buf.length) throw new Error('run overflows buffer');
    }
    runs.push({ type, count, values, longForm: !!(tag & 0x80) });
  }
  return runs;
}

function mtf16(values, max = 8192) {
  const list = []; const w = new ByteWriter(values.length * 2 + 16);
  for (const v of values) {
    const i = list.indexOf(v);
    if (i < 0) { w.varint(list.length + 1); list.unshift(v); if (list.length > max) list.pop(); }
    else { w.varint(i); list.splice(i, 1); list.unshift(v); }
  }
  return w.finish();
}

function rcOrder2(bytes) {
  const enc = new Encoder(bytes.length); const probs = newProbs(65536 * 256);
  let c1 = 0, c2 = 0;
  for (let i = 0; i < bytes.length; i++) { enc.byte(probs, ((c2 << 8) | c1) * 256, bytes[i]); c2 = c1; c1 = bytes[i]; }
  return enc.finish().length;
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const slugs = process.argv.slice(2).length ? process.argv.slice(2) : manifest.apps.filter((a) => a.hbc.bytes > 1.2e6 && a.hbc.bytes < 3e6).slice(0, 6).map((a) => a.slug);
  const R = {}; const add = (k, v) => (R[k] = (R[k] ?? 0) + v);
  let tiled = 0, failed = 0;
  for (const slug of slugs) {
    const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', slug, 'index.android.hbc')));
    const h = hbc.parseHeader(buf); const off = hbc.tableOffsets(h);
    for (const [name, sec] of [['array', off.arrayBuffer], ['objKey', off.objKeyBuffer]]) {
      const bytes = buf.subarray(sec.start, sec.start + sec.size);
      let runs;
      try { runs = parseLiteralRuns(bytes); tiled++; } catch (e) { failed++; console.log(`${slug} ${name}: ${e.message}`); continue; }
      add(`${name} raw best-of`, Z(bytes));
      // Columns: tags (type<<4 | longForm, then counts varint), per-type value streams.
      const tags = new ByteWriter(runs.length + 16), counts = new ByteWriter(runs.length * 2 + 16);
      const s16 = [], s32 = new ByteWriter(1024), ints = new ByteWriter(1024), dbl = new ByteWriter(1024);
      let typeHist = {};
      for (const r of runs) {
        tags.u8((r.type << 4) | (r.longForm ? 0x80 : 0)); counts.varint(r.count);
        typeHist[r.type] = (typeHist[r.type] ?? 0) + r.count;
        for (const v of r.values) {
          if (r.type === 5) s16.push(v);
          else if (r.type === 4) s32.u32(v);
          else if (r.type === 7) ints.svarint(v);
          else if (r.type === 3) dbl.bytes(v);
        }
      }
      const s16raw = new ByteWriter(s16.length * 2 + 16); for (const v of s16) s16raw.u16(v);
      const cols = Z(tags.finish()) + Z(counts.finish()) + Z(s32.finish()) + Z(ints.finish()) + Z(dbl.finish());
      add(`${name} columns + s16 raw`, cols + Z(s16raw.finish()));
      add(`${name} columns + s16 MTF`, cols + Z(mtf16(s16)));
      add(`${name} runs`, runs.length); add(`${name} short-string values`, s16.length);
      if (slug === slugs[0]) console.log(`${slug} ${name}: ${runs.length} runs, type histogram`, typeHist);
    }
    const storage = buf.subarray(off.stringStorage.start, off.stringStorage.start + off.stringStorage.size);
    add('storage best-of', Z(storage)); add('storage rc-order2', rcOrder2(storage));
    process.stderr.write('.');
  }
  console.log(`\n${slugs.length} files; buffers tiled ${tiled}, failed ${failed}`);
  for (const [k, v] of Object.entries(R)) console.log(k.padEnd(32), String(v).padStart(9));
}
await main();
