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

  const meta = JSON.parse(new TextDecoder().decode(fixture('hello.json'))) as Record<string, { hbcBytes: number; packedBytes: number }>;
  for (const v of ['v96', 'v98', 'v99']) {
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
