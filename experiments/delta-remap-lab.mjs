// Delta updates, step two: string IDs shift between versions (adding one string renumbers every
// later one), so the str8/str16/str32 operand streams and the function-name column of the new
// version look unlike the old version's even where the code is unchanged. Here the new version's
// string IDs are rewritten into the OLD version's numbering wherever the string content exists in
// the old file (new strings get IDs past the old table), and the renumbered streams are patched
// against the old streams. The decoder would invert the mapping with the installed file's string
// table, which it has. Measures how much of the gap to JS deltas this closes.
//
//   node experiments/delta-remap-lab.mjs
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CORPUS } from '../src/corpus.mjs';
import * as hbc from '../src/hbc.mjs';
import { extractStreams } from '../src/codec.mjs';
import { encodeStream } from '../src/streams.mjs';
import { ByteReader, ByteWriter } from '../src/bits.mjs';

const PAIRS = path.join(CORPUS, 'bundles-pairs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'delta2-'));
function patch(oldBytes, newBytes) {
  const o = path.join(tmp, 'old.bin'), n = path.join(tmp, 'new.bin');
  writeFileSync(o, oldBytes); writeFileSync(n, newBytes);
  return execFileSync('zstd', ['-q', '-c', '--ultra', '-22', '--long=27', `--patch-from=${o}`, n], { maxBuffer: 1 << 30 }).length;
}
// string id -> content key for a file
function stringKeys(buf) {
  const h = hbc.parseHeader(buf); const off = hbc.tableOffsets(h);
  const strings = hbc.parseStringTable(buf, off, h);
  const storage = buf.subarray(off.stringStorage.start, off.stringStorage.start + off.stringStorage.size);
  return strings.map((s) => (s.utf16 ? 'u:' : 'a:') + Buffer.from(storage.subarray(s.offset, s.offset + s.length * (s.utf16 ? 2 : 1))).toString('latin1'));
}
// Mapping newId -> oldId (or a fresh id >= oldCount for strings the old file lacks).
function idMap(oldKeys, newKeys) {
  const oldByKey = new Map(oldKeys.map((k, i) => [k, i]));
  let fresh = oldKeys.length;
  return newKeys.map((k) => { const o = oldByKey.get(k); return o === undefined ? fresh++ : o; });
}
function remapStream(bytes, width, map) {
  const r = new ByteReader(bytes), w = new ByteWriter(bytes.length * 2);
  while (r.remaining) {
    const v = width === 1 ? r.u8() : width === 2 ? r.u16() : r.u32();
    const m = map[v] ?? v;
    w.u32(m); // widened to 4 bytes: remapped ids can exceed the original width
  }
  return w.finish();
}
function remapVarints(bytes, map) {
  const r = new ByteReader(bytes), w = new ByteWriter(bytes.length * 2);
  while (r.remaining) { const v = r.varint(); w.varint(map[v] ?? v); }
  return w.finish();
}
const mb = (n) => (n / 1e6).toFixed(3);
let totPlain = 0, totPatch = 0, totRemap = 0, totJsPatch = 0, totStrOnlyBefore = 0, totStrOnlyAfter = 0;
for (const slug of readdirSync(PAIRS).sort()) {
  const dir = path.join(PAIRS, slug);
  if (!existsSync(path.join(dir, 'old/index.android.hbc'))) continue;
  const oldHbc = new Uint8Array(readFileSync(path.join(dir, 'old/index.android.hbc'))), newHbc = new Uint8Array(readFileSync(path.join(dir, 'new/index.android.hbc')));
  const oldJs = readFileSync(path.join(dir, 'old/index.android.bundle')), newJs = readFileSync(path.join(dir, 'new/index.android.bundle'));
  const map = idMap(stringKeys(oldHbc), stringKeys(newHbc));
  const oldStreams = new Map(extractStreams(oldHbc).map((s) => [s.name, s.bytes]));
  const newStreams = extractStreams(newHbc);
  const widths = { str8: 1, str16: 2, str32: 4 };
  let plain = 0, patched = 0, remapped = 0, strBefore = 0, strAfter = 0;
  for (const s of newStreams) {
    const base = oldStreams.get(s.name);
    const p = encodeStream(s.bytes, { brotliVariants: false }).data.length;
    const pt = base?.length && s.bytes.length >= 64 ? Math.min(p, patch(base, s.bytes)) : p;
    plain += p; patched += pt;
    let rm = pt;
    if (s.name in widths || s.name === 'fh:functionName') {
      // Both sides in the old numbering: the old stream widened to u32 the same way, so the
      // patch sees identical ids for unchanged code.
      const nb = s.name === 'fh:functionName' ? remapVarints(s.bytes, map) : remapStream(s.bytes, widths[s.name], map);
      const ob = base ? (s.name === 'fh:functionName' ? remapVarints(base, []) : remapStream(base, widths[s.name], [])) : null;
      const rp = encodeStream(nb, { brotliVariants: false }).data.length;
      rm = ob?.length ? Math.min(rp, patch(ob, nb)) : rp;
      strBefore += pt; strAfter += rm;
    }
    remapped += rm;
  }
  const jsPatch = patch(oldJs, newJs);
  totPlain += plain; totPatch += patched; totRemap += remapped; totJsPatch += jsPatch; totStrOnlyBefore += strBefore; totStrOnlyAfter += strAfter;
  console.log(`${slug.padEnd(44)} no-base ${mb(plain)} | stream-patch ${mb(patched)} | +id remap ${mb(remapped)} | JS patch ${mb(jsPatch)}   (id streams: ${mb(strBefore)} -> ${mb(strAfter)})`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`\nTotals MB: hbc-pack no base ${mb(totPlain)} | per-stream patch ${mb(totPatch)} | per-stream patch + string-id remap ${mb(totRemap)} | JS whole-file patch ${mb(totJsPatch)}`);
console.log(`string-id streams alone: ${mb(totStrOnlyBefore)} -> ${mb(totStrOnlyAfter)} with the remap`);
