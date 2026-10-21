// Delta updates: how many bytes does the NEW version of an app cost when the device already has
// the OLD version? Pairs come from hermes-corpus/tools/build-pairs.mjs (bundles-pairs/<slug>/{old,new}).
//
// Measured per pair:
//   JS  : new bundle alone (zstd-22, brotli-11); zstd --patch-from old bundle
//   HBC : new .hbc alone (zstd-22, brotli-11, hbc-pack); zstd --patch-from old .hbc (whole file);
//         hbc-pack streams of new patched against the same streams of old ("per-stream patch":
//         zstd --patch-from per stream, falling back to the no-base backend when that is smaller)
//
//   node experiments/delta-lab.mjs
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { compressSync } from '@kodespire/zstd-js';
import { CORPUS } from '../src/corpus.mjs';
import { extractStreams, pack } from '../src/codec.mjs';
import { encodeStream } from '../src/streams.mjs';

const PAIRS = path.join(CORPUS, 'bundles-pairs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'delta-'));
const brotli = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }).length;
const zstd22 = (b) => compressSync(b, { level: 22 }).length;
function patch(oldBytes, newBytes) {
  // zstd --patch-from: the old file is the dictionary; --long=27 lets matches reach anywhere in it.
  const o = path.join(tmp, 'old.bin'), n = path.join(tmp, 'new.bin');
  writeFileSync(o, oldBytes); writeFileSync(n, newBytes);
  return execFileSync('zstd', ['-q', '-c', '--ultra', '-22', '--long=27', `--patch-from=${o}`, n], { maxBuffer: 1 << 30 }).length;
}
const mb = (n) => (n / 1e6).toFixed(3);
const rows = [];
for (const slug of readdirSync(PAIRS).sort()) {
  const dir = path.join(PAIRS, slug);
  if (!existsSync(path.join(dir, 'old/index.android.hbc')) || !existsSync(path.join(dir, 'new/index.android.hbc'))) continue;
  const meta = JSON.parse(readFileSync(path.join(dir, 'pair.json'), 'utf8'));
  const oldHbc = new Uint8Array(readFileSync(path.join(dir, 'old/index.android.hbc'))), newHbc = new Uint8Array(readFileSync(path.join(dir, 'new/index.android.hbc')));
  const oldJs = readFileSync(path.join(dir, 'old/index.android.bundle')), newJs = readFileSync(path.join(dir, 'new/index.android.bundle'));
  const r = { slug, commitsBack: meta.commitsBack, jsNew: newJs.length, hbcNew: newHbc.length,
    jsZstd: zstd22(newJs), jsBrotli: brotli(newJs), jsPatch: patch(oldJs, newJs),
    hbcZstd: zstd22(newHbc), hbcBrotli: brotli(newHbc), hbcPack: pack(newHbc, { brotliVariants: false }).length, hbcPatch: patch(oldHbc, newHbc) };
  // Per-stream patch.
  const oldStreams = new Map(extractStreams(oldHbc).map((s) => [s.name, s.bytes]));
  let perStream = 6; // container header
  for (const s of extractStreams(newHbc)) {
    const plain = encodeStream(s.bytes, { brotliVariants: false }).data.length;
    const base = oldStreams.get(s.name);
    const patched = base && base.length && s.bytes.length >= 64 ? patch(base, s.bytes) : Infinity;
    perStream += Math.min(plain, patched) + 4 + 17;
  }
  r.hbcStreamPatch = perStream;
  rows.push(r);
  console.log(`${slug.padEnd(44)} JS ${mb(r.jsNew)}MB: zstd ${mb(r.jsZstd)} patch ${mb(r.jsPatch)} | HBC ${mb(r.hbcNew)}MB: zstd ${mb(r.hbcZstd)} hbc-pack ${mb(r.hbcPack)} patch ${mb(r.hbcPatch)} stream-patch ${mb(r.hbcStreamPatch)}`);
}
rmSync(tmp, { recursive: true, force: true });
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
console.log(`\n${rows.length} pairs (new version vs ${rows[0]?.commitsBack} commits earlier). Totals, MB:`);
console.log('| what the update ships | JS | HBC |'); console.log('|---|---:|---:|');
console.log(`| uncompressed | ${mb(sum('jsNew'))} | ${mb(sum('hbcNew'))} |`);
console.log(`| zstd -22, no base | ${mb(sum('jsZstd'))} | ${mb(sum('hbcZstd'))} |`);
console.log(`| brotli -11, no base | ${mb(sum('jsBrotli'))} | ${mb(sum('hbcBrotli'))} |`);
console.log(`| hbc-pack, no base | – | ${mb(sum('hbcPack'))} |`);
console.log(`| zstd --patch-from the installed version (whole file) | ${mb(sum('jsPatch'))} | ${mb(sum('hbcPatch'))} |`);
console.log(`| hbc-pack streams patched against the installed version's streams | – | ${mb(sum('hbcStreamPatch'))} |`);
writeFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../results/delta-pairs.json'), JSON.stringify(rows, null, 2));
