#!/usr/bin/env node
// Early exploration, before the full format spec: parse the v98 header, cut the file into coarse
// regions from the header counts, and see how each region compresses on its own with zstd-22.
// Also tests two recomputability hypotheses: identifier hashes (Jenkins one-at-a-time without the
// final mix) and the SHA-1 footer.
//
//   node src/explore-sections.mjs [slug ...]
import { compressSync } from '@kodespire/zstd-js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
import { CORPUS } from './corpus.mjs';

export function parseHeader(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  const h = {
    magic: buf.subarray(0, 8), version: u32(8), sourceHash: buf.subarray(12, 32), fileLength: u32(32),
    globalCodeIndex: u32(36), functionCount: u32(40), stringKindCount: u32(44), identifierCount: u32(48),
    stringCount: u32(52), overflowStringCount: u32(56), stringStorageSize: u32(60), bigIntCount: u32(64),
    bigIntStorageSize: u32(68), regExpCount: u32(72), regExpStorageSize: u32(76), arrayBufferSize: u32(80),
    objKeyBufferSize: u32(84), objValueBufferSize: u32(88), stringSwitchImmCount: u32(92), segmentID: u32(96),
    cjsModuleCount: u32(100), functionSourceCount: u32(104), debugInfoOffset: u32(108), options: buf[112],
  };
  return h;
}

const align4 = (n) => (n + 3) & ~3;

// Coarse regions, in file order. The per-function region's internal layout comes later.
export function coarseRegions(buf) {
  const h = parseHeader(buf);
  const r = [];
  let o = 128;
  const push = (name, size) => { o = align4(o); r.push({ name, start: o, end: o + size }); o += size; };
  push('functionHeaders', 12 * h.functionCount);
  push('stringKinds', 4 * h.stringKindCount);
  push('identifierHashes', 4 * h.identifierCount);
  push('stringTable', 4 * h.stringCount);
  push('overflowStringTable', 8 * h.overflowStringCount);
  push('stringStorage', h.stringStorageSize);
  push('arrayBuffer', h.arrayBufferSize);
  push('objKeyBuffer', h.objKeyBufferSize);
  push('objValueBuffer', h.objValueBufferSize);
  push('bigIntTable', 8 * h.bigIntCount);
  push('bigIntStorage', h.bigIntStorageSize);
  push('regExpTable', 8 * h.regExpCount);
  push('regExpStorage', h.regExpStorageSize);
  push('cjsModuleTable', 8 * h.cjsModuleCount);
  push('functionSourceTable', 8 * h.functionSourceCount);
  o = align4(o);
  r.push({ name: 'functions+rest', start: o, end: h.debugInfoOffset });
  r.push({ name: 'debugInfo', start: h.debugInfoOffset, end: buf.length - 20 });
  r.push({ name: 'footer', start: buf.length - 20, end: buf.length });
  return { header: h, regions: r };
}

// Jenkins one-at-a-time, without the final avalanche (hypothesis for Hermes's identifier hash).
export function jenkinsOAATNoFinal(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h + str.charCodeAt(i)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  return h >>> 0;
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const slugs = process.argv.slice(2).length ? process.argv.slice(2) : manifest.apps.slice(0, 8).map((a) => a.slug);
  const totals = {};
  let wholeTotal = 0, splitTotal = 0;
  for (const slug of slugs) {
    const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', slug, 'index.android.hbc')));
    const { header: h, regions } = coarseRegions(buf);
    if (h.fileLength !== buf.length) console.log(`${slug}: header fileLength ${h.fileLength} != ${buf.length}`);
    // Footer check: SHA-1 of everything before it.
    const sha = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
    const footerOk = Buffer.compare(sha, Buffer.from(buf.subarray(buf.length - 20))) === 0;
    // Hash hypothesis: first identifier in string-table order with kind=identifier. Without the
    // kinds decoded yet, test the hypothesis against hermesc's dump instead (see check below).
    const whole = compressSync(buf, { level: 22 }).length;
    let split = 0;
    const parts = [];
    for (const r of regions) {
      const bytes = buf.subarray(r.start, r.end);
      const c = bytes.length ? compressSync(bytes, { level: 22 }).length : 0;
      split += c;
      parts.push(`${r.name} ${bytes.length}->${c}`);
      const t = (totals[r.name] ??= { raw: 0, z: 0 });
      t.raw += bytes.length; t.z += c;
    }
    wholeTotal += whole; splitTotal += split;
    console.log(`${slug}: ${buf.length} bytes, footer sha1 ${footerOk ? 'ok' : 'MISMATCH'}, whole zstd-22 ${whole}, split ${split} (${((split / whole - 1) * 100).toFixed(2)}%)`);
    console.log('   ' + parts.join(' | '));
  }
  console.log('\nTotals by region:');
  for (const [name, t] of Object.entries(totals)) {
    console.log(`  ${name.padEnd(22)} raw ${String(t.raw).padStart(10)}  zstd-22 ${String(t.z).padStart(9)}  ratio ${(t.raw / Math.max(t.z, 1)).toFixed(2).padStart(6)}x  share of compressed ${(100 * t.z / splitTotal).toFixed(1).padStart(5)}%`);
  }
  console.log(`whole ${wholeTotal}, split sum ${splitTotal}`);

  // Identifier hash hypothesis against hermesc's dump of one file.
  for (const [s, expect] of [['y', 0x0001e3e8], ['API', 0x53060600], ['type', 0x665957a7], ['$$typeof', 0xff4c300d], ['HermesInternal', 0x85bbf6f9]]) {
    const got = jenkinsOAATNoFinal(s);
    console.log(`hash(${JSON.stringify(s)}) = ${got.toString(16).padStart(8, '0')} expected ${expect.toString(16).padStart(8, '0')} ${got === expect ? 'OK' : 'no'}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
