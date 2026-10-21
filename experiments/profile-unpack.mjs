// Profiles unpack alone: packs first, then starts the CPU profiler.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORPUS } from '../src/corpus.mjs';
import * as c from '../src/codec-v2.mjs';
const slug = process.argv[2] ?? 'jellify-music__app';
const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', slug, 'index.android.hbc')));
const packed = c.pack(buf, { brotliVariants: false });
c.unpack(packed);
const session = new Session(); session.connect();
await session.post('Profiler.enable'); await session.post('Profiler.start');
const t0 = performance.now(); for (let i = 0; i < 5; i++) c.unpack(packed); const dt = (performance.now() - t0) / 5;
const { profile } = await session.post('Profiler.stop');
console.log(`unpack ${dt.toFixed(0)} ms, ${(buf.length / 1e6 / (dt / 1e3)).toFixed(0)} MB/s`);
const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
for (let i = 0; i < profile.samples.length; i++) { const n = byId.get(profile.samples[i]); const k = `${n.callFrame.functionName || '(anon)'} ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0)); }
const tot = [...self.values()].reduce((a, b) => a + b, 0);
console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${(100 * v / tot).toFixed(1).padStart(5)}% ${k}`).join('\n'));
