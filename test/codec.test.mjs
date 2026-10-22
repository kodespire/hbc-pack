// JavaScript codec: round trips over the fixtures (HBC 94/96/98/99), delta containers, raw frames.
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pack, unpack, lastStats, SUPPORTED_VERSIONS } from '../src/index.js';

const fixtures = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../fixtures');
const read = (name) => new Uint8Array(readFileSync(path.join(fixtures, name)));
const meta = JSON.parse(readFileSync(path.join(fixtures, 'hello.json'), 'utf8'));
const VERSIONS = ['v89', 'v90', 'v94', 'v96', 'v98', 'v99'];

test('supported versions match the fixtures', () => {
  assert.deepEqual(SUPPORTED_VERSIONS, VERSIONS.map((v) => Number(v.slice(1))));
});

for (const v of VERSIONS) {
  const hbc = read(`hello.${v}.hbc`), next = read(`hello2.${v}.hbc`);
  test(`${v}: committed containers decode to the fixtures`, () => {
    assert.deepEqual(unpack(read(`hello.${v}.hbcp`)), hbc);
    assert.deepEqual(unpack(read(`hello2.${v}.hbcp`)), next);
    assert.deepEqual(unpack(read(`hello2.${v}.delta.hbcp`), { base: hbc }), next);
  });
  test(`${v}: pack is structural (container version 2) and round-trips`, () => {
    const packed = pack(hbc);
    assert.equal(packed[4], 2);
    assert.equal(hbc.length, meta[v].hbcBytes);
    assert.deepEqual(unpack(packed), hbc);
    assert.ok(packed.length < hbc.length);
    assert.ok(!lastStats()[0].fallback);
  });
  test(`${v}: delta container (version 3) round-trips and checks its base`, () => {
    const delta = pack(next, { base: hbc });
    assert.equal(delta[4], 3);
    assert.deepEqual(unpack(delta, { base: hbc }), next);
    assert.throws(() => unpack(delta, { base: next }), /does not match/);
    assert.throws(() => unpack(delta), /opts\.base/);
  });
  test(`${v}: a plain container ignores base`, () => {
    assert.deepEqual(unpack(read(`hello.${v}.hbcp`), { base: next }), hbc);
  });
}

test('raw frame (version 4): fallback for input the structural codec cannot handle', () => {
  const junk = new Uint8Array(5000); for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) & 0xff;
  const packed = pack(junk);
  assert.equal(packed[4], 4);
  assert.deepEqual(unpack(packed), junk);
  assert.match(lastStats()[0].fallback, /./);
  assert.throws(() => pack(junk, { fallback: false }));
});

test('raw frame on request, and on a truncated HBC file', () => {
  const hbc = read('hello.v98.hbc');
  const forced = pack(hbc, { raw: true });
  assert.equal(forced[4], 4);
  assert.deepEqual(unpack(forced), hbc);
  const cut = hbc.subarray(0, hbc.length - 100);
  const packed = pack(cut);
  assert.equal(packed[4], 4);
  assert.deepEqual(unpack(packed), cut);
});

test('corrupt containers throw instead of returning data', () => {
  const packed = read('hello.v98.hbcp');
  assert.throws(() => unpack(packed.subarray(0, 40)));
  const bad = packed.slice(); bad[4] = 9;
  assert.throws(() => unpack(bad), /container version/);
});
