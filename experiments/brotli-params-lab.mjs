// Brotli parameter sweep per stream: default (q11, lgwin 24) vs text mode vs lgblock 24, plus zstd-22.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { compressSync } from '@kodespire/zstd-js';
import { CORPUS } from '../src/corpus.mjs';
import { extractStreams } from '../src/codec-v2.mjs';
const C = zlib.constants;
const br = (b, extra) => zlib.brotliCompressSync(b, { params: { [C.BROTLI_PARAM_QUALITY]: 11, [C.BROTLI_PARAM_LGWIN]: 24, [C.BROTLI_PARAM_SIZE_HINT]: b.length, ...extra } }).length;
const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
const slugs = manifest.apps.filter((a) => a.hbc.bytes > 1.2e6 && a.hbc.bytes < 3e6).slice(0, 6).map((a) => a.slug);
const R = {}; const add = (k, v) => (R[k] = (R[k] ?? 0) + v);
for (const slug of slugs) {
  const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', slug, 'index.android.hbc')));
  for (const s of extractStreams(buf)) {
    if (s.bytes.length < 4096) continue;
    add(`${s.name} zstd22`, compressSync(s.bytes, { level: 22 }).length);
    add(`${s.name} brotli`, br(s.bytes, {}));
    add(`${s.name} brotli text`, br(s.bytes, { [C.BROTLI_PARAM_MODE]: C.BROTLI_MODE_TEXT }));
    add(`${s.name} brotli lgblock24`, br(s.bytes, { [C.BROTLI_PARAM_LGBLOCK]: 24 }));
    add(`${s.name} brotli npostfix3 ndirect120`, br(s.bytes, { [C.BROTLI_PARAM_NPOSTFIX]: 3, [C.BROTLI_PARAM_NDIRECT]: 120 }));
  }
  process.stderr.write('.');
}
console.log();
const names = [...new Set(Object.keys(R).map((k) => k.split(' ')[0]))];
for (const n of names) { const row = Object.entries(R).filter(([k]) => k.startsWith(n + ' ')); const best = Math.min(...row.map(([, v]) => v)); console.log(n.padEnd(14), row.map(([k, v]) => `${k.slice(n.length + 1)}=${v}${v === best ? '*' : ''}`).join('  ')); }
