#!/usr/bin/env node
// Packs every corpus file with a codec into results/packed/<slug>.hbcp (for testing other decoders).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CORPUS } from './corpus.mjs';
const codec = await import(path.resolve(process.argv[2] ?? 'src/codec-v3.mjs'));
const outDir = path.resolve(process.argv[3] ?? 'results/packed');
const opts = JSON.parse(process.argv[4] ?? '{}');
await mkdir(outDir, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
for (const app of manifest.apps) {
  const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', app.slug, 'index.android.hbc')));
  await writeFile(path.join(outDir, `${app.slug}.hbcp`), codec.pack(buf, opts));
  process.stderr.write('.');
}
console.log(`\n${manifest.apps.length} files packed into ${outDir}`);
