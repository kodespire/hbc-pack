# Hermes bytecode (HBC) compression: literature review and design basis

Date: 2026-10-20. Corpus: `/Users/wintonchen/Desktop/kodespire-compression/hermes-corpus` (104 React Native apps, each as a minified JS bundle and as HBC v98 built by hermesc 250829098.0.9).

Labels used below:
- **[M]** measured by me on this corpus (scripts in the session scratchpad, not in the project).
- **[P]** primary source read in full or in the relevant section.
- **[S]** claim seen only in a search summary or abstract excerpt; the page itself was not fetched or was blocked.
- **[F]** folklore, anecdote, or vendor claim without a published benchmark.
- **[E]** my estimate, not a measurement.

---

## Executive summary

1. **Corpus shape [M].** All 104 files are HBC version 98 (header u32 at offset 8). Of the 201.8 MB raw, about 74% is function bodies (instructions, exception tables, large headers, padding; not yet parsed into separate fields), 11.6% is string storage, 4.8% is function headers (12 B each, 812,810 functions), 4.4% is array and object literal buffers, 2.7% is the small string table, 1.75% is the identifier-hash array, and debug info is effectively zero (the `-output-source-map` build leaves a 16-byte empty debug header per file).
2. **Layout verified [M], with a correction.** Function headers are 12 bytes, not the 16 the Hermes excerpt implies. The small string table starts at 52,328, not the 65,828 I first assumed. Its 32-bit entries (bit 0 UTF-16 flag, bits 1–23 offset, bits 24–31 length) decode to whole identifier or literal tokens: 4,189 of 4,587 entries (91%) appear verbatim, as whole tokens, in the minified JS of the example app. Across a random 12-app sample the pooled rate is 90.2%, and the identifier-run sums match identifierCount in all 12. The string-kinds run-length entries also decode: bit 31 flags an identifier run, the low 31 bits give the count, and the two identifier runs sum to exactly identifierCount (2,922).
3. **Integrity fields [M].** The footer is SHA-1 of everything before it (104/104), so it need not be stored (20 bytes per file, about 2 KB across the corpus). The header `sourceHash` is SHA-1 of the minified JS bundle (104/104), so it is recomputable only with the JS and must be stored.
4. **Baselines [M].** Raw HBC 201.8 MB. zpaq -m5 61.8 MB (3.27x), xz -9e 65.8 MB (3.07x), brotli-11 68.5 MB (2.95x), zstd-22 73.6 MB (2.74x). The real bar is xz/zpaq, not brotli. xz's lc/lp/pb settings move the total by under 0.7%. Minified JS compresses 5.2–5.4x. zstd-19 with a 1 MB dictionary trained on 63 apps and tested on 41 held-out apps: 24.7 MB to 21.2 MB (-14%) on HBC, and -29% on JS. Baseline provenance is in section 1.5.
5. **Why HBC compresses worse than JS [M + hypothesis].** Bytecode references strings, functions and identifiers by per-file integer indices, so the same library function in two apps is not byte-identical. The dictionary gain is about half as large on HBC as on JS. Canonicalizing the index spaces is therefore the most important structural idea, and it is untested.
6. **Closest published analogues [P].** Pack200 (JSR 200, Oracle spec) splits the stream into typed "bands" and sorts constant pools so deltas are small. Its spec claims 7–9x over stored class files, with a DEFLATE post-pass. Courgette (Chromium) canonicalizes internal references into a sorted target list and reports 78,848 bytes against 704,512 for bsdiff on one Chrome update [P]. Zucchini has no published numbers [P].
7. **Pugh 1999 [S].** Search summaries of the UMD page claim packed class files are 1/2 to 1/5 of compressed JARs. The page could not be fetched (TLS error), so treat this as unverified.
8. **WebAssembly [S/F].** No measured study of stream splitting for wasm was found. Only anecdotes (gzip about 4:1 on one 2 MB module; brotli 2.4 MB vs gzip 3.4 MB on one 16 MB module).
9. **Entropy speed [P].** FSE (tANS) decodes 440 MB/s and Huff0 1350 MB/s on the README's i7-5600U setup. Interleaved rANS gives 1.6–2.8x over serial decode (arXiv 1402.3392). brotli-11 decodes 351 MB/s here; zstd-19 decodes 1.2 GB/s. The design must at least match brotli-11 decode speed.
10. **Context mixing is out of budget [P].** LTCB reports paq8px at about 3.4 KB/s and cmix at about 1.6 KB/s decode on enwik9, and zpaq at about 68 KB/s. CM is a ratio ceiling to probe, not a backend.
11. **Top techniques (ranked, section 3):** (1) stream split with opcode-conditioned operand models, (2) canonical index spaces, (3) a shared dictionary (measured 14% on HBC, count it once), (4) delta and derived function headers, (5) recompute the identifier hashes if their function can be recovered, otherwise accept about 5% floor cost.
12. **Estimates [E].** Technique 1 alone: 10–20% below xz -9e on HBC. Techniques 1–5 together: roughly 20–30% below xz -9e, which would beat zpaq -m5 while decoding at hundreds of MB/s (xz -9e decodes at about 67 MB/s here, zpaq -m5 at about 0.6 MB/s). These are estimates until experiments E2 and E8 run.
13. **Architecture (section 4):** parse with exact re-encode check, canonicalize, split into typed streams, model per stream, entropy-code with interleaved tANS/rANS, and fall back to zstd or brotli frames for any file that fails the exact re-encode check.
14. **Biggest unknowns:** (a) the identifier-hash function (the hashes look random, so unless one is recovered they are a floor of about 5% of brotli-11 output); (b) whether hermesc's string and function ordering is derivable from content (a stored permutation for 4,587 strings would cost about 6 KB); (c) how many function bodies match across apps after canonicalization.
15. **First experiments (section 5):** E1 per-section compression (no decoder needed), E2 instruction decode and exact re-encode on all 812,810 functions (the gate for everything else), E4 hash identification, E6 cross-app function duplication.
16. **Format-version risk.** The corpus is single-version (v98). Production files can come from other hermesc releases. Every transform needs an exact re-encode check and a fallback frame; Pack200 was removed from the JDK (JEP 367) partly because maintenance cost outweighed its benefit [P].
17. **Delta option.** Expo reports an estimated 75% download reduction for bytecode diffs against the installed bytecode [S/F]. Hermes exposes `-base-bytecode` (delta-optimizing mode) and zstd has `--patch-from` [P]. The corpus has one version per app, so this cannot be measured here.
18. **Gaps.** No primary benchmarks for: Slim Binaries, Dex/APK bytecode compression, Lua or .NET bytecode compression, Redex string dedup, COVER dictionary construction results (ACM page returned 403).
19. **Recommended metric.** Report sizes three ways: single file, single file plus a shared dictionary counted once, and delta against a base version. Mixing these is what makes HBC look worse than JS in the current README.
20. **Bottom line.** The gain is in the instruction stream (about 74% of bytes) and the per-file index spaces, not in the entropy coder. Start with the structural experiments before choosing a backend.

---

## 1. Local measurements that drive the design

### 1.1 Format facts checked against the 104 files

| Fact | Evidence | Status |
|---|---|---|
| Magic `0x1F1903C103BC1FC6`, version 98 in all 104 files | header read; `manifest.json` `bytecodeVersion` | [M] |
| Header is 128 bytes; fileLength at offset 32 equals file size | all 104 files | [M] |
| Footer (20 bytes) = SHA-1 of file minus footer | 104/104 | [M] |
| `sourceHash` (offset 12, 20 bytes) = SHA-1 of minified JS bundle | 104/104 | [M] |
| debugInfoOffset is at offset 108 (fetched excerpt put it at 104; data says 104 holds an options byte, 108 holds `fileLength - 36`) | value equals `fileLength-36`, consistent with a 16-byte debug header | [M], discrepancy with [P] excerpt noted |
| Function headers: 12 bytes each, starting at offset 128; string kinds start at `128 + 12*functionCount` (40,628 in the example app) | the string kinds decode and their identifier runs sum to identifierCount; the small string table at 52,328 matches the JS (91% whole-token) | [M] |
| Small string table entry: bit 0 UTF-16 flag, bits 1–23 offset, bits 24–31 length, table at 52,328 | 4,189 of 4,587 entries match whole tokens in the minified JS (example app); 90.2% pooled over a 12-app sample; matches Strings.md | [M] + [P] (doc) |
| Overflow table entries: 8 bytes; used when length is 255 | 16 entries in the example file | [M] + [P] (doc) |
| Identifier-hash array: 4 bytes per identifier, 2,922 entries in the example file, at 40,640 directly before the small string table | all 2,922 distinct; top-nibble counts roughly uniform; share with top byte < 0x40 is 25.4% (random: 25%); monotone-pair fraction 0.50. Consistent with random hashes; not proven (see 6.2) | [M] |
| Instruction operand types are Reg8/Reg32, UInt8/16/32, Imm32, Addr8/Addr32, Double; many ops have short and long forms | BytecodeList.def | [P] |

### 1.2 Section shares across the corpus (raw bytes, 201,832,116 total)

| Section | Bytes | Share | Note |
|---|---:|---:|---|
| Function bodies (instructions, exception/info data, large headers, padding), unsplit | 149.1 MB | 73.86% | not yet parsed; the biggest target |
| String storage (identifiers and strings, shared substrings) | 23.3 MB | 11.55% | |
| Function headers (12 B x 812,810) | 9.8 MB | 4.83% | derived fields; see technique 4 |
| Array buffer | 6.3 MB | 3.12% | typed literal arrays |
| Small string table (4 B x 1,369,350 strings in corpus) | 5.5 MB | 2.71% | derivable from storage layout and kinds |
| Identifier hashes (4 B x 883,224 identifiers) | 3.5 MB | 1.75% | see technique 5 |
| Object key buffer | 2.3 MB | 1.16% | |
| RegExp storage + table | 1.8 MB | 0.90% | |
| Object value buffer | 0.15 MB | 0.07% | |
| Overflow table, string kinds, bigint, header, footer, debug | < 0.1 MB | < 0.1% | |

Method: header counts and fixed entry sizes (function headers 12 B, verified by the string-kinds position); the 74% remainder is the difference. [M]. The split inside the 74% needs the opcode table (E2).

Counts: 812,810 functions (mean 7,815 per app); 1,369,350 strings, of which 883,224 (64.5%) are identifiers.

### 1.3 Existing benchmark numbers [M, from `results/summary.md`]

| Codec | JS total | HBC total | HBC decode (median) |
|---|---:|---:|---:|
| zstd-3 | 43.9 MB (4.21x) | 84.0 MB (2.40x) | 1,579 MB/s |
| zstd-19 | 35.9 MB (5.15x) | 73.6 MB (2.74x) | 1,216 MB/s |
| brotli-11 | 33.9 MB (5.44x) | 68.5 MB (2.95x) | 351 MB/s |
| brotli-9 | 37.5 MB | 75.3 MB | 446 MB/s |
| gzip-9 | 46.1 MB | 87.7 MB | 401 MB/s |
| zstd-3 + 1 MB dictionary (test apps) | | 26.4 MB vs 28.2 MB without (-6.2%) | 1,398 MB/s |
| zstd-19 + 1 MB dictionary (test apps) | 8.56 MB vs 12.02 MB (-28.8%) | 21.2 MB vs 24.7 MB without (-14.2%) | 1,036 MB/s |

Implication: the decoder budget is at least brotli-11 speed (351 MB/s median), and zstd-class decode speed is the comfortable target. The README's note that the dictionary is not counted must be fixed before quoting a single number.

### 1.4 Observations that change the design

- **Index renumbering is the likely reason HBC gains less from a dictionary than JS (29% JS vs 14% HBC).** Operands refer to string IDs, identifier IDs and function IDs that are per-file. The same library function therefore differs byte-for-byte across apps. [hypothesis, to test in E6]
- **Hermes already has a delta mode that keeps string order stable.** `hermesc -base-bytecode=<file>` is documented in the local `-help` as "input base bytecode for delta optimizing mode", and Strings.md says delta mode keeps the existing string order, so small source edits do not reshuffle the table [P]. The corpus was built without it, so the stored order is the default packer order.
- **Whole-program optimizations already shrink bytecode per app** (function deduplication and string-table packing with shared substrings, per the 2019 Hermes post [P]). Cross-app sharing is not done by the compiler.
- **Debug info is empty** in this corpus. Format-specific work does not need to model it, but the decoder must still handle non-empty debug info from other build flags (fallback path).

---

### 1.5 Baselines, including xz and zpaq

Totals over the 104 HBC files (201,832,116 bytes). Source: `hbc-pack/research/floor.csv`.

| Codec | Total bytes | Ratio |
|---|---:|---:|
| zpaq -m5 | 61,794,916 | 3.27x |
| xz -9e, lc=1 lp=0 pb=2 | 65,723,756 | 3.07x |
| xz -9e (default lc=3 lp=0 pb=2) | 65,770,516 | 3.07x |
| xz -9e, pb=0 | 65,843,320 | 3.07x |
| xz -9e, lc=0 lp=0 pb=2 | 65,856,956 | 3.07x |
| xz -9e, lc=0 lp=2 pb=2 | 66,167,860 | 3.05x |
| brotli -q 11 -lgwin 30 | 68,508,904 | 2.95x |
| zstd -22 | 73,620,408 | 2.74x |
| zstd -22 --long=27 | 73,619,933 | 2.74x |
| bzip3 -b 511 | 80,439,051 | 2.51x |
| bzip2 -9 | 88,414,117 | 2.28x |

Reading: the best measured general-purpose baseline is zpaq -m5, 6% below xz -9e. xz's lc, lp and pb settings move the total by under 0.7%, so literal-context tuning is not a lever here. The brotli row above (68.5 MB, lgwin 30) is the floor.csv variant; the section 1.3 brotli-11 figure (68.5 MB, lgwin 22) is from the existing benchmark, and the two agree to within rounding (0.02%).

Provenance and checks:
- `floor.csv` is in `research/`, but another process wrote it during this session. I did not create or modify it, and I left it untouched.
- Spot check 1: xz -9e on `aashu-dubey__react-native-ui-templates` is 646,800 bytes, an exact match to the row. Spot check 2: zpaq -m5 on the same file gives 613,244 bytes against 613,256 in the row. The 12-byte gap is unexplained (probably archive overhead).
- The file marks all 1,456 rows as `roundtrip_ok = 1`. I did not re-verify the round trips.
- Timing columns are CLI wall times, including process start, so they understate throughput on small files. For speed, use lzbench (section 2.4). The table gives zpaq -m5 about 0.6 MB/s decode, consistent with a context-mixing coder.

## 2. Sources by topic

### 2.1 Bytecode and class-file compression

**Pugh, "Compressing Java Class Files", PLDI 1999** [S]. Page: https://www.cs.umd.edu/~pugh/java/latex2html/pack/node1.html (fetch failed with a TLS error in this session, so this is from search summaries of the same page).
- Claimed: packed format is 1/2 to 1/5 of the size of the compressed JAR, and 1/4 to 1/10 of the uncompressed class files; a gain of 2–5x over individually gzipped class files. Results vary by benchmark.
- Applicable idea for HBC: separate typed streams and sort/renumber symbols. Treat the 2–5x per-file-gzip claim as an upper bound on what structure-aware methods can add over per-file gzip, not as a comparison to brotli.

**Corless, "Compression of Java class files", MSc thesis, Victoria 1996** [P, abstract excerpt]. https://dspace.library.uvic.ca/items/63a8b2cf-7b73-459f-bb0d-ac03a6e7da5d
- Claims the specialized algorithm "outperforms general-purpose compressors by 28%" on average, with comparable CPU and memory. Techniques are not in the abstract.
- Applicable idea: a published-quality reference point for "structure beats gzip by about a quarter" on bytecode. Get the full PDF before quoting.

**JSR 200 / Pack200** [P].
- Spec (Oracle): https://docs.oracle.com/javase/8/docs/technotes/guides/pack200/pack-spec.html. Key points:
  - The archive is independent "bands" transmitted as contiguous byte segments, each with a primary encoding. Band coding uses integer schemes "parameterized by four numbers (B,H,S,D)". Named primaries include UNSIGNED5, UDELTA5 (monotonic), DELTA5 (autocorrelated), BCI5 (bytecode positions) and BRANCH5 (branch offsets).
  - Constant pools are sorted and deduplicated so that UDELTA5 values increase; "it is generally advantageous to order them so that the encoded values in bands using UDELTA5 are monotonically increasing".
  - Stated results: "a factor of seven to nine, compared with an equivalent JAR containing uncompressed ('stored') class files"; zip DEFLATE gains "a factor of two"; "crunch" gains five to six. "All these figures assume and incorporate the effects of a post-pass with DEFLATE."
  - Entropy coding is not specified; the spec leaves the post-pass open.
- JSR 200 proposal (2004) [P]: https://jcp.org/en/jsr/detail?id=200. Says existing JAR compression gives "a meager reduction factor of about two", and the Pack format gives "seven to nine" on the J2SE 1.4 installer; it "relies on a post-packing compression step".
- JEP 367 [P]: https://openjdk.org/jeps/367. Pack200 was deprecated in JDK 11 (JEP 336) and removed. Stated reasons: the JDK no longer needs it, and "the cost of maintaining Pack200 is significant, and outweighs the benefit". The lesson for HBC: format-specific packers carry maintenance cost, so the exact re-encode check and a generic fallback are part of the design, not optional.
- Applicable ideas: (a) band-per-field-class streams (technique 1); (b) BCI-like coding of instruction positions and BRANCH-like coding of jumps; (c) sorted constant pools so deltas are small (technique 2; here Hermes string order is the analogue); (d) an explicit post-pass is what the 7–9x claim includes, so compare HBC structure against brotli or zstd with the same post-pass.

**Courgette (Chromium)** [P]: https://www.chromium.org/developers/design-documents/software-updates-courgette
- Disassembles x86 to find internal pointers (about half a million in chrome.dll). Splits the program into target addresses, remaining bytes, and a reconstruction sequence. Targets become indices into a sorted symbol table; the new file's addresses are reordered to shrink the diff.
- Measured on one update (190.1 to 190.4 developer channel): full update 10,385,920 bytes; bsdiff 704,512 bytes; Courgette 78,848 bytes. Converting to assembly form alone makes the bsdiff output about 30% smaller.
- Constraints: assemble and disassemble "have to be strict inverses".
- Applicable idea: HBC operands are references (string IDs, function IDs, jump targets). Canonicalize them into sorted target lists so identical code gets identical indices (technique 2).

**Zucchini (Chromium)** [P]: https://chromium.googlesource.com/chromium/src/+/HEAD/components/zucchini/README.md
- Reference model: each reference has a location, a target, and a type; a target key is its index in a sorted list; each reference type has a target pool; fewer pools reduce redundancy but use more memory and can cause larger corrections.
- Patch generation takes about 15–20 min and 1 GB RAM for Chrome. Patch size is measured after 7z. No numbers are published in the README.
- Applicable idea: the pool-per-reference-type design maps to per-operand-class pools in HBC (string IDs, function IDs, register values, jump targets).

**Slim Binaries (Franz and Kistler, CACM 40(12), 1997)** [S/F]. No size numbers found. Secondary sources describe the representation as compact and architecture-neutral; one comp.compilers poster reports that the Oberon predecessor was "a lot smaller" than object files. Page: https://wiki.tcl-lang.org/page/Slim+Binaries. Applicable idea: the same concept as "ship an architecture-neutral form and derive the target form on the device", which HBC already is.

**Fraser, Proebsting et al., "Code Compression", PLDI 1997** [S]. Record: https://experts.azregents.edu/en/publications/code-compression-2/. Abstract summary: a "wire" form that must be decompressed before execution is about 21% of SPARC code size for gcc; an executable form is roughly gzip-sized for x86 and can be interpreted without decompression.
- Applicable idea: separate the "wire" (compressed, decode before use) from the in-memory form. HBC is the same split: decoding the wire form into the exact .hbc is a step before mmap.

**Lua bytecode** [F]. No formal study. lua-l 2008 (Kein-Hong Man): stripped `luac -s` output compresses to 33.7% (64,930 to 21,867 bytes) while the source compresses to 22.7% (130,162 to 29,546). Campbell (lua-l 2009): a 1.4 MB source tree compresses with LZMA to 183,262 bytes, its bytecode archive to 265,289 bytes. Thread: https://lua-users.org/lists/lua-l/2008-03/msg00139.html. Applicable idea: bytecode compresses worse relative to source. This matches the corpus (HBC 2.7–3.0x vs JS 5.2–5.4x) and suggests the same cause (binary, low-redundancy encodings).

**Dalvik DEX / APK** [S]. No measured DEX bytecode compression study was found. The AOSP dexopt note says per-class files repeat strings heavily, which is why classes are merged: https://android.googlesource.com/platform/dalvik.git/+/refs/heads/jb-dev/docs/dexopt.html. Redex (Meta, 2015) renames identifiers and strings to short generated names to shrink DEX, with no published percentage in the retrieved text: https://engineering.fb.com/2015/10/01/android/optimizing-android-bytecode-with-redex/. Applicable idea: name shortening is not available for HBC (the names are runtime-visible property keys), but string-table sharing is.

**Hermes itself** [P].
- 2019 launch post: https://engineering.fb.com/2019/07/12/android/hermes/. Whole-program passes "such as function deduplication and string table packing"; compressed bytecode is "a bit larger than compressed JavaScript source code"; bytecode is mapped into memory and interpreted "without needing to eagerly read the entire file"; debug builds generate bytecode lazily on device, while release builds are ahead-of-time.
- Per that post, on-device generation applies to debug builds, which suggests shipping JS and compiling on device is not a release option (an inference; out of scope).

**Xz / LZMA filters and literal contexts** [P]: https://man.archlinux.org/man/xz.1
- `lc` (0–4, default 3), `lp` (0–4, default 0), `pb` (0–4, default 2; 2^pb alignment, default four bytes). The man page says pb=2 "is often a good choice when there's no better guess".
- BCJ filters (x86 alignment 1; ARM 4; ARM64 4; IA-64 16) "convert relative addresses in the machine code to their absolute counterparts". They are always reversible, and they go before the final filter.
- Delta filter: byte-wise delta with distance 1–256.
- Applicable ideas: (a) for HBC jumps (relative Addr8/Addr32), a BCJ-style conversion to absolute or block-ordinal targets makes repeated targets identical; (b) the instruction stream is not 4-byte aligned, so pb=2 will not help the stream but may help the 16-byte function header table; test per section (E1).

### 2.2 WebAssembly

- No measured study of splitting `.wasm` into streams before compression was found. Searches returned forum posts, tutorials and a Go wiki revision. Treat all of this as [F].
- Go wiki anecdote (older revision): a roughly 2 MB module gzips to about 500 KB; a 16 MB module gives brotli 2.4 MB, Zopfli 3.3 MB, gzip --best 3.4 MB. Page: https://go.googlesource.com/wiki/+/bee185a6ea8d756f74120d4979c0df12b93cd58e%5E%21.
- An unofficial copy of the Wasm binary-encoding notes describes a structure-aware second tier that reorders values and removes identical subtrees, without numbers: https://github.com/informaticacba/WebAssambly.Design/blob/main/BinaryEncoding.md.
- Gap: no published split-vs-unsplit wasm measurement. This is worth a short experiment on the HBC side rather than waiting for wasm literature.

### 2.3 General techniques

**Stream splitting / byte-stream split** [S/F]. Lance's byte-stream-split encoding reorders bytes so each position is its own stream, with the note that reordering alone shrinks nothing until a general-purpose compressor runs afterwards: https://docs.rs/lance-encoding/9.0.1/src/lance_encoding/encodings/physical/byte_stream_split.rs.html. No gzip or zstd numbers were found; Parquet's BYTE_STREAM_SPLIT and HDF5 shuffle are the usual references (not retrieved). Pack200 is the closest measured analogue (section 2.1).

**Delta coding of monotonic offset tables** [P, via Pack200 spec]: UDELTA5 is defined for monotonic sequences. HBC function headers have a `offset` (25-bit) that is a running sum of sizes; the sizes are the deltas. [E] Expect most of the 4.8% function-header share to become near-zero residuals.

**Recompute instead of store** [M]: footer (SHA-1 of the prefix) and `sourceHash` (SHA-1 of the JS). Only the footer is recomputable without the JS. Other candidates: the small string table (derivable from storage layout and kinds if the packer order is known), identifier hashes (if the function is known, technique 5), and the function-header fields (technique 4).

**Context modeling with opcode as context** [S/F]. The PPM literature gives the principle: PPM beats gzip on text (about 4.6 vs 3.4 on one NYU lecture test; PPM encode 2.2 s vs gzip 60 ms): https://cs.nyu.edu/home/people/in_memoriam/roweis/csc310-2005/notes/lec11x.pdf. A simple binary arithmetic model on the previous 20 bits landed generally within about 10–15% of gzip on the Auckland paper's test set: https://www.cs.auckland.ac.nz/~peter-f/FTPfiles/PPMnoEsc.pdf. PPM_cc conditions predictions on a compressed context to cut memory: https://arxiv.org/pdf/1211.2636. None is bytecode-specific. The HBC version of the idea is operand distributions conditioned on opcode and operand index. Measure it (E3).

**Move-to-front / recency ranking** [P]: Bentley, Sleator, Tarjan, Wei (CACM 1986). "We prove that it never performs much worse than Huffman coding and can perform substantially better"; single-pass. Tech report: https://www.cs.princeton.edu/research/techreps/532. Applicable idea: MTF or recency ranks for string IDs and function IDs inside each operand stream (E3 compares MTF against plain IDs with opcode contexts).

**Dictionaries for small and medium files** [P]:
- zstd README "small data" section: "Using this dictionary, the compression ratio achievable on small data improves dramatically", and "Dictionary gains are mostly effective in the first few KB" (https://github.com/facebook/zstd).
- zstd 2016 post: small-data compression "can range anywhere from 2x to 5x better than compression without dictionaries". In their example a shared 65 KB dictionary moved a 1,000-record set from about 300 KB (gzip or zstd per file) to 122 KB, "from 2.8x to 6.9" (https://engineering.fb.com/2016/08/31/core-infra/smaller-and-faster-data-compression-with-zstandard/).
- zstd man page: `--train` samples should number over 100 and total about 100x the dictionary size; only the first 128 KiB of large samples are used; default `--train` is `--train-fastcover=d=8,steps=4`; `--maxdict` default 112,640 bytes; `--patch-from` is "effectively dictionary compression with some convenient parameter selection"; `--long` defaults to windowLog 27, maximum 31 (https://github.com/facebook/zstd/blob/dev/programs/zstd.1.md).
- COVER (Liao, Petri, Moffat, Wirth, WWW 2016): https://dl.acm.org/doi/10.1145/2872427.2883040 returned HTTP 403; its results were not read. Do not quote COVER numbers.
- Brotli's built-in static dictionary is 122,784 bytes, with 121 transforms per word and copy lengths 4–24 (RFC 7932: https://www.rfc-editor.org/rfc/rfc7932). It is English and web-oriented; the HBC analogue is a custom dictionary of RN, Hermes and JS identifiers.
- IETF compression-dictionary transport (HTTP): a draft lets a client advertise and use dictionaries over HTTP for Brotli and Zstandard. (Revisions 13 to 18 appear in search results; the link cited here is revision 16.) Chrome 130 support is reported [F, DebugBear]: https://www.debugbear.com/blog/shared-compression-dictionaries. Relevant as a delivery mechanism for a shared dictionary, not a ratio result.

### 2.4 Entropy coding and LZ speed

**ANS / tANS / FSE** [P]. Duda (arXiv 1311.2540): "about 50% faster decoding than HC for 256 size alphabet", with compression "similar" to arithmetic coding; table memory "a few kilobytes". https://arxiv.org/abs/1311.2540.

**FSE / Huff0 (Collet)** [P]: https://github.com/Cyan4973/FiniteStateEntropy. Benchmark on an i7-5600U, 32 KB blocks, compression / decompression MB/s:
- Proba80: Huff0 ratio 6.38 at 600 / 1350 MB/s; FSE ratio 8.84 at 325 / 440 MB/s; zlibh ratio 6.38 at 265 / 300 MB/s.
- Proba14: Huff0 1.90 at 595 / 860; FSE 1.91 at 330 / 460; zlibh 1.90 at 255 / 250.
- Proba02: Huff0 1.13 at 525 / 555; FSE 1.13 at 325 / 445; zlibh 1.13 at 180 / 210.
- Reading: on skewed synthetic data, FSE output is about 28% smaller than Huff0's (ratio 8.84 vs 6.38) at roughly one third of Huff0's decode speed, but still 440 MB/s. That speed clears the target. The README does not compare decode speed to zstd.

**Interleaved rANS (Giesen)** [P]: arXiv 1402.3392, https://arxiv.org/pdf/1402.3392. Relative to serial rANS decode: 2-way interleave 1.6–1.9x faster; 8-way SIMD 2.2–2.8x. Example: book1 about 219 MiB/s serial, 365 MiB/s 2-way, 566 MiB/s SIMD. Hardware is not stated in the excerpt; check the PDF before quoting absolute numbers. Multi-core rANS scaling issues are discussed in Recoil (arXiv 2306.12141).

**LZ and general-purpose speed** [P]: lzbench on silesia.tar, single thread, AMD EPYC 9555P (https://github.com/inikep/lzbench). The README's ratio column is compressed size as a percent of input (I checked: 48,766,532 / 211,938,580 = 23.01%):
- xz 5.8.4 -9: compress 2.75 MB/s, decompress 122 MB/s, 48,766,532 bytes.
- lzma -9: 2.55 MB/s, 78.2 MB/s, 48,682,482 bytes.
- brotli 1.2.0 -11: 0.56 MB/s, 383 MB/s, 50,407,795 bytes.
- zstd 1.5.7 -22: 1.99 MB/s, 1,087 MB/s, 52,284,290 bytes.
On silesia.tar (a mixed corpus), xz -9 is smallest. On our HBC corpus, brotli-11 is smallest and zstd-22 is about 7% larger. Both are real; the difference is the data.

**Large-text benchmark (LTCB, enwik9)** [P]: http://mattmahoney.net/dc/text.html. Compressed bytes and decode time (ns/byte converted to throughput; machines differ):
- xz 5.2.1 -9e-like (lc=4, pb=0, 1 GiB dict): 197,331,816 bytes; decode 20 ns/byte (about 50 MB/s).
- brotli -q 11 -w 24: 223,597,884 bytes; decode 5.9 ns/byte (about 170 MB/s).
- zstd 0.6.0 -22 --ultra: 215,674,670 bytes; decode 2.2 ns/byte (about 450 MB/s).
- zpaq 6.42 (max method): 142,252,605 bytes; decode 14,739 ns/byte (about 68 KB/s).
- paq8px_v206fix1 -12L: 124,696,410 bytes; decode 294,847 ns/byte (about 3.4 KB/s).
- cmix v21: 107,963,380 bytes; decode 638,442 ns/byte (about 1.6 KB/s).
Reading: the CM outputs are 1.4–1.8x smaller than xz -9e on enwik9, but decode is three to four and a half orders of magnitude slower. A CM backend is not admissible; use it only as a ratio ceiling on split streams (E10).

**Oodle (RAD)** [F]: vendor claims of "often 10× faster to decode than competition with comparable compression ratio", no numbers or design details: https://www.radgametools.com/oodle.htm. Not usable as evidence.

**Parallel decode for multi-core** (for completeness): lzbench multi-thread zstd-22 decodes at 7,300 MB/s on 8 threads and lzma at 425 MB/s (same page). Per-stream independent blocks would allow this for HBC if the file were split into independently decodable streams; OTA apps probably decode on a phone with 4–8 cores, but single-thread numbers matter first.

### 2.5 JavaScript bundles, OTA updates, Hermes internals

**Expo bytecode diffs** [S/F]. SDK 55 changelog: https://expo.dev/changelog/sdk-55.md. The client "can request and apply binary patches (diffs) to the previously installed bytecode files". Opt-in, enabled with `enableBsdiffPatchSupport`; "It's estimated that diffs will result in an approximately 75% reduction" in download times. The algorithm is only named in the flag (bsdiff). The 75% is an estimate.

**react-native-update** [F]: vendor README (https://cdn.jsdelivr.net/npm/react-native-update@10.56.0/README.md) says patches are typically tens to hundreds of KB, versus tens of MB for full-bundle systems, with no independent benchmark.

**@d11/dota** [F]: a CodePush-service plugin that passes the previous bundle to the Hermes compiler as a base for delta optimization (`DOTA_BASE_BUNDLE_PATH`). No size figures (https://socket.dev/npm/package/@d11/dota). It shows the `-base-bytecode` path is used in production tooling.

**Hermes string design (Strings.md)** [P]: https://raw.githubusercontent.com/facebook/hermes/main/doc/Strings.md.
- String kinds are run-length encoded: predefined, identifier, string. Within each length tier they are ordered Strings, then Identifiers, then Predefined.
- Strings are (offset, length) pairs into a character buffer. Packing uses a greedy shortest-common-superstring heuristic built on a generalized suffix array to share substrings, which is what the string storage in these files reflects (about 224 KB per app).
- Identifier hashes: "If the string is an Identifier, the element contains a hash of the identifier's string representation." The runtime uses the precomputed hash to insert into `IdentifierTable` without reading the string. Predefined identifiers map to fixed IDs.
- Delta-optimizing mode keeps existing string order.
- Applicable ideas: (a) the string kinds are the natural split for string modeling (identifiers vs strings); (b) the shortest-superstring packing already captures within-file substring redundancy, so a per-file LZ over string storage gains less than expected; (c) the predefined-identifier table is a built-in dictionary the decoder can reuse.

**Hermes header and function header** [P]: https://raw.githubusercontent.com/facebook/hermes/main/include/hermes/BCGen/HBC/BytecodeFileFormat.h.
- Header fields and the section order listed in section 1.1. Footer is "Hash of everything above the footer" (SHA-1).
- SmallFuncHeader is 16 bytes in the excerpt (the files use 12-byte records; see 1.1): offset 25 bits and paramCount 7 bits; bytecodeSizeInBytes 15 bits and functionName 17 bits; infoOffset 25 bits and frameSize 7 bits; environmentSize, two cache indices, and flags. Overflowed functions store the large-header offset in the small header's offset and infoOffset fields.
- Identifier hashes: "Array<uint32_t> identifierHashes" with one entry per identifier.

**Hermes instruction encoding** [P]: https://raw.githubusercontent.com/facebook/hermes/main/include/hermes/BCGen/HBC/BytecodeList.def. Operand types: Reg8, Reg32, UInt8, UInt16, UInt32, Imm32, Addr8, Addr32, Double. Opcodes are numbered in macro order. Many ops have short and long forms (`Mov`/`MovLong`, `GetByIdShort`/`GetByIdLong`), and jumps have Addr8 and Addr32 variants. The opcode byte width is not stated in the fetched excerpt; E2 settles it.

Applicable idea: the width is chosen by the operand value, so the encoder can drop the short/long choice if it is a deterministic function of the value (verify in E2). This is a recompute-instead-of-store opportunity (technique 8).

**Hermes runtime file access** [P]: the 2019 post says the bytecode "can be mapped into memory and interpreted without needing to eagerly read the entire file". So the decompressor must produce the exact .hbc on device before the runtime maps it. Decompression is a per-file step, not a lazy one.

**Hermes source tree** [P]: https://github.com/facebook/hermes/tree/main/doc has no HBC format document; the format is in the headers above.

---

## 3. Ranked list of the 10 most promising techniques

Expected gains are relative to xz -9e on HBC (65.8 MB) and are estimates [E] unless noted. Decode cost is relative to brotli-11's 351 MB/s median decode, which is the floor. Effort is my judgment.

### 1. Typed stream split of the instruction stream, with opcode-conditioned operand models
- **Gain [E]:** 10–20% below xz -9e (roughly 6–13 MB of the 65.8 MB).
- **Basis:** function bodies are 74% of bytes, and Pack200 is built on the same idea, one band per field class [P].
- **Decode cost [E]:** table-driven; per-stream tANS/rANS; should reach hundreds of MB/s. Anchor: FSE 440 MB/s (i7-5600U) [P].
- **Effort:** high. Needs a v98 instruction decoder with an exact re-encode for all 812,810 functions.
- **Risks:** instruction set changes across hermesc versions; the exact re-encode is the gate; the 74% remainder includes exception tables whose layout must also be decoded.

### 2. Canonical per-file index spaces (string IDs, function IDs) with reference pools
- **Gain [E]:** 5–15% on top of technique 1, larger once a dictionary is used.
- **Basis:** Courgette's sorted-target model gives 8.9x smaller patches than bsdiff on one update [P]; the same index-instability problem is what limits the HBC dictionary gain (14% vs JS 29%) [M + hypothesis].
- **Decode cost [E]:** a permutation lookup per operand; negligible.
- **Effort:** medium-high.
- **Risks:** a stored permutation is expensive. For 4,587 strings, log2(n!) is about 49,000 bits, or 6.1 KB, on the order of 10% of an app's compressed string bytes [E]. Canonical order must be derivable from content (E7). The runtime's predefined IDs are fixed and must not be remapped.

### 3. Shared dictionary primed with RN and Hermes content
- **Gain [M]:** 14% on HBC (zstd-19, 1 MB dictionary, 41 held-out apps). The dictionary bytes are not counted in that result and must be (see metric note).
- **Decode cost [M]:** the zstd-19 + dictionary median decode is 1,036 MB/s, faster than brotli-11.
- **Effort:** low (zstd `--train`, or a custom dictionary over the split streams after technique 1).
- **Risks:** overfits to the 63 training apps; must be retrained per RN version (the corpus spans RN 0.61–0.87, so drift is real); if the dictionary is shipped in the app, it is free per update but not per install.

### 4. Derived and delta-coded function headers
- **Gain [E]:** 2–4% of output. Raw share is 4.8% (9.8 MB).
- **Basis:** `offset` is a running sum of sizes; `infoOffset` likely the same; flags and counts are highly repetitive. Pack200's UDELTA5 is the model [P].
- **Decode cost:** trivial (prefix sums).
- **Effort:** low to medium. Overflowed functions (large headers) need their own path.
- **Risks:** the layout was verified indirectly (see 1.1); field-by-field verification is required (E5).

### 5. Recompute the identifier hashes
- **Gain:** if the function is found and reproduces all hashes, the 3.5 MB of hashes (1.75% raw) costs nothing. If the hashes are random 32-bit values, they are incompressible, so they set a floor of about 3.5 MB, which is about 5% of brotli-11 output. The gain is therefore arithmetic from measured sizes, conditional on the hash being recomputable.
- **Basis:** Strings.md says the hash is of "the identifier's string representation" [P]. The hash function is not in the public docs or the excerpts I read.
- **Decode cost:** hashing each identifier once (fast).
- **Effort:** low once the function is known; finding it is the hard part (E4).
- **Risks:** the hash may depend on a seed or on runtime build details; if so, it stays a floor.

### 6. String storage modeling split by kind
- **Gain [E]:** 2–4% of output. String storage plus small table is 14.3% raw.
- **Basis:** Strings.md's kinds (predefined, identifier, string) give natural splits; identifiers repeat across apps (RN property names) and benefit from a dictionary.
- **Decode cost [E]:** order-1 or order-2 CM on about 23 MB of string bytes per corpus is cheap enough at tens of MB/s, but must be measured; if it is slower than target, use an LZ on the storage.
- **Effort:** medium.
- **Risks:** Hermes's suffix sharing means storage has overlapping strings; modeling must keep the layout exact.

### 7. Typed literal buffers
- **Gain [E]:** 1–2% of output. Array, object key and object value buffers are 4.4% raw.
- **Basis:** these are typed literal arrays (numbers, string references, booleans); typed columns separate well (Pack200 uses this idea for constant pools).
- **Decode cost:** trivial.
- **Effort:** medium; the buffer layout needs a parser.
- **Risks:** small share; low priority.

### 8. Canonical instruction forms and jump targets
- **Gain [E]:** 1–3% of the instruction stream. Recomputing short/long forms from operand values removes a few bits per instruction; converting relative jumps to block ordinals (BCJ-style) makes repeated targets identical.
- **Basis:** BytecodeList.def has paired short and long forms and Addr8/Addr32 jumps [P]; xz BCJ filters convert relative addresses to absolute [P].
- **Decode cost:** negligible.
- **Effort:** medium, depends on technique 1.
- **Risks:** must reproduce hermesc's exact width choice; verified by the re-encode gate.

### 9. Entropy backend choice per stream
- **Gain [E]:** a few percent over zstd-style LZ on the skewed streams. In the FSE README's synthetic case FSE output is about 28% smaller than Huff0's (ratio 8.84 vs 6.38) [P], which will not transfer directly.
- **Decode cost:** interleaved tANS/rANS: hundreds of MB/s (FSE 440 MB/s; interleaved rANS 1.6–2.8x serial per Giesen [P]). Adaptive binary models (LZMA-style): tens of MB/s (xz 122 MB/s silesia decode [P]) are too slow for the target.
- **Effort:** medium; reuse zstd's FSE or a Giesen-style rANS library.
- **Risks:** static tables must be transmitted per file (cost for small streams); use adaptive order-0 for small streams.

### 10. Delta against a base bytecode (the installed version)
- **Gain:** Expo estimates about 75% download reduction for diffs against installed bytecode [S/F]. Not measurable here (one version per app).
- **Basis:** Hermes `-base-bytecode` delta mode [P]; zstd `--patch-from` [P]; bsdiff via Expo [S].
- **Decode cost:** patch application plus decode; must rebuild the exact target file.
- **Effort:** medium; needs version pairs.
- **Risks:** changes the benchmark (per-update vs per-install); requires the device to hold the base; the target still must be byte-exact.

### Not in the top 10, with reasons
- **Full context mixing (paq8, cmix, zpaq high levels):** ratio ceiling about 1.4–1.8x smaller than xz -9e on enwik9 [P], decode 1.6 KB/s to 68 KB/s [P]. Not admissible; use as E10 ceiling only.
- **LZ with optimal parsing alone (zstd-22, brotli-11 style):** already measured; the gains are in the structure, not the parse.
- **Byte-stream split of raw bytes without parsing:** cheap to try (E1) but unlikely to beat parsing the instruction stream; Lance's note says reordering alone shrinks nothing [S].

---

## 4. Proposed architecture

Compression (slow path, may take minutes):

1. **Frame check.** Read magic and version. Known version (98 and any added later) goes to the structured path. Anything else goes to the fallback frame (zstd-19 + dictionary, or brotli-11).
2. **Parse.** Split the file into header, function headers, string kinds, identifier hashes, small string table, overflow table, string storage, literal buffers, bytecode region, function info, debug info, footer.
3. **Decode and re-encode check.** Decode every instruction, then re-encode and compare byte-for-byte with the original section. Any mismatch goes to the fallback. This is the single safety gate.
4. **Canonicalize.** Map string IDs and function IDs through a derivable order (content-based, or Hermes's own ordering if reproducible). Store a permutation only if it is cheaper than the gain.
5. **Field extraction.** Emit typed streams: opcode; per-operand-class streams (register, string ID, function ID, jump target, immediate, double); function-header residuals (deltas and flags); string bytes split by kind; literal columns; identifier hashes (dropped if recomputable).
6. **Modeling.** Operand streams conditioned on opcode and operand index. MTF or recency ranks for IDs (compare in E3). Jump targets as block-relative ordinals. Dictionary priming from the RN/Hermes corpus.
7. **Entropy coding.** Interleaved tANS or rANS per stream, static tables for large streams, adaptive order-0 for small ones. Use zstd or brotli on the string storage if modeling does not beat them.
8. **Container.** Stream directory, versioned, with the fallback flag and a SHA-1 of the output so the decoder can verify before handing the file to Hermes.

Decompression (fast path, must be hundreds of MB/s):
- Read streams, decode each (independent streams can run in parallel).
- Rebuild function headers from residuals and prefix sums.
- Re-insert string IDs through the inverse permutation.
- Re-emit instructions with the chosen short or long forms.
- Recompute the footer (SHA-1, 20 bytes saved per file). Recompute identifier hashes if technique 5 succeeds.
- Verify the output SHA-1 and write the exact .hbc.

Non-goals: no CM in the decode path; no dependency on the JS bundle at decode time (so `sourceHash` is stored).

---

## 5. Experiments, in order

Each experiment has the question it answers. E1, E2 and E4 need no compressor work and should run first.

- **E1. Per-section compressibility.** Write each section out as its own file using the layout in section 1.1, compress each with zstd-19 and brotli-11, and compare with the whole file. Also try pb=2 and lp settings per section with xz. *Question: which sections hold the compressed bytes, and does splitting alone beat monolithic brotli?*
- **E2. Instruction decode and exact re-encode.** Extract the opcode table from BytecodeList.def in macro order; decode all 812,810 function bodies; re-encode; compare byte-for-byte. Record operand-stream sizes. *Question: can the instruction stream be decoded and reproduced exactly? This is the gate for techniques 1, 2, 7 and 8, and it settles the opcode width and the short/long choice rule.*
- **E3. Opcode-conditioned operand entropy.** On E2 output, measure empirical entropy of each operand class with and without opcode and operand index contexts; compare plain IDs against MTF ranks. *Question: how many bits per operand does conditioning save, and is MTF worth it?*
- **E4. Identifier hash identification.** Decode string kinds (3 RLE entries at offset 40,628 in the example file; bit 31 flags identifiers) to get identifier strings; test candidate hash functions (FNV-1a, djb2, MurmurHash3, xxHash32, and any function found in the Hermes source) against the 2,922 stored values; test whether values are random (bit-balance, chi-square). *Question: are the identifier hashes recomputable, or a fixed incompressible floor of about 3.5 MB (about 5% of brotli-11 output)?*
- **E5. Function-header residuals.** Replace each 16-byte header with deltas (offset from previous end, size, infoOffset delta) and predicted flags; measure residual entropy and check overflow cases. *Question: how small is the function-header table once derived?*
- **E6. Cross-app function duplication.** Normalize each function body by mapping string IDs to content and function IDs to a content-derived key; count exact matches across apps, especially shared RN library functions. *Question: how much byte-identical code exists across apps once index spaces are canonical? This tests the central hypothesis for why dictionaries help JS more than HBC.*
- **E7. Derivability of hermesc's string order.** Test whether the observed order of strings in the table can be reproduced from content (kind, length tier, lexicographic, first-use order, or suffix-sharing rules from Strings.md). *Question: can the permutation be derived, or must it be stored (about 6 KB per 4,587 strings)?*
- **E8. Dictionary on split streams.** Train zstd dictionaries per split stream (and one global dictionary) on the 63 train apps; test on the 41 test apps; count dictionary bytes once. Compare against the existing 14% result. *Question: does structure plus dictionary beat brotli-11 by 10% or more on held-out apps?*
- **E9. Backend speed.** Implement or wire an interleaved tANS/rANS over the E8 streams; measure decode MB/s single-thread on this machine. *Question: does the full decode path meet hundreds of MB/s, and what does static-table transmission cost?*
- **E10. Context-mixing ceiling.** Run a small CM (a few contexts, e.g., an lpaq-like model or zpaq with a fast method) on the split streams. *Question: how much ratio is left above E8, and at what decode speed? Use only as a bound.*
- **E11. Delta pairs.** Obtain two versions of several repos (earlier commit, same toolchain), build both, and measure `zstd --patch-from`, `hermesc -base-bytecode` and bsdiff on the HBC pairs. *Question: what is the realistic OTA size, and does delta beat the single-file structure?*
- **E12. Version robustness.** Compile a sample of bundles with another hermesc release (different bytecode version) and confirm the parser rejects or falls back cleanly. *Question: is the fallback path exercised, and does it stay lossless?*

---

## 6. Gaps, unverified items, and folklore

### 6.1 Not found or not verified
- Pugh 1999 full text and exact per-benchmark numbers (UMD page not fetchable; TLS error).
- Pack200 band-level measured ratios per class type (only the spec's aggregate claims).
- Slim Binaries numbers (CACM 1997 abstract not retrieved).
- COVER (WWW 2016) numbers (ACM page returned 403).
- Dex/APK bytecode compression studies.
- Lua and .NET bytecode compression studies (only forum anecdotes for Lua).
- WebAssembly stream-splitting measurements.
- Redex string-dedup size numbers.
- A Hermes identifier-hash function (not in public docs or the excerpts I read).
- Interleaved rANS hardware details (arXiv excerpt only).

### 6.2 Open or conflicting observations
- My reading of the debugInfoOffset field (offset 108) differs from the fetched BytecodeFileFormat.h excerpt (which listed it at 104). The data supports 108 (value equals fileLength - 36). Re-check against the Hermes source before relying on it.
- The identifier-hash array is at 40,640 (corrected). Its 2,922 values are all distinct, top-nibble counts are roughly uniform, and the share with top byte < 0x40 is 25.4%, all consistent with random hashes. That is evidence, not proof: recomputability is still open (E4).
- Resolved: the string-kinds entries decode (bit 31 = identifier flag, low 31 bits = count), and identifier runs sum to identifierCount (section 1.1).
- Retracted: my earlier layout (function headers 16 B, small table at 65,828) was wrong. The 16-byte figure came from the excerpt, not from the files. The corrected layout (12 B headers, small table at 52,328) is confirmed by the JS-match test.
- The "about 50% faster decode than Huffman" figure (Duda) is quoted from the abstract's citation of a recent implementation, not measured by Duda.
- lzbench's ratio column is a percent of input, not a ratio (I verified this with the silesia size).
- LTCB times are in ns/byte on different machines; the throughput conversions are approximate.

### 6.3 Folklore and vendor claims (not usable as evidence)
- "LZMA decodes in tens of MB/s" is supported by lzbench and LTCB numbers in this document, not by folklore.
- Oodle "10x faster decode" (RAD) and react-native-update's "3.4 KB one-line patch" are vendor claims.
- The 75% Expo diff figure is an estimate by the vendor.
- The 2–5x Pugh-vs-gzip gain and the Pack200 7–9x figure are from the authors or specs, not independent benchmarks.
- The "Hermes bytecode is smaller than JS" argument is not supported: the corpus shows HBC is 2.0x the compressed JS size (summary.md).

### 6.4 Out of scope but worth a note
- Shipping JS and compiling on device would avoid bytecode transfer entirely, but the Hermes blog describes on-device generation only for debug builds [P]. Not an OTA option unless release runtimes change.

---

## 7. Sources

Primary (read):
- Hermes header and format: https://raw.githubusercontent.com/facebook/hermes/main/include/hermes/BCGen/HBC/BytecodeFileFormat.h
- Hermes instruction list: https://raw.githubusercontent.com/facebook/hermes/main/include/hermes/BCGen/HBC/BytecodeList.def
- Hermes strings: https://raw.githubusercontent.com/facebook/hermes/main/doc/Strings.md
- Hermes doc directory: https://github.com/facebook/hermes/tree/main/doc
- Hermes 2019 post: https://engineering.fb.com/2019/07/12/android/hermes/
- Pack200 spec: https://docs.oracle.com/javase/8/docs/technotes/guides/pack200/pack-spec.html
- JSR 200 proposal: https://jcp.org/en/jsr/detail?id=200
- JEP 367: https://openjdk.org/jeps/367
- Courgette: https://www.chromium.org/developers/design-documents/software-updates-courgette
- Zucchini README: https://chromium.googlesource.com/chromium/src/+/HEAD/components/zucchini/README.md
- xz man page (LZMA options, BCJ, delta): https://man.archlinux.org/man/xz.1
- RFC 7932 (Brotli): https://www.rfc-editor.org/rfc/rfc7932
- zstd README: https://github.com/facebook/zstd
- zstd man page: https://github.com/facebook/zstd/blob/dev/programs/zstd.1.md
- zstd 2016 post: https://engineering.fb.com/2016/08/31/core-infra/smaller-and-faster-data-compression-with-zstandard/
- FSE README: https://github.com/Cyan4973/FiniteStateEntropy
- Duda ANS (arXiv 1311.2540): https://arxiv.org/abs/1311.2540
- Giesen interleaved entropy coders (arXiv 1402.3392): https://arxiv.org/pdf/1402.3392
- Recoil (arXiv 2306.12141): https://arxiv.org/pdf/2306.12141
- lzbench: https://github.com/inikep/lzbench
- LTCB: http://mattmahoney.net/dc/text.html
- Expo SDK 55 changelog: https://expo.dev/changelog/sdk-55.md
- Corless thesis (abstract): https://dspace.library.uvic.ca/items/63a8b2cf-7b73-459f-bb0d-ac03a6e7da5d
- Bentley et al. 1986 (tech report): https://www.cs.princeton.edu/research/techreps/532
- Oodle page (vendor claims): https://www.radgametools.com/oodle.htm

Search-summary or secondary (not fetched in full):
- Pugh 1999: https://www.cs.umd.edu/~pugh/java/latex2html/pack/node1.html
- Code Compression (PLDI 1997) record: https://experts.azregents.edu/en/publications/code-compression-2/
- Slim Binaries: https://wiki.tcl-lang.org/page/Slim+Binaries
- COVER paper (403): https://dl.acm.org/doi/10.1145/2872427.2883040
- Lance byte-stream-split docs: https://docs.rs/lance-encoding/9.0.1/src/lance_encoding/encodings/physical/byte_stream_split.rs.html
- PPM vs gzip notes (NYU): https://cs.nyu.edu/home/people/in_memoriam/roweis/csc310-2005/notes/lec11x.pdf
- PPM simple model (Auckland): https://www.cs.auckland.ac.nz/~peter-f/FTPfiles/PPMnoEsc.pdf
- PPM_cc (arXiv 1211.2636): https://arxiv.org/pdf/1211.2636
- Redex 2015: https://engineering.fb.com/2015/10/01/android/optimizing-android-bytecode-with-redex/
- AOSP dexopt note: https://android.googlesource.com/platform/dalvik.git/+/refs/heads/jb-dev/docs/dexopt.html
- Lua-l 2008 thread: https://lua-users.org/lists/lua-l/2008-03/msg00139.html
- Go wiki (wasm size anecdote): https://go.googlesource.com/wiki/+/bee185a6ea8d756f74120d4979c0df12b93cd58e%5E%21
- Wasm binary-encoding notes (unofficial copy): https://github.com/informaticacba/WebAssambly.Design/blob/main/BinaryEncoding.md
- IETF compression dictionary transport draft: https://www.ietf.org/archive/id/draft-ietf-httpbis-compression-dictionary-16.xml
- DebugBear on shared compression dictionaries: https://www.debugbear.com/blog/shared-compression-dictionaries
- react-native-update README (vendor): https://cdn.jsdelivr.net/npm/react-native-update@10.56.0/README.md
- @d11/dota (plugin): https://socket.dev/npm/package/@d11/dota

Local files (read or computed):
- `/Users/wintonchen/Desktop/kodespire-compression/hermes-corpus/README.md`
- `/Users/wintonchen/Desktop/kodespire-compression/hermes-corpus/results/summary.md`
- `/Users/wintonchen/Desktop/kodespire-compression/hermes-corpus/manifest.json`
- `/Users/wintonchen/Desktop/kodespire-compression/hermes-corpus/harness/node_modules/hermes-compiler/hermesc/osx-bin/hermesc` (`-help` only)
- `/Users/wintonchen/Desktop/kodespire-compression/hermes-corpus/bundles/*/index.android.hbc` (header and section computations, 104 files)
