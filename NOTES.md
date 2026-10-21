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
