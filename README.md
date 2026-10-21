# hbc-pack

A lossless compressor specialised for Hermes bytecode (`.hbc`, the format React Native apps ship
when Hermes is enabled). Research code, under active development.

The idea: parse the file, drop everything the decoder can recompute, split the rest into streams
that each hold one kind of data, and let a general LZ coder (zstd or brotli, both native and fast
to decode) do the entropy coding. Compression may be slow; decompression stays fast; output is
byte-identical to the input.

## Status (v1, 2026-10-21)

Measured on the [hermes-corpus](../hermes-corpus) benchmark: 104 open-source React Native apps,
201.8 MB of HBC version 98 (hermesc 250829098.0.9, React Native 0.84).

| compressor | total | ratio | decode |
|---|---:|---:|---:|
| **hbc-pack v1** | **54.96 MB** | **3.67×** | 62 MB/s (JS, includes SHA-1 and hash recomputation) |
| zpaq -m5 (context mixing) | 61.79 MB | 3.27× | 0.6 MB/s |
| xz -9e | 65.77 MB | 3.07× | 67 MB/s |
| brotli -q 11, 1 GiB window | 68.51 MB | 2.95× | 172 MB/s |
| zstd --ultra -22 | 73.62 MB | 2.74× | 256 MB/s |

hbc-pack wins on every one of the 104 files against every compressor above. Round trips are
verified byte-for-byte on all of them.

## What it does

Verified against the Hermes source (`ref/`, branch tag `hermes-v250829098.0.9`) and hermesc's
own disassembly of every corpus file:

- **Recomputed, not stored:** identifier hashes (Jenkins one-at-a-time without the final mix, 4
  bytes per identifier), the SHA-1 footer, every section offset, function bytecode offsets, the
  info-section pointers, the 40-byte large function headers (77% of functions have one because
  their name's string ID does not fit the 8-bit small-header field), overflow string entries,
  alignment padding, switch-table lengths.
- **Columns:** function headers become one stream per field; exception tables become delta
  columns; the string table becomes utf16 flags, lengths and offset deltas.
- **Instruction split:** the opcode byte stream, plus one stream per operand class and width
  (registers, string IDs, function IDs, jump offsets, immediates, doubles, cache indices).
- **Best backend per stream:** the encoder tries zstd-22 and brotli-11 for every stream and
  keeps the smaller; the stream header records the choice.

## Layout

| path | what |
|---|---|
| `src/hbc.mjs` | header and table parser |
| `src/funcs.mjs` | function region: small/large headers, deduplicated bodies, switch tables, exception tables |
| `src/isa.mjs` | instruction walker/emitter driven by `ref/opcodes.json` |
| `src/tables.mjs` | table-section streams and reconstruction |
| `src/streams.mjs` | stream container with zstd/brotli (and xz, measurement only) backends |
| `src/codec-v0.mjs`, `codec-v1.mjs`, `codec-v2.mjs` | codec versions; `pack(bytes)` / `unpack(bytes)` |
| `src/bench.mjs` | runs a codec over the corpus, checks round trips, compares with the baselines |
| `src/check-tables.mjs`, `src/check-funcs.mjs` | parser gates: parse and re-serialise every corpus file |
| `ref/` | HBC v98 format: copied Hermes sources (MIT, Meta Platforms), `SPEC.md`, `opcodes.json` |
| `research/` | literature review, compressibility floor measurements |
| `experiments/` | one-off measurements behind the design decisions |
| `NOTES.md` | working log with every measurement |

## Running

Needs Node 24 and the corpus checked out next to this repo (or `HBC_CORPUS=/path/to/hermes-corpus`).

```bash
npm ci
node src/check-funcs.mjs                 # parser gate over the corpus
node src/bench.mjs src/codec-v1.mjs      # full benchmark, results/codec-v1.csv
```

## License

MIT. Files under `ref/` are copied from facebook/hermes and keep their MIT license headers.
