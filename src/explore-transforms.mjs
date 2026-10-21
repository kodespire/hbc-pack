#!/usr/bin/env node
// Measures candidate transforms on the table sections, with zstd-22 as the backend:
//   - function headers: raw vs byte-column transposition (12 columns)
//   - string table: raw vs columns (utf16 flags, lengths, offset deltas)
//   - identifier hashes: dropped (recomputable)
//   - string storage: zstd-22 alone vs zstd-22 with a dictionary trained on *other* apps' storage
// Prints totals over the chosen files (default: first 12 apps).
import { compressSync } from '@kodespire/zstd-js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as hbc from './hbc.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
import { CORPUS } from './corpus.mjs';
const Z = (b) => (b.length ? compressSync(b, { level: 22 }).length : 0);

function transpose(bytes, stride) {
  const n = bytes.length / stride;
  const out = new Uint8Array(bytes.length);
  for (let c = 0; c < stride; c++) for (let i = 0; i < n; i++) out[c * n + i] = bytes[i * stride + c];
  return out;
}

// Variable-length unsigned ints, LEB128-style.
function varints(values) {
  const out = [];
  for (let v of values) {
    v = v >>> 0;
    while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(v);
  }
  return Uint8Array.from(out);
}
const zigzag = (v) => (v << 1) ^ (v >> 31);

async function main() {
  const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const slugs = process.argv.slice(2).length ? process.argv.slice(2) : manifest.apps.slice(0, 12).map((a) => a.slug);
  const files = await Promise.all(slugs.map(async (s) => ({ slug: s, buf: new Uint8Array(await readFile(path.join(CORPUS, 'bundles', s, 'index.android.hbc'))) })));
  const T = {};
  const add = (k, v) => (T[k] = (T[k] ?? 0) + v);
  let monotonicRuns = 0, runs = 0;

  for (const { buf } of files) {
    const h = hbc.parseHeader(buf);
    const off = hbc.tableOffsets(h);
    const fh = buf.subarray(off.functionHeaders.start, off.functionHeaders.start + off.functionHeaders.size);
    add('funcHeaders raw', fh.length);
    add('funcHeaders zstd', Z(fh));
    add('funcHeaders transposed zstd', Z(transpose(fh, 12)));

    const kinds = hbc.parseStringKinds(buf, off, h);
    const strings = hbc.parseStringTable(buf, off, h);
    const st = buf.subarray(off.stringTable.start, off.stringTable.start + off.stringTable.size + off.overflowStringTable.size);
    add('stringTable raw', st.length);
    add('stringTable zstd', Z(st));
    // Columns: utf16 flag per string, length per string (varint), offset delta from previous
    // string in the same kind run (zigzag varint), overflow entries as varints.
    const flags = new Uint8Array(strings.length), lens = [], deltas = [];
    let si = 0;
    for (const run of kinds) {
      let prev = 0, mono = true;
      for (let k = 0; k < run.count; k++, si++) {
        const s = strings[si];
        flags[si] = s.utf16 ? 1 : 0;
        lens.push(s.length);
        deltas.push(zigzag(s.offset - prev));
        if (s.offset < prev) mono = false;
        prev = s.offset;
      }
      runs++; if (mono) monotonicRuns++;
    }
    add('stringTable columns zstd', Z(flags) + Z(varints(lens)) + Z(varints(deltas)));

    add('idHashes zstd', Z(buf.subarray(off.identifierHashes.start, off.identifierHashes.start + off.identifierHashes.size)));

    const storage = buf.subarray(off.stringStorage.start, off.stringStorage.start + off.stringStorage.size);
    add('storage raw', storage.length);
    add('storage zstd', Z(storage));
  }

  // Cross-app dictionary for string storage: train on the other files' storage, test on each.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hbcdict-'));
  try {
    for (let i = 0; i < files.length; i++) {
      const trainFiles = [];
      files.forEach((f, j) => {
        if (j === i) return;
        const h = hbc.parseHeader(f.buf); const off = hbc.tableOffsets(h);
        const p = path.join(tmp, `s${j}.bin`);
        writeFileSync(p, f.buf.subarray(off.stringStorage.start, off.stringStorage.start + off.stringStorage.size));
        trainFiles.push(p);
      });
      const dictPath = path.join(tmp, `dict${i}.zdict`);
      execFileSync('zstd', ['-q', '--train', '-B65536', '--maxdict=1048576', '-o', dictPath, ...trainFiles], { stdio: 'ignore' });
      const dict = new Uint8Array(await readFile(dictPath));
      const h = hbc.parseHeader(files[i].buf); const off = hbc.tableOffsets(h);
      const storage = files[i].buf.subarray(off.stringStorage.start, off.stringStorage.start + off.stringStorage.size);
      add('storage zstd+dict(1MB, other apps)', compressSync(storage, { level: 22, dictionary: dict }).length);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  console.log(`${files.length} files; string-kind runs with ascending offsets: ${monotonicRuns}/${runs}`);
  for (const [k, v] of Object.entries(T)) console.log(`${k.padEnd(40)} ${String(v).padStart(10)}`);
}

await main();
