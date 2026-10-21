# hbc-pack: working notes

Goal: a lossless compressor specialised for Hermes bytecode (HBC v98) that compresses slowly,
decompresses fast, and beats every general-purpose compressor on the 104-bundle corpus
(`../bundles/*/index.android.hbc`, 202 MB). Decoded output must be byte-identical.

Baselines on the corpus (from ../results/summary.md, HBC): zstd-19 73.62 MB (2.74x),
zstd-22 73.62 MB, brotli-11 68.52 MB (2.95x), brotli-11-w24 68.51 MB. JS compresses 5.2-5.4x.

## Plan
1. Format: exact HBC v98 layout from the Hermes source (branch static_h), in ref/SPEC.md + ref/opcodes.json.
2. Literature: research/literature.md.
3. Floor: research/floor.md: xz, brotli large window, zpaq etc. on all 104 files.
4. Codec: src/ — parse → reversible transforms → stream split → entropy backend (zstd first, then
   custom). Verify round trip on all 104 files every iteration. Bench with src/bench.mjs.
5. Report: README.md in this folder with results.

## Log
- 2025-10-20 21:20 Started. hermesc 250829098.0.9 reports "HBC bytecode version 98". Hermes `main`
  is at version 96, `static_h` at 99, so 98 is on static_h around 2025-08-29.
- hermesc can disassemble our files: `hermesc -b -dump-bytecode -pretty file.hbc` prints header,
  string table with identifier hashes (`#FF4C300D`), literal buffers, then every function.
  Useful for validating the parser.
- 21:40 Table-level parser (src/hbc.mjs) checked on all 104 files:
  - SmallFuncHeader is **12 bytes** in v98 (not 16 as in older HBC). Found by locating the string
    table by content; the spec agent will give the field layout.
  - StringKind entry: bit 31 = identifier (1) / string (0), low 31 bits = run length.
  - Small string entry: bit0 utf16, bits1-23 offset (or overflow index when length==255), bits 24-31 length.
  - **Identifier hashes = Jenkins one-at-a-time without the final mix**, over code units (bytes for
    ASCII, uint16 for UTF-16). 883,224 identifiers across the corpus, all recompute exactly. That is
    3.5 MB raw, ~4% of zstd-22 output, recoverable for free.
  - Footer = SHA-1 of the file minus the last 20 bytes: all 104 verify.
  - String storage is a packed superstring: only 10% of strings start where the previous ends; short
    strings sit inside longer ones ("y" inside "Array"). So offsets are information, not derivable from
    lengths. Within a kind run, offsets look ascending (check before relying on it).
  - Coarse zstd-22 split over 8 files: function bodies 63% of compressed bytes, string storage 17%,
    function headers 6%, identifier hashes 4%, string table 4%, array literal buffer 4%.
  - String storage compresses only 2.6x because it is deduplicated: each string occurs once, unlike
    minified JS where LZ feeds on identifier repetition. Candidates: cross-app dictionary, PPM/CM.
- 22:10 Backend comparison on 12 files (function region alone): zstd-22 6.91 MB, brotli-11 6.53 MB,
  **xz-9e 6.21 MB** (10% better than zstd). lc/lp/pb tuning changes nothing (variable-length code,
  no alignment). String storage: brotli 1.43 MB < xz 1.46 < zstd 1.51 (brotli's static dictionary
  helps text). Conclusion: adaptive context modelling (LZMA) is worth ~10% on bytecode; a custom
  coder with format-aware contexts should get at least that with faster decode.
- 22:25 **codec-v0** (src/codec-v0.mjs): tables transformed (hashes dropped, string table columns +
  offset deltas, headers byte-transposed), function region raw, best-of {zstd-22, brotli-11} per
  stream. All 104 files round-trip. 201.83 MB -> 63.83 MB (3.162x): 13.3% smaller than zstd-22,
  6.8% smaller than brotli-11, 2.95% smaller than xz-9e. Decode 208 MB/s median (JS, incl. SHA-1 and
  hash recomputation). Encode 0.7 MB/s (tries both backends).
- 22:45 Floor (research/floor.md, all 104 HBC files): zpaq -m5 61.80 MB (30.62%, decode 0.6 MB/s),
  xz -9e 65.77 MB (32.59%, 67 MB/s), brotli q11 lw30 68.5 MB (33.94%, 172 MB/s), zstd-22 73.6 MB
  (36.48%, 256 MB/s), bzip3 80.4 MB, bzip2 88.4 MB. LZMA lc/lp/pb tuning: within 0.7%, no 4-byte
  structure to exploit generically. **Target to beat: 61.80 MB.** v0 is at 63.83 MB.
- 22:50 Adaptive range coder test (src/rc.mjs) on one function region: order-1 byte model 1.75x,
  order-2 1.73x, vs zstd-22 2.81x; JS decode 14 MB/s. Pure context modelling without match finding
  loses badly on bytecode (repetition dominates) and is slow in JS. Decision: keep LZ backends
  (zstd/brotli native) and put the format knowledge into reversible transforms + stream separation.
- 23:40 Function region parsed and re-serialised exactly on all 104 files (src/funcs.mjs, gate
  src/check-funcs.mjs): 812,810 functions, 674,461 unique bodies (138,349 reuse a body: hermesc
  dedups identical bytecode), 630,196 functions (77%) carry a 40-byte large header in the info
  section because functionName (string id) > 255 or numCacheNewObject > 1 does not fit the small
  header; 85,155 exception entries; 1,977 switch tables; 28.2M instructions in 121 MB.
  Layout facts: bodies are byte-packed in function order (no padding unless a switch table
  follows: pad4 + table); empty bodies share the first empty function's offset; info blocks are
  pad4 + large header + [u32 count + 12-byte entries] + [u32 debug offset], in function order.
- 23:55 **codec-v1** (src/codec-v1.mjs): headers as columns (offsets/info pointers/large headers
  derived), exceptions as deltas, instructions split into opcode + 16 operand streams by
  class and width. 3 files: 3.89x, 24.9% smaller than zstd-22, 20.1% than brotli-11, 15.7% than
  xz, 8.6% than zpaq -m5. Decode 69 MB/s (JS). Full run started.
- 00:20 **codec-v1 on all 104 files: 54.96 MB (3.672x)**, round-trip ok everywhere. 25.3% smaller than
  zstd-22, 19.8% than brotli-11 (any window), 16.4% than xz-9e, **11.0% than zpaq -m5**; wins on
  104/104 files against each. Decode 62 MB/s median in JS (SHA-1 + hashes + instruction re-emit),
  encode 0.9 MB/s (tries zstd-22 and brotli-11 per stream).
  Per-stream share of output (4 files): reg8 24%, storage 22%, opcodes 12%, u8 7%, arrayBuffer 6%,
  str16 5%, objKeyBuffer 4%, u16 2.5%, strDeltas 2.3%, strLens 2%, addr8 1.7%, str8 1.7%, fn16 1.2%.
- Stream-layout experiment (experiments/streams-lab.mjs, 6 files): splitting operands further
  (per opcode, or per (opcode, operand index), or registers by position) is WORSE than by
  class+width (2.17 MB vs 1.87 MB): the redundancy in registers/opcodes is sequence-level and the
  LZ backend needs the whole sequence in one stream. Adaptive order-1/2 coders on the opcode
  stream are far worse than brotli (826 KB vs 494 KB). Byte planes for 16-bit ids: worse.
  **MTF ranks for 16-bit string ids: -13%** (189 KB vs 218 KB). Next: literal buffers, MTF ids.
- 01:10 Repo moved to its own repository (github.com/kodespire/hbc-pack, public). Corpus path via
  src/corpus.mjs (HBC_CORPUS env).
- Dead ends measured (6 mid-size files, best-of zstd/brotli per stream):
  - MTF ranks for id operands: a LOSS once first occurrences are stored (3.40 vs 3.35 MB total with
    str16; worse with fn16/str32/str8 added). The earlier lab forgot the fresh-id stream.
  - Interleaving opcodes with reg8 operands (2.47 MB) or with all 1-byte operands (2.60 MB) is
    worse than separate streams (2.36 MB).
  - xz as a third backend on v1 streams: 54.41 vs 54.96 MB (-1.0%) at half the decode speed. After
    the split, LZMA's adaptive modelling adds little; an LZMA-class backend is not worth building.
  - String-table deltas relative to the previous string's end: -0.3% (kept, v2 default).
  - Literal buffers are packed superstrings like string storage (a literal's bytes may sit inside
    another literal's payload), so they cannot be parsed into columns and re-serialised; stay raw.
- 01:50 **codec-v2 on all 104 files: 54.78 MB (3.685x)**, 11.4% below zpaq. (v2 = v1 + string-table
  end-relative deltas; MTF off.)
- **Shared-dictionary mode** (src/train-dicts.mjs: one zstd dictionary per stream, trained with
  `zstd --train` on the 63 train apps, budget split by each stream's compressed share; tested on the
  41 held-out apps, 67.84 MB raw):
  - hbc-pack v2, no dictionary: 18.37 MB (3.69x)
  - + 1 MiB of dictionaries (17 streams, 991 KB): **14.94 MB (4.54x)**, -18.7%
  - + 4 MiB of dictionaries (4.03 MB): **11.73 MB (5.78x)**, -36.1%
  - baselines on the same apps: zstd-19 24.73 MB, zstd-19 + 1 MB dictionary 21.21 MB, brotli-11
    22.97 MB, zpaq -m5 20.86 MB. So hbc-pack + 1 MiB dict is 29.6% below zstd+dict; + 4 MiB is 44.7% below.
  - Dictionaries would ship inside the app (not counted in the sizes), trained per RN version in practice.
- Decode profile (jellify, 8.9 MB): entropy decoding 20 ms, JS transform 125 ms (instruction
  re-emission dominates). Brotli decodes at 460-530 MB/s in Node (chunk size irrelevant) and the same
  with @kodespire/brotli-js. Next: integer-coded operand descriptors in the hot loop.
- Brotli parameter sweep per stream: text mode = no change; lgblock 24 helps opcodes/reg8 slightly;
  npostfix 3 + ndirect 120 helps id streams slightly. Encoder now tries all three (~0.3%).
- 02:20 Property-cache indices (the UInt8 operand of GetById*/TryGetById/PutById*): within a
  function hermesc gives each distinct property one slot, reads and writes separately, in
  first-appearance order 87-92% (reads) / 99% (writes) of the time (experiments/cache-slot-lab.mjs).
  Coding the index as a residual from that rank makes the u8 operand stream 40% smaller
  (281 -> 169 KB on 6 files, residual zero 90%). **codec-v3**: 3 files 4.02x vs v2 3.90x.
- 02:50 **codec-v4** (typed literal buffers, src/literals.mjs): the value and key buffers are
  rebuilt from their references (NewArray/ObjectWithBuffer* operands + shape table) in offset
  order; literals that start inside an earlier one keep only their tail, raw. Works (3/3 round
  trips) but gains only 1.5% of the buffers = 0.15% overall, because overlapping literals are
  common (the Tail stream is half the value buffer) and the key buffer is mostly string ids that
  compress 1.3x either way. Decode slower. **Not adopted; v3 stays the codec.**
- 03:30 **codec-v3 on all 104 files: 52.88 MB (3.817x)**: 14.4% below zpaq -m5, 19.6% below xz,
  22.8% below brotli-11, 28.2% below zstd-22; wins 104/104 against each. Per-file 3.31x-4.76x.
  Decode 86 MB/s median (27-133). Dictionaries retrained on v3 streams: on the 41 held-out apps
  v3 17.73 MB (3.83x) -> +1 MiB dicts 14.40 MB (4.71x) -> +4 MiB dicts 11.41 MB (5.94x);
  zstd-19+1MB dict 21.21 MB, zpaq 20.86 MB on the same apps. README rewritten with everything.
- 04:50 **Native decoder** (native/hbcpack.c, C11, ~600 lines, zstd + brotli as the only
  dependencies): decodes all 104 packed corpus files byte-exact (native/test.sh). 216-222 MB/s on
  the M5 Pro (2 MB file in 8-9 ms). Profile per 2 MB file: zstd/brotli streams 5.2 ms, body rebuild
  3.8 ms, strings/info 0.2 ms, SHA-1 0.65 ms with ARMv8 SHA-1 instructions (4.2 ms portable).
  Mobile builds (native/build-mobile.sh, plain clang, no Xcode project/Gradle/CMake):
  hbcpack.xcframework (ios-arm64 + arm64/x86_64 simulator, 1.1 MB, C API + Objective-C
  HBCPack class), Android libhbcpack.so/.a for arm64-v8a, armeabi-v7a, x86_64 (250-360 KB)
  with a JNI binding (com.kodespire.hbcpack.HbcPack). FORMAT.md documents the container.
- 05:40 **HBC 96 support.** hermes-compiler@0.14.0 (React Native 0.83) emits bytecode version 96 and
  matches tag hermes-v0.14.0 (ref/v96/). The corpus's 104 JS bundles compiled with it
  (hermes-corpus/bundles96, 174 MB: 14% smaller than the v98 build of the same JS, because v96's
  17-bit function-name field keeps 99.97% of headers small while v98's 8-bit field pushes 77% into
  40-byte large headers). Differences handled by src/profiles.mjs: header field offsets after byte
  88 (objValueBuffer instead of the shape table, no stringSwitchImm count), 16-byte small headers
  (offset:25 param:7 | size:15 name:17 | infoOffset:25 frame:7 | env, rcache, wcache, flags),
  32-byte large headers, every function gets infoOffset = align4(pos) and the large header is
  written only when the small one overflows (fields copied in order until the first overflow),
  8-byte DebugOffsets, 206 opcodes with SwitchImm. Same string tables, hashes, dedup, exception
  tables. Parser gate: 104/104 for both versions. Unified codec (src/codec.mjs, container v2) and
  C decoder handle both; native decoder 104/104 on v98 at 232 MB/s (jellify).
