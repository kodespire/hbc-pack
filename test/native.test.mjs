// The C decoder (native/hbcpack, built by native/build.sh) against the same fixtures. Skipped when
// the binary is not built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pack } from '../src/index.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bin = path.join(root, 'native/hbcpack');
const fixtures = path.join(root, 'fixtures');
const read = (name) => new Uint8Array(readFileSync(path.join(fixtures, name)));
const skip = existsSync(bin) ? false : 'native/hbcpack is not built (sh native/build.sh)';
const tmp = mkdtempSync(path.join(tmpdir(), 'hbcpack-test-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

function cli(...args) {
  return execFileSync(bin, args, { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
}
function unpackNative(input, opts = {}) {
  const inFile = path.join(tmp, 'in.hbcp'), outFile = path.join(tmp, 'out.hbc');
  writeFileSync(inFile, input);
  const args = ['unpack', inFile, outFile];
  if (opts.base) { const b = path.join(tmp, 'base.hbc'); writeFileSync(b, opts.base); args.push('--base', b); }
  cli(...args);
  return new Uint8Array(readFileSync(outFile));
}
function sizeNative(input, opts = {}) {
  const inFile = path.join(tmp, 'in.hbcp'); writeFileSync(inFile, input);
  const args = ['size', inFile];
  if (opts.base) { const b = path.join(tmp, 'base.hbc'); writeFileSync(b, opts.base); args.push('--base', b); }
  return Number(cli(...args).toString().trim());
}

for (const v of ['v89', 'v90', 'v94', 'v96', 'v98', 'v99']) {
  test(`${v}: C decoder decodes the committed containers byte-exactly`, { skip }, () => {
    const hbc = read(`hello.${v}.hbc`), next = read(`hello2.${v}.hbc`);
    assert.deepEqual(unpackNative(read(`hello.${v}.hbcp`)), hbc);
    assert.deepEqual(unpackNative(read(`hello2.${v}.hbcp`)), next);
    assert.deepEqual(unpackNative(read(`hello2.${v}.delta.hbcp`), { base: hbc }), next);
    assert.equal(sizeNative(read(`hello.${v}.hbcp`)), hbc.length);
    assert.equal(sizeNative(read(`hello2.${v}.delta.hbcp`), { base: hbc }), next.length);
  });
  test(`${v}: C decoder rejects a delta without its base`, { skip }, () => {
    const hbc = read(`hello.${v}.hbc`), next = read(`hello2.${v}.hbc`), delta = read(`hello2.${v}.delta.hbcp`);
    assert.throws(() => unpackNative(delta), /base file/);
    assert.throws(() => unpackNative(delta, { base: next }), /base file/);
  });
}

test('C decoder decodes what the JS encoder writes today (all container versions)', { skip }, () => {
  const hbc = read('hello.v98.hbc'), next = read('hello2.v98.hbc');
  assert.deepEqual(unpackNative(pack(hbc)), hbc);
  assert.deepEqual(unpackNative(pack(next, { base: hbc }), { base: hbc }), next);
  const junk = new Uint8Array(3000); for (let i = 0; i < junk.length; i++) junk[i] = (i * 31) & 0xff;
  const raw = pack(junk);
  assert.equal(raw[4], 4);
  assert.deepEqual(unpackNative(raw), junk);
  assert.equal(sizeNative(raw), junk.length);
});

test('C decoder fails cleanly on corrupt input', { skip }, () => {
  const packed = read('hello.v98.hbcp');
  assert.throws(() => unpackNative(packed.subarray(0, 40)), /truncated|malformed/);
  const bad = packed.slice(); bad[bad.length - 5] ^= 0xff;
  assert.throws(() => unpackNative(bad));
});
