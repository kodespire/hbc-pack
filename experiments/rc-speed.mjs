import { readFile } from 'node:fs/promises';
import { CORPUS } from '../src/corpus.mjs';
import { performance } from 'node:perf_hooks';
import { compressSync } from '@kodespire/zstd-js';
import * as hbc from '../src/hbc.mjs';
import { encodeOrderK, decodeOrderK } from '../src/rc.mjs';
const buf = new Uint8Array(await readFile(CORPUS + '/bundles/mcnamee__react-native-starter-kit/index.android.hbc'));
const h = hbc.parseHeader(buf); const off = hbc.tableOffsets(h);
const funcs = buf.subarray(off.tablesEnd, h.debugInfoOffset);
console.log('funcs region', funcs.length, 'zstd-22', compressSync(funcs, { level: 22 }).length);
for (const [k, bits] of [[1, 8], [2, 16]]) {
  const t0 = performance.now(); const enc = encodeOrderK(funcs, k, bits); const t1 = performance.now();
  const dec = decodeOrderK(enc, funcs.length, k, bits); const t2 = performance.now();
  const ok = Buffer.compare(Buffer.from(dec), Buffer.from(funcs)) === 0;
  console.log(`order-${k}: ${enc.length} bytes (${(funcs.length / enc.length).toFixed(3)}x) enc ${(funcs.length / 1e6 / ((t1 - t0) / 1e3)).toFixed(1)} MB/s dec ${(funcs.length / 1e6 / ((t2 - t1) / 1e3)).toFixed(1)} MB/s roundtrip ${ok}`);
}
