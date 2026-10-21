// Node entry: the JavaScript codec (encoder and decoder). The React Native entry
// (src/react-native.js, "react-native" export condition) decodes through the native module.
export { pack, unpack, extractStreams, lastStats } from './codec.mjs';
export { PROFILES } from './profiles.mjs';

/** HBC bytecode versions this build can pack and unpack. */
export const SUPPORTED_VERSIONS = [96, 98, 99];
