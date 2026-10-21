// React Native entry (the "react-native" export condition, which Metro uses on iOS and
// Android): the C++ TurboModule in cpp/ over native/hbcpack.c. Decoding only; packing is a
// build-time job for Node (src/index.js).
import { TurboModuleRegistry } from 'react-native';

const native = TurboModuleRegistry?.get('KodespireHbcPack');

export class HbcPackError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HbcPackError';
    this.code = code;
  }
}

function requireNative() {
  if (!native) {
    throw new HbcPackError(
      '@kodespire/hbc-pack: the native module is not linked. Rebuild the app (pod install / gradle) after installing the package.',
      'ERR_HBCPACK_NOT_LINKED',
    );
  }
  return native;
}

const CODES = ['OK', 'ERR_HBCPACK_FORMAT', 'ERR_HBCPACK_UNSUPPORTED', 'ERR_HBCPACK_TRUNCATED', 'ERR_HBCPACK_BACKEND', 'ERR_HBCPACK_DICT', 'ERR_HBCPACK_ALLOC', 'ERR_HBCPACK_LIMIT'];

function wrap(error) {
  if (error && typeof error.hbcpackCode === 'number') return new HbcPackError(error.message, CODES[error.hbcpackCode] ?? 'ERR_HBCPACK_UNKNOWN');
  return error;
}

function toBytes(input, name) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError(`${name} must be a Uint8Array or ArrayBuffer`);
}

// dictionaries: { [streamName]: Uint8Array } or undefined.
function dictArgs(dictionaries) {
  if (!dictionaries) return [null, null];
  const names = Object.keys(dictionaries);
  return [names, names.map((n) => toBytes(dictionaries[n], `dictionaries.${n}`))];
}

/** Decodes an hbc-pack container to the original .hbc bytes, synchronously on the JS thread. */
export function unpackSync(packed, options = {}) {
  const m = requireNative();
  const [names, data] = dictArgs(options.dictionaries);
  try {
    return new Uint8Array(m.unpackSync(toBytes(packed, 'packed'), names, data));
  } catch (error) {
    throw wrap(error);
  }
}

/** Decodes on a worker thread; resolves with the original .hbc bytes. */
export async function unpack(packed, options = {}) {
  const m = requireNative();
  const [names, data] = dictArgs(options.dictionaries);
  try {
    return new Uint8Array(await m.unpack(toBytes(packed, 'packed'), names, data));
  } catch (error) {
    throw wrap(error);
  }
}

/** Size of the decoded file, read from the container header. */
export function unpackedSize(packed) {
  try {
    return requireNative().unpackedSize(toBytes(packed, 'packed'));
  } catch (error) {
    throw wrap(error);
  }
}

/** Version of the native decoder, or null when it is not linked. */
export const nativeVersion = native ? native.version() : null;
export const isNativeAvailable = native != null;
