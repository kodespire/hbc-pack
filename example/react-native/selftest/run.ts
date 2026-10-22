// Self-test of @kodespire/hbc-pack on a device or simulator. Each result is logged as one
// `HBCPACK_SELFTEST ...` line, which scripts/selftest.mjs reads from the device log, and the
// last line is `HBCPACK_SELFTEST DONE passed=N failed=M`.
import { HbcPackError, isNativeAvailable, nativeVersion, unpack, unpackSync, unpackedSize } from '@kodespire/hbc-pack';

// @ts-ignore generated plain JS
import fixtureData from './fixtures.generated';

type Log = (line: string) => void;

function fixture(name: string): Uint8Array {
  const binary = atob((fixtureData as Record<string, string>)[name]!);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert(actual instanceof Uint8Array, `${what}: not a Uint8Array`);
  assert(actual.length === expected.length, `${what}: length ${actual.length}, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++) if (actual[i] !== expected[i]) throw new Error(`${what}: differs at byte ${i}`);
}

export async function runSelfTest(log: Log): Promise<boolean> {
  let passed = 0, failed = 0;
  const test = async (name: string, fn: () => unknown | Promise<unknown>) => {
    try {
      await fn();
      passed++;
      log(`PASS ${name}`);
    } catch (error) {
      failed++;
      log(`FAIL ${name}: ${String(error instanceof Error ? error.message : error)}`);
    }
  };

  log(`native module ${isNativeAvailable ? `available, version ${nativeVersion}` : 'NOT available'}`);
  await test('native module is linked', () => assert(isNativeAvailable, 'TurboModule KodespireHbcPack not found'));

  type Meta = { hbcBytes: number; packedBytes: number; next: { hbcBytes: number; deltaBytes: number } };
  const meta = JSON.parse(new TextDecoder().decode(fixture('hello.json'))) as Record<string, Meta>;
  const expectCode = async (what: string, code: string, fn: () => unknown | Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      assert(error instanceof HbcPackError, `${what}: threw ${String(error)}`);
      assert(error.code === code, `${what}: code ${String(error.code)}, expected ${code}`);
      return;
    }
    throw new Error(`${what}: did not throw`);
  };
  for (const v of ['v94', 'v96', 'v98', 'v99']) {
    const packed = fixture(`hello.${v}.hbcp`);
    const expected = fixture(`hello.${v}.hbc`);
    await test(`${v}: unpackedSize`, () => assert(unpackedSize(packed) === meta[v]!.hbcBytes, `got ${unpackedSize(packed)}`));
    await test(`${v}: unpackSync is byte-exact`, () => assertBytes(unpackSync(packed), expected, 'unpackSync'));
    await test(`${v}: unpack (async) is byte-exact`, async () => assertBytes(await unpack(packed), expected, 'unpack'));
    await test(`${v}: unpackSync accepts an ArrayBuffer`, () => assertBytes(unpackSync(packed.slice().buffer), expected, 'unpackSync(ArrayBuffer)'));
    await test(`${v}: corrupt input throws HbcPackError`, () => {
      const bad = packed.slice();
      bad[bad.length - 5] ^= 0xff;
      try {
        unpackSync(bad);
      } catch (error) {
        assert(error instanceof HbcPackError, `threw ${String(error)}`);
        assert(typeof error.code === 'string' && error.code.startsWith('ERR_HBCPACK_'), `code ${String(error.code)}`);
        return;
      }
      throw new Error('did not throw');
    });
    await test(`${v}: truncated input rejects (async)`, async () => {
      try {
        await unpack(packed.subarray(0, 40));
      } catch (error) {
        assert(error instanceof HbcPackError, `rejected with ${String(error)}`);
        return;
      }
      throw new Error('did not reject');
    });
    // Delta container: hello2 (the next release) packed against hello (the installed file).
    const delta = fixture(`hello2.${v}.delta.hbcp`);
    const next = fixture(`hello2.${v}.hbc`);
    await test(`${v}: delta unpackedSize with base`, () => assert(unpackedSize(delta, { base: expected }) === meta[v]!.next.hbcBytes, `got ${unpackedSize(delta, { base: expected })}`));
    await test(`${v}: delta unpackSync with base is byte-exact`, () => assertBytes(unpackSync(delta, { base: expected }), next, 'delta unpackSync'));
    await test(`${v}: delta unpack (async) with base is byte-exact`, async () => assertBytes(await unpack(delta, { base: expected }), next, 'delta unpack'));
    await test(`${v}: delta without base throws ERR_HBCPACK_BASE`, () => expectCode('no base', 'ERR_HBCPACK_BASE', () => unpackSync(delta)));
    await test(`${v}: delta with the wrong base rejects ERR_HBCPACK_BASE`, () => expectCode('wrong base', 'ERR_HBCPACK_BASE', () => unpack(delta, { base: next })));
    await test(`${v}: plain container ignores base`, () => assertBytes(unpackSync(fixture(`hello2.${v}.hbcp`), { base: expected }), next, 'plain with base'));
    // Raw frame (container version 4): the encoder's fallback, the whole file as one stream.
    const raw = fixture(`hello2.${v}.raw.hbcp`);
    await test(`${v}: raw frame unpackedSize`, () => assert(unpackedSize(raw) === meta[v]!.next.hbcBytes, `got ${unpackedSize(raw)}`));
    await test(`${v}: raw frame decodes (sync and async)`, async () => { assertBytes(unpackSync(raw), next, 'raw sync'); assertBytes(await unpack(raw), next, 'raw async'); });
  }
  await test('not a container throws', () => {
    try {
      unpackSync(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    } catch (error) {
      assert(error instanceof HbcPackError && error.code === 'ERR_HBCPACK_FORMAT', `threw ${String(error)}`);
      return;
    }
    throw new Error('did not throw');
  });
  await test('many concurrent async decodes', async () => {
    const packed = fixture('hello.v98.hbcp'), expected = fixture('hello.v98.hbc');
    const results = await Promise.all(Array.from({ length: 50 }, () => unpack(packed)));
    for (const r of results) assertBytes(r, expected, 'concurrent');
  });

  log(`DONE passed=${passed} failed=${failed}`);
  return failed === 0;
}
