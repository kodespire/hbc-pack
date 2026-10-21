// Container for a set of named byte streams, each compressed with the backend that makes it
// smallest. The encoder may be slow (it tries every allowed backend); the decoder only runs the
// chosen one. Format:
//   "HBCP" u8 version u8 streamCount
//   per stream: u8 backend, varint rawLength, varint storedLength, bytes
//
// Backends: 0 stored, 1 zstd (level 22), 2 brotli (q11, lgwin 24), 3 xz (CLI; measurement only,
// not a fast decoder).
import { compressSync as zstdCompress, decompressSync as zstdDecompress } from '@kodespire/zstd-js';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { ByteReader, ByteWriter } from './bits.mjs';

export const BACKENDS = {
  stored: 0, zstd: 1, brotli: 2, xz: 3, 'zstd-dict': 4,
};
const NAMES = Object.fromEntries(Object.entries(BACKENDS).map(([k, v]) => [v, k]));

const encoders = {
  [BACKENDS.stored]: (b) => b,
  [BACKENDS.zstd]: (b, o) => zstdCompress(b, { level: o.zstdLevel ?? 22 }),
  // Three parameter sets, smallest wins; the brotli stream describes its own parameters, so the
  // decoder does not care which one was used.
  [BACKENDS.brotli]: (b, o) => {
    const C = zlib.constants;
    const base = { [C.BROTLI_PARAM_QUALITY]: 11, [C.BROTLI_PARAM_LGWIN]: o.brotliLgwin ?? 24, [C.BROTLI_PARAM_SIZE_HINT]: b.length };
    const variants = o.brotliVariants === false ? [{}] : [{}, { [C.BROTLI_PARAM_LGBLOCK]: 24 }, { [C.BROTLI_PARAM_NPOSTFIX]: 3, [C.BROTLI_PARAM_NDIRECT]: 120 }];
    let best = null;
    for (const extra of variants) {
      const out = new Uint8Array(zlib.brotliCompressSync(b, { params: { ...base, ...extra } }));
      if (!best || out.length < best.length) best = out;
    }
    return best;
  },
  [BACKENDS.xz]: (b) => new Uint8Array(execFileSync('xz', ['-9e', '--format=raw', '-c'], { input: b, maxBuffer: 1 << 30 })),
  // Needs opts.dict (the stream's dictionary); the decoder gets the same one from opts.dicts.
  [BACKENDS['zstd-dict']]: (b, o) => (o.dict ? zstdCompress(b, { level: o.zstdLevel ?? 22, dictionary: o.dict }) : null),
};
const decoders = {
  [BACKENDS.stored]: (b) => b,
  [BACKENDS.zstd]: (b) => zstdDecompress(b),
  [BACKENDS.brotli]: (b) => new Uint8Array(zlib.brotliDecompressSync(b)),
  [BACKENDS.xz]: (b) => new Uint8Array(execFileSync('xz', ['-d', '--format=raw', '-c'], { input: b, maxBuffer: 1 << 30 })),
  [BACKENDS['zstd-dict']]: (b, o) => zstdDecompress(b, { dictionary: o.dict }),
};

// opts.backends: list of backend names to try (default zstd + brotli). Streams shorter than
// opts.minCompress bytes are stored.
export function encodeStream(bytes, opts = {}) {
  const allowed = (opts.backends ?? ['zstd', 'brotli']).map((n) => BACKENDS[n]);
  let best = { backend: BACKENDS.stored, data: bytes };
  if (bytes.length >= (opts.minCompress ?? 32)) {
    for (const be of allowed) {
      const data = encoders[be](bytes, opts);
      if (data && data.length < best.data.length) best = { backend: be, data };
    }
  }
  return best;
}

export function packStreams(streams, opts = {}) {
  const w = new ByteWriter(1 << 16);
  w.bytes(Buffer.from('HBCP'));
  w.u8(1);
  w.u8(streams.length);
  const report = [];
  for (const s of streams) {
    const { backend, data } = encodeStream(s.bytes, { ...opts, ...(s.opts ?? {}), dict: opts.dicts?.[s.name] });
    w.u8(backend); w.varint(s.bytes.length); w.varint(data.length); w.bytes(data);
    if (backend === BACKENDS['zstd-dict']) w.bytes(Buffer.from(s.name.padEnd(16, '\0').slice(0, 16)));
    report.push({ name: s.name, raw: s.bytes.length, stored: data.length, backend: NAMES[backend] });
  }
  return { bytes: w.finish(), report };
}

export function unpackStreams(bytes, opts = {}) {
  const r = new ByteReader(bytes);
  if (Buffer.from(r.bytes(4)).toString('latin1') !== 'HBCP') throw new Error('not an HBCP container');
  const version = r.u8();
  if (version !== 1) throw new Error(`container version ${version}`);
  const count = r.u8();
  const out = [];
  for (let i = 0; i < count; i++) {
    const backend = r.u8(); const rawLen = r.varint(); const storedLen = r.varint();
    const data = r.bytes(storedLen);
    let dict;
    if (backend === BACKENDS['zstd-dict']) {
      const name = Buffer.from(r.bytes(16)).toString('latin1').replace(/\0+$/, '');
      dict = opts.dicts?.[name];
      if (!dict) throw new Error(`stream ${name} needs a dictionary`);
    }
    const raw = decoders[backend](data, { dict });
    if (raw.length !== rawLen) throw new Error(`stream ${i}: ${raw.length} != ${rawLen}`);
    out.push(raw);
  }
  return out;
}
