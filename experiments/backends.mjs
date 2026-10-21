import { compressSync } from '@kodespire/zstd-js';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as hbc from '../src/hbc.mjs';
import { CORPUS } from '../src/corpus.mjs';
const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
const slugs = manifest.apps.slice(0, 12).map((a) => a.slug);
const T = {}; const add = (k, v) => (T[k] = (T[k] ?? 0) + v);
const xz = (b, extra) => execFileSync('xz', ['-9e', '--format=raw', '-c', ...extra], { input: b, maxBuffer: 1 << 30 }).length;
const br = (b, lgwin) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: lgwin, [zlib.constants.BROTLI_PARAM_LARGE_WINDOW]: lgwin > 24 ? 1 : 0, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length;
for (const s of slugs) {
  const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', s, 'index.android.hbc')));
  const h = hbc.parseHeader(buf); const off = hbc.tableOffsets(h);
  const regions = { funcs: buf.subarray(off.tablesEnd, h.debugInfoOffset), storage: buf.subarray(off.stringStorage.start, off.stringStorage.start + off.stringStorage.size) };
  for (const [name, b] of Object.entries(regions)) {
    add(`${name} raw`, b.length);
    add(`${name} zstd-22`, compressSync(b, { level: 22 }).length);
    add(`${name} xz-9e`, xz(b, []));
    add(`${name} xz-9e pb0`, xz(b, ['--lzma1=preset=9e,pb=0']));
    add(`${name} xz-9e lc0lp0pb0`, xz(b, ['--lzma1=preset=9e,lc=0,lp=0,pb=0']));
    add(`${name} brotli-11 w24`, br(b, 24));
    add(`${name} brotli-11 w28`, br(b, 28));
  }
  process.stderr.write('.');
}
console.log();
for (const [k, v] of Object.entries(T)) console.log(k.padEnd(28), String(v).padStart(10), k.endsWith('raw') ? '' : (T[k.split(' ')[0] + ' raw'] / v).toFixed(3) + 'x');
