// Where do the bytes of a delta container go? Packs each version pair with and without its base
// and sums the stored size per stream, to see which streams still resist the base dictionaries.
//   node experiments/delta-streams-lab.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CORPUS } from '../src/corpus.mjs';
import { pack, lastStats } from '../src/codec.mjs';

const PAIRS = path.join(CORPUS, 'bundles-pairs');
const plain = new Map(), delta = new Map(), raw = new Map();
const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
let pairs = 0, totPlain = 0, totDelta = 0;
for (const slug of readdirSync(PAIRS).sort()) {
  const dir = path.join(PAIRS, slug);
  if (!existsSync(path.join(dir, 'new/index.android.hbc'))) continue;
  const base = new Uint8Array(readFileSync(path.join(dir, 'old/index.android.hbc'))), next = new Uint8Array(readFileSync(path.join(dir, 'new/index.android.hbc')));
  totPlain += pack(next, { verify: false }).length; for (const r of lastStats()) { add(plain, r.name, r.stored); add(raw, r.name, r.raw); }
  totDelta += pack(next, { base, verify: false }).length; for (const r of lastStats()) add(delta, r.name, r.stored);
  pairs++; process.stderr.write('.');
}
const mb = (n) => (n / 1e6).toFixed(3);
const rows = [...delta.keys()].map((k) => ({ name: k, raw: raw.get(k), plain: plain.get(k), delta: delta.get(k) })).sort((a, b) => b.delta - a.delta);
console.log(`\n${pairs} pairs. plain ${mb(totPlain)} MB, delta ${mb(totDelta)} MB\n`);
console.log('| stream | raw | plain | delta | share of delta | delta/plain |'); console.log('|---|---:|---:|---:|---:|---:|');
for (const r of rows) if (r.delta > 5000) console.log(`| ${r.name} | ${mb(r.raw)} | ${mb(r.plain)} | ${mb(r.delta)} | ${(100 * r.delta / totDelta).toFixed(1)}% | ${(r.delta / r.plain).toFixed(2)} |`);
