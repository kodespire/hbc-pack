#!/usr/bin/env node
// Checks the table-level parser on every corpus file: header, kinds, string table consistency,
// identifier-hash recomputation, footer SHA-1. Prints one line per failure and a summary.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as hbc from './hbc.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
import { CORPUS } from './corpus.mjs';

const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
let ok = 0, bad = 0;
const stats = { identifiers: 0, strings: 0, utf16: 0, overflow: 0, hashBytes: 0, storageContiguous: 0, storageGaps: 0 };
for (const app of manifest.apps) {
  const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', app.slug, 'index.android.hbc')));
  try {
    const h = hbc.parseHeader(buf);
    const off = hbc.tableOffsets(h);
    const kinds = hbc.parseStringKinds(buf, off, h);
    const strings = hbc.parseStringTable(buf, off, h);
    const stored = hbc.storedIdentifierHashes(buf, off, h);
    const recomputed = hbc.recomputeIdentifierHashes(buf, off, h, kinds, strings);
    let mism = 0;
    for (let i = 0; i < stored.length; i++) if (stored[i] !== recomputed[i]) mism++;
    const sha = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
    const footerOk = Buffer.compare(sha, Buffer.from(buf.subarray(buf.length - 20))) === 0;
    // How are strings laid out in storage? Count entries whose offset == previous end.
    let prevEnd = 0, contiguous = 0, gaps = 0;
    for (const s of strings) {
      const bytes = s.length * (s.utf16 ? 2 : 1);
      if (s.offset === prevEnd) contiguous++; else gaps++;
      prevEnd = Math.max(prevEnd, s.offset + bytes);
      if (s.utf16) stats.utf16++;
      if (s.overflow >= 0) stats.overflow++;
    }
    stats.identifiers += h.identifierCount; stats.strings += h.stringCount; stats.hashBytes += 4 * h.identifierCount;
    stats.storageContiguous += contiguous; stats.storageGaps += gaps;
    if (mism || !footerOk || off.tablesEnd > h.debugInfoOffset) {
      bad++;
      console.log(`${app.slug}: hash mismatches ${mism}/${stored.length}, footer ${footerOk ? 'ok' : 'BAD'}, tablesEnd ${off.tablesEnd} debugInfo ${h.debugInfoOffset}`);
    } else ok++;
  } catch (err) {
    bad++;
    console.log(`${app.slug}: ${err.message}`);
  }
}
console.log(`${ok} ok, ${bad} bad`);
console.log(stats, `contiguous share ${(100 * stats.storageContiguous / (stats.storageContiguous + stats.storageGaps)).toFixed(1)}%`);
