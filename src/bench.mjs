#!/usr/bin/env node
// Runs a codec over every .hbc in the corpus, checks the round trip, and compares the total with
// the general-purpose baselines.
//
//   node src/bench.mjs <codec.mjs> [--only slug,slug] [--name label] [--jobs N] [--opts JSON] [--dir bundles96]
//
// A codec module exports `pack(bytes, opts) -> Uint8Array` and `unpack(bytes) -> Uint8Array`.
// Results go to results/<label>.csv; a line per file with sizes and timings.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';
import { compressSync as zstdCompress } from '@kodespire/zstd-js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PACK_ROOT = path.resolve(HERE, '..');
import { CORPUS } from './corpus.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

// ---------------------------------------------------------------------------------------------
// worker: pack + unpack one file

if (!isMainThread) {
  const { codecPath, file, opts } = workerData;
  const codec = await import(codecPath);
  const original = new Uint8Array(await readFile(file));
  const t0 = performance.now();
  const packed = codec.pack(original, opts);
  const packMs = performance.now() - t0;
  // Decode three times, take the median.
  const times = [];
  let decoded;
  for (let i = 0; i < 3; i++) {
    const t1 = performance.now();
    decoded = codec.unpack(packed, opts);
    times.push(performance.now() - t1);
  }
  times.sort((a, b) => a - b);
  const ok = decoded.length === original.length && Buffer.compare(Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength), Buffer.from(original.buffer, original.byteOffset, original.byteLength)) === 0;
  let firstDiff = -1;
  if (!ok) {
    const n = Math.min(decoded.length, original.length);
    for (let i = 0; i < n; i++) if (decoded[i] !== original[i]) { firstDiff = i; break; }
    if (firstDiff < 0) firstDiff = n;
  }
  parentPort.postMessage({ original: original.length, packed: packed.length, packMs, unpackMs: times[1], ok, firstDiff, stats: codec.lastStats?.() ?? null });
}

// ---------------------------------------------------------------------------------------------

function runWorker(codecPath, file, opts) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { codecPath, file, opts }, resourceLimits: { maxOldGenerationSizeMb: 8192 } });
    w.once('message', (m) => { resolve(m); w.terminate(); });
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
}

async function baselines(slugs, bundlesDir) {
  if (bundlesDir !== 'bundles') return {}; // computed per file in main()
  // From the corpus benchmark (per-file compressed sizes) and the floor measurement when present.
  const out = {};
  const add = (codec, slug, bytes) => { (out[codec] ??= {})[slug] = bytes; };
  const raw = path.join(CORPUS, 'results/raw.csv');
  if (existsSync(raw)) {
    for (const line of (await readFile(raw, 'utf8')).trim().split('\n').slice(1)) {
      const [slug, format, , codec, , compressed] = line.split(',');
      if (format === 'hbc' && slugs.has(slug)) add(codec, slug, Number(compressed));
    }
  }
  const floor = path.join(PACK_ROOT, 'research/floor.csv');
  if (existsSync(floor)) {
    const lines = (await readFile(floor, 'utf8')).trim().split('\n');
    const head = lines[0].split(',');
    const ix = (n) => head.indexOf(n);
    for (const line of lines.slice(1)) {
      const f = line.split(',');
      if (f[ix('format')] === 'hbc' && slugs.has(f[ix('slug')])) add(f[ix('compressor')], f[ix('slug')], Number(f[ix('compressed_bytes')]));
    }
  }
  return out;
}

const fmtMB = (n) => `${(n / 1e6).toFixed(2)} MB`;

async function main() {
  const codecArg = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true && a.endsWith('.mjs'));
  if (!codecArg) { console.error('usage: node src/bench.mjs <codec.mjs> [--only a,b] [--name label] [--jobs N] [--opts JSON]'); process.exit(2); }
  const codecPath = path.resolve(codecArg);
  const label = option('--name', path.basename(codecArg, '.mjs'));
  const jobs = Math.max(1, Math.min(4, Number(option('--jobs', 2))));
  const opts = JSON.parse(option('--opts', '{}'));
  const only = option('--only', null)?.split(',');
  const bundlesDir = option('--dir', 'bundles');
  const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const apps = manifest.apps.filter((a) => !only || only.includes(a.slug));
  const base = await baselines(new Set(apps.map((a) => a.slug)), bundlesDir);

  const rows = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < apps.length) {
      const app = apps[next++];
      const file = path.join(CORPUS, bundlesDir, app.slug, 'index.android.hbc');
      let r;
      try {
        r = await runWorker(codecPath, file, opts);
      } catch (err) {
        r = { original: app.hbc.bytes, packed: NaN, packMs: NaN, unpackMs: NaN, ok: false, error: String(err.message).split('\n')[0] };
      }
      rows.push({ slug: app.slug, ...r });
      if (bundlesDir !== 'bundles') {
        // No stored baselines for other corpora: compute zstd-22 and brotli-11 here.
        const orig = await readFile(file);
        (base['zstd-22'] ??= {})[app.slug] = zstdCompress(new Uint8Array(orig), { level: 22 }).length;
        (base['brotli-11'] ??= {})[app.slug] = zlib.brotliCompressSync(orig, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }).length;
      }
      const z = base['zstd-22']?.[app.slug];
      const flag = r.ok ? 'ok  ' : 'FAIL';
      console.log(`${flag} ${app.slug.padEnd(48)} ${String(r.original).padStart(9)} -> ${String(r.packed).padStart(8)}  ${(r.original / r.packed).toFixed(3)}x` +
        (z ? `  (zstd-22 ${(r.original / z).toFixed(3)}x, ${((r.packed / z - 1) * 100).toFixed(1).padStart(6)}%)` : '') +
        `  pack ${r.packMs.toFixed(0)} ms, unpack ${r.unpackMs.toFixed(1)} ms` + (r.error ? `  ${r.error}` : r.ok ? '' : `  first diff @${r.firstDiff}`));
    }
  }));
  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  await mkdir(path.join(PACK_ROOT, 'results'), { recursive: true });
  const csv = ['slug,original_bytes,packed_bytes,ratio,pack_ms,unpack_ms,ok', ...rows.map((r) =>
    [r.slug, r.original, r.packed, (r.original / r.packed).toFixed(4), r.packMs.toFixed(1), r.unpackMs.toFixed(2), r.ok].join(','))].join('\n') + '\n';
  await writeFile(path.join(PACK_ROOT, 'results', `${label}${bundlesDir !== 'bundles' ? `.${bundlesDir}` : ''}${only ? '.partial' : ''}.csv`), csv);

  const okRows = rows.filter((r) => r.ok);
  const totalIn = okRows.reduce((a, r) => a + r.original, 0);
  const totalOut = okRows.reduce((a, r) => a + r.packed, 0);
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
  console.log(`\n${label}: ${okRows.length}/${rows.length} round-trip ok, ${fmtMB(totalIn)} -> ${fmtMB(totalOut)} (${(totalIn / totalOut).toFixed(3)}x)` +
    `, median unpack ${med(okRows.map((r) => r.original / 1e6 / (r.unpackMs / 1e3))).toFixed(0)} MB/s, median pack ${med(okRows.map((r) => r.original / 1e6 / (r.packMs / 1e3))).toFixed(1)} MB/s` +
    `, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  const slugs = new Set(okRows.map((r) => r.slug));
  for (const [codec, byslug] of Object.entries(base).sort()) {
    const tot = okRows.reduce((a, r) => a + (byslug[r.slug] ?? NaN), 0);
    if (!Number.isFinite(tot)) continue;
    console.log(`  vs ${codec.padEnd(22)} ${fmtMB(tot).padStart(10)} (${(totalIn / tot).toFixed(3)}x): ${label} is ${((1 - totalOut / tot) * 100).toFixed(2).padStart(6)}% smaller` +
      `; wins on ${okRows.filter((r) => r.packed < byslug[r.slug]).length}/${[...slugs].filter((s) => byslug[s]).length} files`);
  }
  if (okRows.length !== rows.length) process.exitCode = 1;
}

if (isMainThread) await main();
