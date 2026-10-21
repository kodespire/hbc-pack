#!/usr/bin/env node
// Gate for the function-region parser: parse + re-serialise every corpus file, compare bytes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as hbc from './hbc.mjs';
import * as funcs from './funcs.mjs';
import * as isa from './isa.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
import { CORPUS } from './corpus.mjs';
const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
const only = process.argv.slice(2);
let ok = 0, bad = 0;
const S = { functions: 0, bodies: 0, reused: 0, withInfo: 0, large: 0, exceptions: 0, debug: 0, switchTables: 0, instructions: 0, opcodeBytes: 0, tableBytes: 0, padBytes: 0, nonzeroPad: 0, largePadNonzero: 0 };
const opHist = new Map();
for (const app of manifest.apps) {
  if (only.length && !only.includes(app.slug)) continue;
  const buf = new Uint8Array(await readFile(path.join(CORPUS, 'bundles', app.slug, 'index.android.hbc')));
  try {
    const h = hbc.parseHeader(buf);
    const off = hbc.tableOffsets(h);
    const parsed = funcs.parseFunctionRegion(buf, off.functionHeaders.start, h.functionCount, off.tablesEnd);
    if (align4(parsed.infoEnd) !== h.debugInfoOffset && parsed.infoEnd !== h.debugInfoOffset) throw new Error(`info ends at ${parsed.infoEnd}, debug info at ${h.debugInfoOffset}`);
    const out = new Uint8Array(buf.length);
    out.set(buf); // start from the original, then overwrite the region and headers
    out.fill(0, off.functionHeaders.start, off.functionHeaders.start + off.functionHeaders.size);
    out.fill(0, off.tablesEnd, h.debugInfoOffset);
    const end = funcs.writeFunctionRegion(parsed, out, off.functionHeaders.start, off.tablesEnd);
    let firstDiff = -1;
    for (let p = 0; p < buf.length; p++) if (out[p] !== buf[p]) { firstDiff = p; break; }
    if (firstDiff >= 0) throw new Error(`re-serialisation differs at ${firstDiff} (region ${off.tablesEnd}..${h.debugInfoOffset}, wrote to ${end})`);
    ok++;
    S.functions += parsed.functions.length; S.bodies += parsed.bodies.length;
    S.reused += parsed.functions.filter((f) => f.reuse).length;
    S.withInfo += parsed.functions.filter((f) => f.infoOffset >= 0).length;
    S.exceptions += parsed.functions.reduce((a, f) => a + (f.exceptions?.length ?? 0), 0);
    S.debug += parsed.functions.filter((f) => f.debugOffset !== null && f.debugOffset !== undefined).length;
    S.switchTables += parsed.bodies.filter((b) => b.tableBytes).length;
    S.tableBytes += parsed.bodies.reduce((a, b) => a + b.tableBytes, 0);
    S.padBytes += parsed.padBytes.length; S.nonzeroPad += parsed.padBytes.filter((x) => x).length;
    S.largePadNonzero += parsed.functions.filter((f) => f.large && (f.large.pad[0] | f.large.pad[1] | f.large.pad[2])).length;
    for (const b of parsed.bodies) { S.instructions += b.instructions.length; S.opcodeBytes += b.size; for (const ins of b.instructions) opHist.set(ins.opcode, (opHist.get(ins.opcode) ?? 0) + 1); }
  } catch (err) {
    bad++;
    console.log(`${app.slug}: ${err.message}`);
  }
}
function align4(n) { return (n + 3) & ~3; }
console.log(`${ok} ok, ${bad} bad`);
console.log(S);
const ops = isa.loadOpcodes();
const top = [...opHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log('top opcodes:', top.map(([o, n]) => `${ops[o].name}:${n}`).join(' '));
