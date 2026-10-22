#!/usr/bin/env node
// Packs every corpus file with a codec into <outDir>/<slug>.hbcp (for testing other decoders).
//   node src/pack-all.mjs [codec.mjs] [outDir] [optsJSON] [--dir bundles96]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CORPUS } from './corpus.mjs';
const argv = process.argv.slice(2);
const dirIdx = argv.indexOf('--dir');
const BUNDLES = dirIdx >= 0 ? argv.splice(dirIdx, 2)[1] : 'bundles';
const codec = await import(path.resolve(argv[0] ?? 'src/codec.mjs'));
const outDir = path.resolve(argv[1] ?? 'results/packed');
const opts = JSON.parse(argv[2] ?? '{}');
await mkdir(outDir, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
const fallbacks = [];
for (const app of manifest.apps) {
  const buf = new Uint8Array(await readFile(path.join(CORPUS, BUNDLES, app.slug, 'index.android.hbc')));
  await writeFile(path.join(outDir, `${app.slug}.hbcp`), codec.pack(buf, opts));
  const stats = codec.lastStats?.();
  if (stats?.[0]?.fallback) fallbacks.push(`${app.slug}: ${stats[0].fallback}`);
  process.stderr.write('.');
}
console.log(`\n${manifest.apps.length} files packed into ${outDir}${fallbacks.length ? `; ${fallbacks.length} fell back to a raw frame:\n  ${fallbacks.join('\n  ')}` : ', none fell back to a raw frame'}`);
