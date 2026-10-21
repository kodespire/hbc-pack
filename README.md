# hbc-pack

A lossless compressor specialised for Hermes bytecode (`.hbc`), the format React Native apps ship
when Hermes is enabled, and the thing an over-the-air update actually downloads.

It parses the file, drops everything a decoder can recompute, splits the rest into streams that
each hold one kind of data, and lets a native LZ coder (zstd or brotli) do the entropy coding.
Compression is slow (it tries several coders per stream); decompression is a parse-free rebuild
plus native decoding; the output is byte-identical to the input.

On a corpus of 104 real React Native apps it compresses **3.82×**, which is **14% smaller than
zpaq -m5** (the strongest general-purpose compressor tried, which decodes at 0.6 MB/s), 20% smaller
than xz, 23% smaller than brotli-11 and 28% smaller than zstd-22, winning on every single file.
With shared dictionaries it reaches **4.7–5.9×** on apps it was not trained on.

Research code. The format is HBC version 98 (hermesc 250829098.0.9, React Native 0.84); other
versions need their own opcode table and layout checks (see Limitations).

---

## Results

### Single file, no shared state

Corpus: `hermes-corpus` (a local-only sibling folder, not published: it contains third-party app
bundles), 104 open-source
React Native apps built with one pinned hermesc using RN's Android release flags
(`-O -output-source-map`), 201.83 MB of `.hbc` in total, 0.75–8.9 MB per file. Every row below
was measured on the same 104 files; compressor outputs were decompressed and compared byte for byte.

| compressor | total | ratio | vs hbc-pack | files hbc-pack wins | decode speed |
|---|---:|---:|---:|---:|---:|
| **hbc-pack v3** | **52.88 MB** | **3.817×** | – | – | 86 MB/s median (JS), 27–133 |
| zpaq -m5 (context mixing) | 61.79 MB | 3.266× | +16.9% | 104/104 | 0.6 MB/s |
| xz -9e (LZMA2) | 65.77 MB | 3.069× | +24.4% | 104/104 | 67 MB/s |
| xz -9e, best lc/lp/pb (1,0,2) | 65.72 MB | 3.071× | +24.3% | 104/104 | 72 MB/s |
| brotli -q 11, 1 GiB window | 68.51 MB | 2.946× | +29.6% | 104/104 | 172 MB/s |
| brotli -q 11 (`@kodespire/brotli-js`) | 68.52 MB | 2.945× | +29.6% | 104/104 | 351 MB/s |
| zstd --ultra -22 | 73.62 MB | 2.742× | +39.2% | 104/104 | 256 MB/s |
| zstd -19 (`@kodespire/zstd-js`) | 73.62 MB | 2.741× | +39.2% | 104/104 | 1.2 GB/s |
| bzip3 -b 511 | 80.44 MB | 2.509× | +52.1% | 104/104 | 7 MB/s |
| gzip -9 (`@kodespire/gzip-js`) | 87.67 MB | 2.302× | +65.8% | 104/104 | 401 MB/s |
| bzip2 -9 | 88.41 MB | 2.283× | +67.2% | 104/104 | 47 MB/s |
| lz4 HC 12 (`@kodespire/lz4-js`) | 106.93 MB | 1.887× | +102% | 104/104 | 2.7 GB/s |
| snappy (`@kodespire/snappy-js`) | 130.73 MB | 1.544× | +147% | 104/104 | 1.9 GB/s |

Per-file ratio: min 3.31×, median 3.73×, max 4.76× (Jellify, the largest app: 8.92 MB → 2.13 MB,
decoded in 102 ms). The whole corpus decodes in 2.5 s and encodes in 12 minutes (0.3 MB/s: the
encoder compresses every stream with zstd-22 and three brotli-11 parameter sets and keeps the
smallest).

Decode speeds for the general compressors are from `research/floor.md` (CLI, wall clock, single
run) and from the corpus benchmark (the `@kodespire` packages, in-process, median of repeated
runs). hbc-pack's decode speed is JavaScript: about 80% of the time is the JS rebuild (instruction
re-emission, header reconstruction, hashing), 20% is native zstd/brotli decoding, so a native port
of the rebuild would be several times faster.

### With shared dictionaries (over-the-air update scenario)

An OTA pipeline can ship a dictionary inside the app and reuse it for every update. hbc-pack
trains one zstd dictionary per stream (`zstd --train`), splitting a byte budget across streams in
proportion to their compressed size. Trained on 63 apps, tested on the other 41 (67.84 MB), with
the split made by a hash of the GitHub owner so no author's apps sit on both sides. Dictionary
bytes are not counted in the sizes.

| compressor | total on the 41 held-out apps | ratio | vs hbc-pack (same budget) |
|---|---:|---:|---:|
| **hbc-pack v3 + 4 MiB of dictionaries** (3.87 MB) | **11.41 MB** | **5.945×** | – |
| **hbc-pack v3 + 1 MiB of dictionaries** (986 KB, 17 streams) | **14.40 MB** | **4.709×** | – |
| hbc-pack v3, no dictionary | 17.73 MB | 3.827× | +23.1% / +55.4% |
| zpaq -m5 | 20.86 MB | 3.252× | +44.9% / +82.8% |
| zstd -19 + 1 MB dictionary (`zstd --train` on the whole files) | 21.21 MB | 3.198× | +47.3% |
| xz -9e | 22.11 MB | 3.068× | +53.5% |
| brotli -q 11 | 22.97 MB | 2.954× | +59.5% |
| zstd -19 | 24.73 MB | 2.743× | +71.7% |

Decode speed is unchanged (129–134 MB/s median on these files). In practice dictionaries should
be trained per React Native version; this corpus spans RN 0.61–0.87, so the numbers above are a
pessimistic mix.

### Version history

| version | total (104 files) | ratio | what changed |
|---|---:|---:|---|
| zstd-22 on the raw files | 73.62 MB | 2.742× | baseline |
| v0 | 63.83 MB | 3.162× | tables only: identifier hashes dropped, string table as columns, headers byte-transposed, function region raw |
| v1 | 54.96 MB | 3.672× | function region parsed: header columns, derived offsets and large headers, exception deltas, instructions split into opcode + 16 operand streams |
| v2 | 54.69 MB | 3.690× | string-table deltas relative to the previous string's end; three brotli parameter sets per stream |
| **v3** | **52.88 MB** | **3.817×** | property-cache indices coded as residuals from the per-function first-appearance rank |
| v4 (not adopted) | 52.80 MB (est.) | 3.82× | typed literal buffers: −0.15%, slower decode |

---

## How it works

### 1. Parse

`src/hbc.mjs` reads the 128-byte header and locates the fifteen table sections. `src/funcs.mjs`
parses the function region: 12-byte small function headers, the 40-byte large headers in the
info section, the bytecode bodies (walked instruction by instruction with `ref/opcodes.json`),
inline switch tables, exception tables and debug offsets. `src/check-funcs.mjs` re-serialises
every corpus file from the parse and compares bytes; it is the gate every change must pass.

### 2. Recompute instead of store

| recomputed | how | raw bytes saved on the corpus |
|---|---|---:|
| identifier hashes | Jenkins one-at-a-time over the string's code units, without the final mix; applied to the strings the kind table marks as identifiers | 3.53 MB (883,224 × 4), about 4% of zstd output |
| large function headers | 630,196 functions (77.5%) carry a 40-byte copy of their header because the function-name string ID does not fit the small header's 8-bit field (or `numCacheNewObject` > 1); rebuilt from the columns | 25.2 MB |
| bytecode offsets, info pointers, overflow string entries, section offsets, alignment padding | prefix sums over the parsed structure; hermesc deduplicates identical bodies (138,349 of 812,810 functions reuse one), coded as a back-reference | 13 MB of fields |
| switch-table lengths | `4·(max−min+1)` for `UIntSwitchImm`, `8·size` for `StringSwitchImm` | – |
| SHA-1 footer | hash of everything before it | 2 KB |
| property-cache indices | within a function each distinct property gets one cache slot, reads and writes separately, in first-appearance order 87–99% of the time; the index is coded as the residual from that rank (zero 90% of the time) | u8 operand stream −40% |

### 3. Split into streams

59 streams, each compressed on its own. Share of the compressed output (12 mid-size files,
v3, full table in `results/v3-stream-shares.md`):

| stream | raw | packed | share of output | ratio |
|---|---:|---:|---:|---:|
| `reg8` register operands | 6.31 MB | 1.85 MB | 31.3% | 3.41× |
| `opcodes` | 3.22 MB | 0.93 MB | 15.8% | 3.45× |
| `storage` string bytes | 2.03 MB | 0.64 MB | 10.8% | 3.17× |
| `str16` 16-bit string-ID operands | 0.87 MB | 0.41 MB | 6.9% | 2.14× |
| `u8` other 1-byte operands | 0.85 MB | 0.30 MB | 5.1% | 2.85× |
| `arrayBuffer` literal values | 0.51 MB | 0.21 MB | 3.6% | 2.43× |
| `u16`, `objKeyBuffer`, `addr8` jumps, `str8`, `fn16` | | | 3.3%, 3.3%, 2.3%, 2.3%, 1.7% | |
| 13 function-header columns | 1.9 MB | 0.36 MB | 6.1% | 5.3× |
| string table (lengths, offset deltas, utf16 flags) | 0.37 MB | 0.18 MB | 3.0% | 2.0× |
| `cacheRes` cache residuals | 0.67 MB | 0.02 MB | 0.3% | 32.9× |

Registers and opcodes carry sequence-level redundancy (repeated instruction patterns across
functions), which is why they stay as whole sequences for the LZ backend (see the dead ends).
String storage is a deduplicated packed superstring (each string appears once, short strings sit
inside longer ones), so it compresses far worse than minified JS, where identifiers repeat.

### 4. Entropy backend

Each stream is compressed with zstd level 22 and with brotli quality 11 in three parameter sets
(default, `lgblock=24`, `npostfix=3 ndirect=120`); the smallest wins and the stream header records
the backend. Brotli wins almost everywhere (its context modelling of literals suits these
streams); zstd wins the small, highly skewed ones. Both decoders are native (`@kodespire/zstd-js`,
Node's brotli; `@kodespire/brotli-js` decodes the same bytes at the same speed).

### 5. Container

`HBCP`, version byte, stream count, then per stream: backend id, raw length, stored length,
bytes (plus a 16-byte stream name for dictionary-coded streams). The decoder rebuilds the file:
tables → function bodies → info section → debug info → SHA-1 footer.

---

## What was tested and rejected

All numbers are best-of {zstd-22, brotli-11} per stream unless noted, on six mid-size files
(1.2–3 MB) unless noted. Details and dates in `NOTES.md`, scripts in `experiments/`.

| idea | result | why |
|---|---|---|
| Operand streams per opcode, or per (opcode, operand index) | 2.17 MB / 2.18 MB vs 1.87 MB for by-class streams: **worse** | the redundancy in registers is sequence-level; the LZ backend needs the whole sequence |
| Registers split by operand position | 1.13 MB vs 0.99 MB: worse | same |
| Opcodes and registers interleaved in one stream | 2.47 MB vs 2.36 MB: worse | the opcode stream alone is more predictable than the mix |
| Move-to-front (recency rank) coding of string/function IDs | 3.40 MB vs 3.35 MB total: worse | ranks compress well but the first occurrences cost more than the ranks save |
| Byte planes (low/high) for 16-bit IDs | 265 KB vs 218 KB: worse | breaks LZ matches |
| Adaptive order-1 / order-2 range coder on the opcode stream | 826 KB / 909 KB vs 494 KB for brotli | repetition dominates; a coder without match finding loses badly (and decodes at 14 MB/s in JS) |
| Order-2 context model on string storage | 628 KB vs 374 KB | same |
| xz (LZMA) as a third backend on the split streams | 54.41 MB vs 54.96 MB on all 104 files (−1.0%) at half the decode speed | after the split, LZMA's adaptive literal contexts add little; not worth an LZMA decoder |
| LZMA `lc/lp/pb` tuning on the raw files (`research/floor.md`) | within 0.7% | variable-length instructions, no 4-byte structure to exploit generically |
| Typed literal buffers (parse `NewArrayWithBuffer` / `NewObjectWithBuffer` references into columns; `src/literals.mjs`, `codec-v4`) | −0.15% overall | the buffers are packed superstrings: half the value buffer belongs to literals that start inside earlier ones and must stay raw; the key buffer is mostly string IDs that compress 1.3× either way |
| Brotli `BROTLI_MODE_TEXT` | identical bytes | no effect on these streams |
| String-table offsets relative to the previous string's end | −0.3% | kept (v2) |
| Context mixing as a backend (zpaq, paq8) | 0.6 MB/s to 3 KB/s decode | the ratio ceiling, not a backend; hbc-pack beats zpaq -m5 anyway |

---

## Research

- **Literature** (`research/literature.md`, 476 lines, 20-point executive summary): Pack200 /
  JSR 200 (band splitting of class files, 7–9× over stored, the direct ancestor of this design),
  Pugh's 1999 class-file compressor, Courgette and Zucchini (canonicalising internal references so
  identical code compresses identically), xz's BCJ filters, WebAssembly compression notes, brotli's
  static dictionary and context modes, zstd/FSE/rANS and interleaved rANS decode speeds, Oodle's
  slow-encode/fast-decode principle, LZMA literal contexts, and the ratio/speed of context
  mixing. The review ranked typed stream splitting, canonical index spaces, shared dictionaries,
  derived headers and hash recomputation as the top five; four of the five are in v3.
- **Compressibility floor** (`research/floor.md`, `research/floor.csv`): zstd, xz (five
  parameter sets), brotli, zpaq, bzip2, bzip3 on all 104 files, 1,456 round trips verified. It
  set the target (61.79 MB) and showed that generic position/literal contexts gain nothing here.
- **Format** (`ref/SPEC.md`, `ref/validation-notes.md`, `ref/opcodes.json`): derived from the
  Hermes source at the release tag `hermes-v250829098.0.9` (branch `static_h`), the commit the
  npm `hermes-compiler` package was built from. Every instruction of all 812,810 functions was
  checked against hermesc's own `-dump-bytecode` output. The copied Hermes sources (MIT, Meta
  Platforms) are in `ref/`.

### Format facts worth knowing (HBC v98)

- The small function header is 12 bytes: `offset:25 paramCount:5 loopDepth:2 | size:14
  functionName:8 numberRegs:5 nonPtrRegs:5 | frameSize:8 | readCache:8 | writeCache:6
  numCacheNewObject:1 privateNameCache:1 | flags:8`. Anything that does not fit (a function-name
  string ID above 255, most of all) moves the whole header to a 40-byte record in the info
  section, and the small header becomes a pointer to it. In minified apps that is 77% of functions.
- hermesc deduplicates identical function bodies at the byte level; 17% of functions point at
  another function's bytecode. Empty bodies all share the first empty function's offset.
- Identifier hash: `h += c; h += h << 10; h ^= h >>> 6` per code unit (bytes for ASCII strings,
  UTF-16 units otherwise), no final mix.
- String storage is a packed superstring: only 10% of strings start where the previous one ends;
  the string table's offsets are information. Within each string-kind run they are ascending.
- Literal value and key buffers are packed the same way; literal operands are byte offsets.
- Property-cache indices are allocated per function per distinct property, reads and writes in
  separate slot spaces, in first-appearance order 87–92% (reads) and 99% (writes) of the time.
- `sourceHash` in the header is the SHA-1 of the JS bundle; the footer is the SHA-1 of the file.

---

## Limitations and next steps

- **Version coverage.** Only HBC 98 is supported. Other versions need their `BytecodeList.def`
  turned into `opcodes.json` and the header/table layout re-checked. A production codec needs a
  fallback frame (plain zstd/brotli) for anything that fails the parse-and-re-serialise gate.
- **Decoder in JavaScript.** 86 MB/s median here, 27 MB/s on the smallest files (fixed costs).
  The rebuild is simple sequential code; a C or Rust port should run at several hundred MB/s.
- **Where the remaining bytes are.** Registers 31%, opcodes 16%, string storage 11%. Gains beyond
  a few percent need a stronger model for repeated instruction sequences (a function-level or
  basic-block-level match model) or cross-app sharing, which is what the dictionary mode does.
- **Delta updates.** For an update against an installed version, a structure-aware diff (match
  strings and functions by content, then diff the streams) should beat `zstd --patch-from` on
  raw `.hbc`, where inserting one string shifts every later index. The corpus has one version per
  app, so this is not measured yet.
- **Release builds compile unminified JS.** RN's Gradle plugin passes `--minify false` to Metro
  when Hermes is on; the corpus bundles were minified first. Identifier-heavy streams (string
  storage, string IDs) would be larger on stock release bytecode; the structural savings do not change.

---

## Running

Needs Node 24, `zstd` on the PATH (for dictionary training only), and the corpus checked out next
to this repo (or `HBC_CORPUS=/path/to/hermes-corpus`).

```bash
npm ci
node src/check-funcs.mjs                      # parser gate: parse + re-serialise every corpus file
node src/bench.mjs src/codec-v3.mjs           # full benchmark; writes results/codec-v3.csv
node src/train-dicts.mjs results/dicts-1m --budget 1048576
node src/bench.mjs src/codec-v3.mjs --name v3-dict1m --only $(cat results/test-slugs.txt) --opts '{"dictDir":"results/dicts-1m"}'
```

A codec module exports `pack(bytes, opts) -> Uint8Array` and `unpack(bytes, opts) -> Uint8Array`.

## Layout

| path | what |
|---|---|
| `src/hbc.mjs`, `src/funcs.mjs`, `src/isa.mjs`, `src/tables.mjs` | parser, function region, instruction set, table streams |
| `src/codec-v3.mjs` | the codec (`codec-v0..v2` are earlier stages, `codec-v4` the literal-buffer experiment) |
| `src/streams.mjs` | stream container and backends (zstd, brotli, zstd+dictionary; xz for measurement only) |
| `src/bench.mjs`, `src/check-tables.mjs`, `src/check-funcs.mjs` | benchmark and parser gates |
| `src/train-dicts.mjs` | per-stream dictionary training |
| `src/literals.mjs`, `src/mtf.mjs`, `src/rc.mjs` | typed literal buffers, move-to-front, adaptive range coder (experiments) |
| `ref/` | HBC v98 format: Hermes sources, `SPEC.md`, `opcodes.json`, generator and validator |
| `research/` | literature review, compressibility floor |
| `experiments/` | the measurements behind every decision above |
| `results/` | per-file CSVs for every codec version and dictionary mode, trained 1 MiB dictionaries |
| `NOTES.md` | working log, in order, with every number |

## License

MIT. Files under `ref/` are copied from facebook/hermes and keep their MIT license headers.

## Attribution

Hermes source in `ref/` (MIT, Meta Platforms) and the 104 corpus apps the results and dictionaries were derived from are credited in [ATTRIBUTION.md](ATTRIBUTION.md).
