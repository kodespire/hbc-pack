// Baseline codec: plain zstd level 22 through @kodespire/zstd-js. Sanity check for bench.mjs.
import { compressSync, decompressSync } from '@kodespire/zstd-js';
export function pack(bytes, opts = {}) { return compressSync(bytes, { level: opts.level ?? 22 }); }
export function unpack(bytes) { return decompressSync(bytes); }
