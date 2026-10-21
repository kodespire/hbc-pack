# hbc-pack

A lossless compressor specialised for Hermes bytecode (`.hbc`), the format React Native apps ship
when Hermes is enabled, and the thing an over-the-air update actually downloads.

It parses the file, drops everything a decoder can recompute, splits the rest into streams that
each hold one kind of data, and lets a native LZ coder (zstd or brotli) do the entropy coding.
Compression is slow (it tries several coders per stream); decompression is a parse-free rebuild
plus native decoding; the output is byte-identical to the input.

- **Ratio.** On a corpus of 104 real React Native apps it compresses **3.82×** (HBC 98), which is
  **14% smaller than zpaq -m5** (the strongest general-purpose compressor tried, which decodes at
  0.6 MB/s), 20% smaller than xz, 23% smaller than brotli-11 and 28% smaller than zstd-22, winning
  on every single file. With shared dictionaries it reaches **4.7–5.9×** on apps it was not
  trained on.
- **Versions.** HBC 96 (React Native 0.73–0.83), 98 (0.84–0.87) and 99 (0.88), each verified on
  the same 104 apps compiled with that version's `hermesc`.
- **Decoders.** A JavaScript reference (`src/codec.mjs`, encoder and decoder) and a C11 decoder
  (`native/`, ~700 lines, zstd + brotli as its only dependencies) that rebuilds the file at
  150–230 MB/s, with builds for iOS (xcframework, Objective-C/Swift API) and Android (JNI).

Research code: the format is documented in [FORMAT.md](FORMAT.md); the measurements behind every
decision are in [NOTES.md](NOTES.md) and `experiments/`.

---

## Results

### Single file, no shared state

Corpus: `hermes-corpus` (a local-only sibling folder, not published: it contains third-party app
bundles), 104 open-source React Native apps. The same 104 minified JS bundles were compiled with
three Hermes compilers using React Native's Android release flags (`-O -output-source-map`):

| bytecode | compiler | React Native | corpus | hbc-pack | zstd -22 | brotli -q11 | xz -9e | zpaq -m5 |
|---|---|---|---:|---:|---:|---:|---:|---:|
| **HBC 98** | hermes-compiler 250829098.0.9 | 0.84–0.87 | 201.83 MB | **52.87 MB (3.82×)** | 73.62 MB (2.74×) | 68.52 MB (2.95×) | 65.77 MB (3.07×) | 61.79 MB (3.27×) |
| **HBC 96** | hermes-compiler 0.14.0 | 0.73–0.83 | 170.38 MB | **48.69 MB (3.50×)** | 68.61 MB (2.48×) | 64.13 MB (2.66×) | 61.13 MB (2.79×) | 56.73 MB (3.00×) |
| **HBC 99** | hermes-compiler 260318099.0.4 | 0.88 | 199.21 MB | **52.80 MB (3.77×)** | 73.55 MB (2.71×) | 68.35 MB (2.92×) | (measuring) | (measuring) |

hbc-pack wins on every one of the 104 files in every row (14% below zpaq on HBC 96 and 98). Every
output was decompressed and compared byte for byte with the original. The HBC 98 row also has:
brotli -q 11 with a 1 GiB window 68.51 MB, xz with the best `lc/lp/pb` 65.72 MB, bzip3 80.44 MB,
gzip -9 87.67 MB, bzip2 88.41 MB, lz4 HC 12 106.93 MB, snappy 130.73 MB (`research/floor.md`,
`hermes-corpus` benchmark).

Why the versions differ: HBC 96 files are 16% smaller than the HBC 98 build of the same JS because
v96's function header has a 17-bit function-name field; v98/99's 8-bit field pushes 77% of
functions into a 40-byte "large header" record. hbc-pack derives those records entirely, so the
gap closes after compression (48.7 vs 52.9 MB).

Per-file ratio on HBC 98: min 3.31×, median 3.73×, max 4.76× (Jellify, the largest app:
8.92 MB → 2.13 MB). Encoding the corpus takes 12 minutes (0.3 MB/s: every stream is compressed
with zstd-22 and three brotli-11 parameter sets, the smallest wins).

### Decode speed

| decoder | speed | notes |
|---|---:|---|
| C decoder (`native/hbcpack`), Apple M5 Pro | 216–232 MB/s (HBC 98), 147 MB/s (HBC 96) | 2 MB app in 9 ms, 8.9 MB app in 38 ms; per 2 MB: zstd/brotli 5.2 ms, body rebuild 3.8 ms, SHA-1 0.65 ms (ARMv8 instructions) |
| JavaScript (`src/codec.mjs`), Node 24 | 76–86 MB/s median | 27–133 MB/s per file; small files pay fixed costs |
| for comparison: zstd -19 | 1.2 GB/s | |
| brotli -q 11 | 351 MB/s | |
| xz -9e | 67 MB/s | |
| zpaq -m5 | 0.6 MB/s | |

### With shared dictionaries (over-the-air update scenario)

An OTA pipeline can ship a dictionary inside the app and reuse it for every update. hbc-pack
trains one zstd dictionary per stream (`zstd --train`), splitting a byte budget across streams in
proportion to their compressed size. Trained on 63 apps, tested on the other 41, with the split
made by a hash of the GitHub owner so no author's apps sit on both sides. Dictionary bytes are not
counted in the sizes.

| HBC 98, 41 held-out apps (67.84 MB) | total | ratio |
|---|---:|---:|
| **hbc-pack + 4 MiB of dictionaries** (3.87 MB) | **11.41 MB** | **5.94×** |
| **hbc-pack + 1 MiB of dictionaries** (986 KB, 17 streams) | **14.40 MB** | **4.71×** |
| hbc-pack, no dictionary | 17.72 MB | 3.83× |
| zpaq -m5 | 20.86 MB | 3.25× |
| zstd -19 + 1 MB dictionary (`zstd --train` on whole files) | 21.21 MB | 3.20× |
| xz -9e | 22.11 MB | 3.07× |
| brotli -q 11 | 22.97 MB | 2.95× |
| zstd -19 | 24.73 MB | 2.74× |

Same experiment, 1 MiB of dictionaries, on the other versions' held-out apps: HBC 96 16.41 MB →
**13.18 MB (4.39×, −19.7%)**; HBC 99 17.70 MB → (measuring). Decode speed is unchanged. In
practice dictionaries should be trained per React Native version; this corpus spans RN 0.61–0.87,
so the numbers above are a pessimistic mix.

### Version history

| version | HBC 98 corpus | ratio | what changed |
|---|---:|---:|---|
| zstd-22 on the raw files | 73.62 MB | 2.742× | baseline |
| v0 | 63.83 MB | 3.162× | tables only: identifier hashes dropped, string table as columns, headers byte-transposed, function region raw |
| v1 | 54.96 MB | 3.672× | function region parsed: header columns, derived offsets and large headers, exception deltas, instructions split into opcode + 16 operand streams |
| v2 | 54.69 MB | 3.690× | string-table deltas relative to the previous string's end; three brotli parameter sets per stream |
| v3 | 52.88 MB | 3.817× | property-cache indices coded as residuals from the per-function first-appearance rank |
| v4 (not adopted) | 52.80 MB (est.) | 3.82× | typed literal buffers: −0.15%, slower decode |
| **current** (`src/codec.mjs`) | **52.87 MB** | **3.817×** | v3 generalised to HBC 96/98/99 through version profiles; container version 2 |

---

## How it works

### 1. Parse

`src/hbc.mjs` reads the 128-byte header and locates the fifteen table sections; `src/profiles.mjs`
holds what differs per bytecode version (header offsets, header layouts, info-section policy,
opcode table). `src/funcs.mjs` parses the function region: small function headers, large headers
in the info section, the bytecode bodies (walked instruction by instruction with the version's
`opcodes.json`), inline switch tables, exception tables and debug offsets. `src/check-funcs.mjs`
re-serialises every corpus file from the parse and compares bytes; it is the gate every change
must pass, for every version.

### 2. Recompute instead of store

| recomputed | how | raw bytes saved (HBC 98 corpus) |
|---|---|---:|
| identifier hashes | Jenkins one-at-a-time over the string's code units, without the final mix; applied to the strings the kind table marks as identifiers | 3.53 MB (883,224 × 4), about 4% of zstd output |
| large function headers | 630,196 functions (77.5%) carry a 40-byte copy of their header because the function-name string ID does not fit the small header's 8-bit field (or `numCacheNewObject` > 1); rebuilt from the columns | 25.2 MB |
| bytecode offsets, info pointers, overflow string entries, section offsets, alignment padding | prefix sums over the parsed structure; hermesc deduplicates identical bodies (138,349 of 812,810 functions reuse one), coded as a back-reference | 13 MB of fields |
| switch-table lengths | `4·(max−min+1)` for `UIntSwitchImm`/`SwitchImm`, `8·size` for `StringSwitchImm` | – |
| SHA-1 footer | hash of everything before it | 2 KB |
| property-cache indices | within a function each distinct property gets one cache slot, reads and writes separately, in first-appearance order 87–99% of the time; the index is coded as the residual from that rank (zero 90% of the time) | u8 operand stream −40% |

### 3. Split into streams

45–49 streams (version dependent), each compressed on its own. Share of the compressed output
(12 mid-size HBC 98 files; full table in `results/v3-stream-shares.md`):

| stream | raw | packed | share of output | ratio |
|---|---:|---:|---:|---:|
| `reg8` register operands | 6.31 MB | 1.85 MB | 31.3% | 3.41× |
| `opcodes` | 3.22 MB | 0.93 MB | 15.8% | 3.45× |
| `storage` string bytes | 2.03 MB | 0.64 MB | 10.8% | 3.17× |
| `str16` 16-bit string-ID operands | 0.87 MB | 0.41 MB | 6.9% | 2.14× |
| `u8` other 1-byte operands | 0.85 MB | 0.30 MB | 5.1% | 2.85× |
| `arrayBuffer` literal values | 0.51 MB | 0.21 MB | 3.6% | 2.43× |
| `u16`, `objKeyBuffer`, `addr8` jumps, `str8`, `fn16` | | | 3.3%, 3.3%, 2.3%, 2.3%, 1.7% | |
| function-header columns | 1.9 MB | 0.36 MB | 6.1% | 5.3× |
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
Node's brotli in JS; libzstd and libbrotlidec in C).

### 5. Container

`HBCP`, version byte (2), stream count, then per stream: backend id, raw length, stored length,
bytes (plus a 16-byte stream name for dictionary-coded streams). The decoder reads the HBC header
from stream 0, picks the version profile, and rebuilds the file: tables → function bodies → info
section → debug info → SHA-1 footer. [FORMAT.md](FORMAT.md) has the byte-level specification.

---

## Native decoder and mobile ports

`native/hbcpack.c` + `hbcpack.h` is a C11 implementation of the decoder with a four-function API
(`hbcpack_unpack`, `hbcpack_unpacked_size`, `hbcpack_free`, `hbcpack_strerror`), optional
per-stream dictionaries, a configurable output limit, and bounds checks on every read and write
(malformed input returns an error, never undefined behaviour). It decodes all 104 files of each of
the three corpora byte-exactly (`native/test.sh`).

| target | what `native/build-mobile.sh` produces | wrapper |
|---|---|---|
| iOS | `hbcpack.xcframework` (device arm64, simulator arm64 + x86_64; 1.1 MB with zstd and brotli decoders statically linked) | `HBCPack` Objective-C class (`native/ios/HBCPackKit.h`): `+unpack:dictionaries:error:`, Swift-friendly |
| Android | `libhbcpack.so` / `.a` for arm64-v8a, armeabi-v7a, x86_64 (270–390 KB) | `com.kodespire.hbcpack.HbcPack` (`native/android/HbcPack.java` + JNI): `unpack(byte[])`, `unpackedSize`, `nativeVersion` |
| macOS CLI | `native/hbcpack unpack in.hbcp out.hbc [--dicts DIR] [--bench N]` (`native/build.sh`) | |

The mobile builds use plain `clang` from Xcode and the Android NDK, compiling zstd's decompressor
and brotli's decoder from the sources vendored in the sibling `zstd-js`/`brotli-js` repos; no
Xcode project, Gradle or CMake. The C API is exported from the shared libraries
(`HBCPACK_API`), so Kotlin/Swift/C++ callers can skip the wrappers. A React Native TurboModule
in the style of `@kodespire/zstd-js` would wrap the same library; it is not written yet.

---

## Bytecode versions

| HBC | compiler | React Native | what differs | status |
|---|---|---|---|---|
| 96 | hermes-compiler 0.14–0.17, RN's bundled `hermesc` (tag `hermes-v0.14.0`) | 0.73–0.83 | 16-byte small headers (`offset:25 param:7 \| size:15 name:17 \| infoOffset:25 frame:7 \| env, rcache, wcache, flags`), 32-byte large headers written only on overflow, every function gets an `infoOffset`, 8-byte debug offsets, `objValueBuffer` instead of the shape table, 206 opcodes with `SwitchImm` | gates 104/104; codec and C decoder verified |
| 98 | hermes-compiler 250829098.x (tag `hermes-v250829098.0.9`) | 0.84–0.87 | 12-byte small headers, 40-byte large headers for every function with an info block, shape table, 219 opcodes with `UIntSwitchImm`/`StringSwitchImm` | gates 104/104; codec and C decoder verified |
| 99 | hermes-compiler 260318099.x (tag `hermes-v260318099.0.4`) | 0.88 | as 98 minus `numCacheNewObject` (`writeCache` 7 bits, 36-byte large header); 220 opcodes (+`NewTypedObjectWithBuffer` +`ToUint32` −`CacheNewObject`) | gates 104/104; codec and C decoder verified |

Adding a version: fetch `BytecodeFileFormat.h`, `BytecodeList.def`, `BytecodeStream.cpp` and
`DebugInfo.h` at the release tag into `ref/vNN/`, run
`node ref/gen-opcodes.mjs ref/vNN/BytecodeList.def ref/vNN/opcodes.json`, add a profile to
`src/profiles.mjs` and the C `profile` table (`node native/gen-opcodes-h.mjs NN`), compile the
corpus with that version's `hermesc` (`hermes-corpus/tools/compile-v96.sh` is the template) and
run the gates.

---

## What was tested and rejected

All numbers are best-of {zstd-22, brotli-11} per stream unless noted, on six mid-size HBC 98 files
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
| Typed literal buffers (parse `NewArrayWithBuffer` / `NewObjectWithBuffer` references into columns; `src/literals.mjs`, `history/codec-v4`) | −0.15% overall | the buffers are packed superstrings: half the value buffer belongs to literals that start inside earlier ones and must stay raw; the key buffer is mostly string IDs that compress 1.3× either way |
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
  derived headers and hash recomputation as the top five; four of the five are in the codec.
- **Compressibility floor** (`research/floor.md`, `research/floor.csv`): zstd, xz (five
  parameter sets), brotli, zpaq, bzip2, bzip3 on all 104 HBC 98 files, 1,456 round trips verified;
  `results/floor-96-99.txt` for xz and zpaq on the other versions.
- **Format** (`ref/SPEC.md`, `ref/validation-notes.md`, `ref/opcodes.json`, `ref/v96/`,
  `ref/v99/`): derived from the Hermes source at the release tags the npm `hermes-compiler`
  packages were built from. Every instruction of all 812,810 HBC 98 functions was checked against
  hermesc's own `-dump-bytecode` output. The copied Hermes sources (MIT, Meta Platforms) are
  credited in [ATTRIBUTION.md](ATTRIBUTION.md).

### Format facts worth knowing

- hermesc deduplicates identical function bodies at the byte level; 17% of functions point at
  another function's bytecode. Empty bodies all share the first empty function's offset.
- Identifier hash: `h += c; h += h << 10; h ^= h >>> 6` per code unit (bytes for ASCII strings,
  UTF-16 units otherwise), no final mix. Same in all three versions.
- String storage is a packed superstring: only 10% of strings start where the previous one ends;
  the string table's offsets are information. Within each string-kind run they are ascending.
- Literal value and key buffers are packed the same way; literal operands are byte offsets.
- Property-cache indices are allocated per function per distinct property, reads and writes in
  separate slot spaces, in first-appearance order 87–92% (reads) and 99% (writes) of the time.
- `sourceHash` in the header is the SHA-1 of the JS bundle; the footer is the SHA-1 of the file.
- HBC 98/99's 8-bit function-name field makes 77% of minified functions carry a 40/36-byte large
  header; HBC 96 (17 bits) needs one for 0.03%. That is why v96 files are 16% smaller.

---

## Limitations and next steps

- **Versions.** 96, 98 and 99 are supported; other versions (e.g. 94/95 for React Native
  0.70–0.72) need a profile and a corpus check as described above. A production codec also wants a
  fallback frame (plain zstd/brotli) for anything that fails the parse-and-re-serialise gate.
- **Where the remaining bytes are.** Registers 31%, opcodes 16%, string storage 11%. Gains beyond
  a few percent need a stronger model for repeated instruction sequences or cross-app sharing,
  which is what the dictionary mode does.
- **Delta updates.** For an update against an installed version, a structure-aware diff (match
  strings and functions by content, then diff the streams) should beat `zstd --patch-from` on
  raw `.hbc`, where inserting one string shifts every later index. The corpus has one version per
  app, so this is not measured yet.
- **Release builds compile unminified JS.** RN's Gradle plugin passes `--minify false` to Metro
  when Hermes is on; the corpus bundles were minified first. Identifier-heavy streams would be
  larger on stock release bytecode; the structural savings do not change.
- **React Native module.** The native library is ready; a TurboModule package (`@kodespire/hbc-pack`)
  following the zstd-js template is the natural next step.

---

## Running

Needs Node 24, `zstd` on the PATH (dictionary training only), and the corpus checked out next to
this repo (or `HBC_CORPUS=/path/to/hermes-corpus`). The C builds need clang (Xcode) and the
Android NDK, plus Homebrew's zstd and brotli for the macOS CLI.

```bash
npm ci
node src/check-funcs.mjs [--dir bundles96|bundles99]     # parser gate over a corpus
node src/bench.mjs src/codec.mjs [--dir bundles96]        # full benchmark; results/codec*.csv
node src/train-dicts.mjs results/dicts-1m --budget 1048576
node src/bench.mjs src/codec.mjs --name dict1m --only $(cat results/test-slugs.txt) --opts '{"dictDir":"results/dicts-1m"}'
sh native/build.sh && node src/pack-all.mjs && sh native/test.sh   # C decoder against the corpus
sh native/build-mobile.sh                                 # iOS xcframework + Android libraries
```

A codec module exports `pack(bytes, opts) -> Uint8Array` and `unpack(bytes, opts) -> Uint8Array`.

## Layout

| path | what |
|---|---|
| `src/codec.mjs` | the codec (encoder + decoder), all versions |
| `src/profiles.mjs`, `src/hbc.mjs`, `src/funcs.mjs`, `src/isa.mjs`, `src/tables.mjs` | version profiles, parser, function region, instruction set, table streams |
| `src/streams.mjs` | stream container and backends (zstd, brotli, zstd+dictionary; xz for measurement only) |
| `src/bench.mjs`, `src/check-tables.mjs`, `src/check-funcs.mjs`, `src/pack-all.mjs`, `src/train-dicts.mjs` | benchmark, gates, packing, dictionary training |
| `src/history/` | codec v0–v4 as they were measured (they predate the profile refactor; check out commit `9e1ac2b` to run them) |
| `src/literals.mjs`, `src/mtf.mjs`, `src/rc.mjs` | typed literal buffers, move-to-front, adaptive range coder (rejected experiments) |
| `native/` | C decoder, CLI, iOS/Android wrappers and build scripts, generated opcode tables |
| `ref/`, `ref/v96/`, `ref/v99/` | Hermes sources per version, `SPEC.md`, `opcodes.json`, generator and validator |
| `research/` | literature review, compressibility floor |
| `experiments/` | the measurements behind every decision above |
| `results/` | per-file CSVs for every codec version, corpus and dictionary mode; trained 1 MiB dictionaries |
| `FORMAT.md` | the container and stream format |
| `NOTES.md` | working log, in order, with every number |

## Attribution

Hermes source in `ref/` (MIT, Meta Platforms) and the 104 corpus apps the results and dictionaries
were derived from are credited in [ATTRIBUTION.md](ATTRIBUTION.md).

## License

MIT. Files under `ref/` are copied from facebook/hermes and keep their MIT license headers.
