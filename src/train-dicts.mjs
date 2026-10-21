#!/usr/bin/env node
// Trains one zstd dictionary per stream on the corpus's "train" apps (same owner-hash split as
// hermes-corpus/bench.mjs), for the shared-dictionary mode of the codec.
//
//   node src/train-dicts.mjs <outDir> [--budget BYTES] [--codec src/codec-vN.mjs]
//   (default budget 1 MiB, split across streams in proportion to each stream's compressed size)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CORPUS } from './corpus.mjs';
import { encodeStream } from './streams.mjs';

const args = process.argv.slice(2);
const codecPath = args.includes('--codec') ? path.resolve(args[args.indexOf('--codec') + 1]) : path.resolve(path.dirname(new URL(import.meta.url).pathname), 'codec-v3.mjs');
const { extractStreams } = await import(codecPath);
const outDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'results/dicts');
const budget = Number(args[args.indexOf('--budget') + 1] || 0) || 1048576;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const splitOf = (slug) => (parseInt(sha256(slug.split('__')[0]).slice(0, 2), 16) < 128 ? 'train' : 'test');

const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
const train = manifest.apps.filter((a) => splitOf(a.slug) === 'train');
const tmp = path.join(os.tmpdir(), `hbc-dict-${process.pid}`);
mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });
const sizes = {}; // stream -> compressed bytes without dictionary (for the budget split)
const samples = {};
console.log(`training on ${train.length} apps`);
for (const app of train) {
  const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', app.slug, 'index.android.hbc')));
  for (const s of extractStreams(buf)) {
    if (s.bytes.length < 64) continue;
    const dir = path.join(tmp, s.name); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${app.slug}.bin`), s.bytes);
    sizes[s.name] = (sizes[s.name] ?? 0) + encodeStream(s.bytes, { backends: ['zstd'] }).data.length;
    (samples[s.name] ??= []).push(path.join(dir, `${app.slug}.bin`));
  }
  process.stderr.write('.');
}
const total = Object.values(sizes).reduce((a, b) => a + b, 0);
const report = [];
for (const [name, bytes] of Object.entries(sizes).sort((a, b) => b[1] - a[1])) {
  const share = bytes / total;
  const maxdict = Math.max(4096, Math.round(budget * share));
  if (maxdict < 8192) continue; // not worth a dictionary
  const out = path.join(outDir, `${name}.zdict`);
  const raw = samples[name].reduce((a, f) => a + statSync(f).size, 0);
  const block = raw / samples[name].length > 65536 ? 65536 : 8192;
  try {
    execFileSync('zstd', ['-q', '--train', `-B${block}`, `--maxdict=${maxdict}`, '-o', out, ...samples[name]], { stdio: ['ignore', 'ignore', 'pipe'] });
    report.push({ name, maxdict, got: statSync(out).size, raw });
  } catch (err) {
    report.push({ name, maxdict, error: String(err.stderr || err.message).split('\n')[0] });
  }
}
rmSync(tmp, { recursive: true, force: true });
for (const r of report) console.log(`\n${r.name.padEnd(14)} budget ${String(r.maxdict).padStart(8)} ${r.got ? `dict ${r.got} bytes from ${r.raw} raw` : r.error}`);
console.log(`\ndictionaries in ${outDir}: ${report.filter((r) => r.got).reduce((a, r) => a + r.got, 0)} bytes total`);
