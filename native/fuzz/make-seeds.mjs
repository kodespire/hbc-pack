#!/usr/bin/env node
// Writes the fuzzer's seed corpus to native/fuzz/seeds: the fixture containers as committed, the
// same files with every stream stored (so mutations reach the rebuild logic instead of dying in
// zstd/brotli checksums), delta containers with their .base files, and one small corpus app.
//   node native/fuzz/make-seeds.mjs
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pack } from '../../src/codec.mjs';
import { CORPUS } from '../../src/corpus.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.join(root, 'native/fuzz/seeds');
mkdirSync(out, { recursive: true });
const put = (name, bytes) => writeFileSync(path.join(out, name), bytes);
let n = 0;
for (const v of ['v94', 'v96', 'v98', 'v99']) {
  const hbc = new Uint8Array(readFileSync(path.join(root, `fixtures/hello.${v}.hbc`)));
  const next = new Uint8Array(readFileSync(path.join(root, `fixtures/hello2.${v}.hbc`)));
  put(`hello.${v}.hbcp`, readFileSync(path.join(root, `fixtures/hello.${v}.hbcp`)));
  put(`hello.${v}.stored.hbcp`, pack(hbc, { backends: ['stored'] }));
  put(`hello2.${v}.delta.hbcp`, readFileSync(path.join(root, `fixtures/hello2.${v}.delta.hbcp`))); put(`hello2.${v}.delta.base`, hbc);
  put(`hello2.${v}.delta-stored.hbcp`, pack(next, { base: hbc, backends: ['stored'] })); put(`hello2.${v}.delta-stored.base`, hbc);
  n += 4;
}
// Smallest corpus app (HBC 98) and smallest version pair, if the corpus is present.
const bundles = path.join(CORPUS, 'bundles');
if (existsSync(bundles)) {
  const smallest = readdirSync(bundles).map((slug) => ({ slug, size: statSync(path.join(bundles, slug, 'index.android.hbc')).size })).sort((a, b) => a.size - b.size)[0];
  const hbc = new Uint8Array(readFileSync(path.join(bundles, smallest.slug, 'index.android.hbc')));
  put('corpus.hbcp', pack(hbc)); put('corpus.stored.hbcp', pack(hbc, { backends: ['stored'] })); n += 2;
  const pairs = path.join(CORPUS, 'bundles-pairs');
  if (existsSync(pairs)) {
    const p = readdirSync(pairs).filter((s) => existsSync(path.join(pairs, s, 'new/index.android.hbc')))
      .map((slug) => ({ slug, size: statSync(path.join(pairs, slug, 'new/index.android.hbc')).size })).sort((a, b) => a.size - b.size)[0];
    const base = new Uint8Array(readFileSync(path.join(pairs, p.slug, 'old/index.android.hbc'))), next = new Uint8Array(readFileSync(path.join(pairs, p.slug, 'new/index.android.hbc')));
    put('corpus-delta.hbcp', pack(next, { base })); put('corpus-delta.base', base);
    put('corpus-delta.stored.hbcp', pack(next, { base, backends: ['stored'] })); put('corpus-delta.stored.base', base); n += 2;
    console.log(`corpus seeds: ${smallest.slug} (${smallest.size} bytes), pair ${p.slug} (${p.size} bytes)`);
  }
}
console.log(`${n} seeds in ${out}`);
