# Validation notes: HBC v98 reference (hermes @ 7f41c525, hermes-compiler 250829098.0.9)

Companion to `SPEC.md`. Ref and provenance are in `COMMIT.txt`.

## 1. What `hermesc -b -dump-bytecode -pretty` prints

Command: `harness/node_modules/hermes-compiler/hermesc/osx-bin/hermesc -b -dump-bytecode -pretty FILE.hbc`

- **Bytecode File Information:** version, source hash, function count, string count, BigInt count, StringKind entry count, RegExp count, StringSwitchImm count, segment ID, CJS counts, function source count, option flags. It does **not** print byte offsets, fileLength, debugInfoOffset, the footer, section sizes, or padding.
- **Global String Table:** `iN[ASCII|UTF16, start..end] #HHHHHHHH: text` for identifiers (`#` is the identifier hash in hex), and `sN[...]: text` for other strings. `end` is inclusive.
- **Global BigInt Table:** `N[start..end]: value`.
- **Literal Value Buffer / Object Key Buffer:** decoded values (`[String n]`, `[int n]`, `null`, ...).
- **Object Shape Table:** `N[keyBufferOffset, numProps]`.
- **Function Source Table:** `Function ID F -> sS`.
- **Per function:** `Function<name>(P params, R registers, N numbers, M non-pointers):` or `NCFunction<...>` for non-constructors. Then `Offset in debug table: source 0x....`, instruction lines (4-space indent, mnemonic first), `Lk:` labels at jump targets, and `Exception Handlers:` with `i: start = Lx, end = Ly, target = Lz` (labels are instruction offsets).
- **Debug tables** (only if debug info is present): `Debug filename table:`, `Debug file table:` (`source table offset 0x....: filename id N`), `Debug source table:` (`0xOFF  function idx N, starts at line L col C`, then `bc ADDR: line L col C` per location), ending with `0xEND  end of debug source table`.

Not printed: body offsets, function header offsets, the dedupe mapping, switch table bytes, StringKind runs, and string storage offsets (except as `[start..end]`).

### Dump artifacts a parser of the dump must handle

1. **Raw newlines inside string operands.** A string containing a newline is printed unescaped, so the next physical line can begin with an opcode-like word (`in "` after `LoadConstString r15, "`) or look like a section heading (`Differences:`). Seen in 9 functions in comoser and 5 in another corpus file.
2. **Class constructors have no header line.** Their instructions appear right after the preceding function's listing. In the broad sample, 17 headers are printed for 19 functions (the `Base` and `Derived` constructors are missing). Their instruction streams are correct: the concatenation of all decoded instructions equals the dump's full instruction sequence.
3. Names can contain angle brackets and spaces, for example `Function<<static_elements_initializer:Derived>>` and `Function<get g>`.

## 2. How the checks were run

`validate-hbc.mjs` (this directory) is an independent parser written from `SPEC.md`:
1. Reads the header and walks the sections using only the header counts.
2. Verifies magic, version, fileLength, and the footer SHA-1 over `[0, fileLength-20)`.
3. Decodes every function header (small and overflowed), the large headers, exception tables, and debug offsets. Checks that the info region ends at `debugInfoOffset`.
4. Recomputes identifier hashes from string storage and StringKind runs and compares them with the dump's `#HEX` values.
5. Decodes each function's instructions with `opcodes.json` and compares the mnemonic sequence with the dump's listing for that function. If the dump's header count differs from the file's (artifact 2 above), it compares the whole-file instruction sequence instead.
6. Compares header fields (paramCount, frameSize, numberRegCount, nonPtrRegCount) with the dump's `(P params, R registers, N numbers, M non-pointers)`.
7. Checks that every jump target (Addr8/Addr32) is an instruction boundary.
8. When debug info is present, decodes the debug stream and compares each function's (bytecode address, line, column) list with the dump's `Debug source table`.

Driver, run for every corpus file (inline, not saved as a file):
```
hermesc -b -dump-bytecode -pretty FILE > dump.txt
node validate-hbc.mjs FILE dump.txt hbc-pack/ref/opcodes.json
```

Samples compiled locally with the same pinned hermesc (compile only, no build tools). Compiled into a scratch directory, not the repo:
- `sample.js`: `-emit-binary` with default `-g1`; `-g0`; `-g` (= `-g2`); `-output-source-map`.
- `sample2.js` (classes with private fields and static blocks, generators, async, destructuring, spread, optional chaining, BigInt, regexp, tagged template, try/catch/finally, string switch, typed arrays): with and without `-O`. **The two outputs are byte-identical** (cmp), so `-O` added no coverage here.

## 3. Results

| Check | Result |
|-------|--------|
| Corpus files validated | 104 of 104 pass (all version 98) |
| Functions with decoded instruction sequence identical to the dump | 812,810 of 812,810 |
| Footer SHA-1 over file prefix | 104/104 corpus files; all samples |
| fileLength equals file size | all files |
| Identifier hashes (SPEC 7.2) vs dump `#HEX` | every identifier in every corpus file, including UTF-16 identifiers (5,632) |
| Function header field values vs dump | every function (overflowed ones read from the large header) |
| FunctionName text vs dump name | 3,443 of 3,443 (one corpus file) |
| Jump targets on instruction boundaries | 0 failures |
| Exception handler entries (start, end, target) | 85,155 entries in 38,147 functions, all on boundaries (end may equal function end) |
| Switch tables | 2,024 functions; contiguous from `align4(end of opcodes)`; 73 functions with several tables |
| UIntSwitchImm targets (int32, relative to ip) | 36,347 of 36,347 on boundaries |
| StringSwitchImm targets (int32, relative to ip) | 19,947 of 19,947 on boundaries |
| StringSwitchImm caseIndex | exactly `0..numStringSwitchImms-1`, each once, in all 101 files with string switches |
| Literal tag decoding | 245,875 array and 768,161 object literals decode to exactly their element counts; 766,348 objects have all-string keys, the rest have integer or double keys |
| Function body contiguity | 104/104 files: no gaps, no overlaps |
| Dedupe | 138,453 functions reuse an earlier body; 674,357 unique bodies |
| Zero-size bodies | 7,870 functions, offset equals the start of the next body |
| Overflowed small headers | 630,196; flags byte `0x20`; every other field except the encoded offset and name bits is zero |
| Overflow cause | FunctionName >= 256 in 624,680 of 630,196; exception handlers in 38,147; other widths in the rest |
| Padding is zero | header bytes 113..127, every pad4 gap, every pre-table gap, every info-record gap, and the gap before debugInfoOffset: 0 non-zero bytes in 108 files (104 corpus + 4 samples) |
| Debug data, `-g1` sample | 2 functions, 61 locations, match the dump exactly |
| Debug data, `-g2` sample | 2 functions, 80 locations, match the dump exactly; 26 entries use the statement-delta bit (`ldelta & 2`). No envIdx deltas (no scopes). |
| Debug stripping (`-g0`, `-output-source-map`) | validator passes; debugInfoOffset non-zero; 16-byte zero header; no per-function debug offsets |
| BigInt storage | `12345678901234567890` stored as 9 bytes, little-endian with sign byte |
| Source hash | header hash equals SHA-1 of `bundles/comoser__rn-background-location/index.android.bundle` |
| Opcode table coverage | 179 of 219 opcodes occur in the corpus or samples; 40 do not (widths from `.def` only) |
| Table from the static_h ref applied to the corpus | fails: 3,688 problems, 3,418 mismatched functions, 1,864 jump targets off boundaries, unknown opcode bytes (the table from 7f41c525 gives 0) |
| CacheNewObject usage | 10,855 instructions across all 104 corpus files (opcode byte 15) |

## 4. What differs from the brief or from older public descriptions

1. **DebugOffsets is 4 bytes.** It holds only `sourceLocations`. There is no `lexicalData`, and the scoping table (the target of `envIdx`) is never written, so `envIdx` in the debug stream refers to nothing in the file.
2. **SmallFuncHeader widths** differ from the brief's guessed list. Actual: Offset 25, ParamCount 5, LoopDepth 2; BytecodeSizeInBytes 14, FunctionName 8, NumberRegCount 5, NonPtrRegCount 5; FrameSize 8; ReadCacheSize 8; WriteCacheSize 6, NumCacheNewObject 1, PrivateNameCacheSize 1; flags byte: ProhibitInvoke 2, StrictMode 1, HasExceptionHandler 1, HasDebugInfo 1, Overflowed 1, Kind 2.
3. **FunctionName is 8 bits in the small header.** Names with string ID 256 or more force the large header. In an overflowed small header, the 25-bit Offset field holds the low 24 bits of the info offset and the FunctionName field holds the high 8 bits; all flags are zero. Bytecode offset and size exist only in the large header.
4. **Switch tables are placed by a relative offset to an unaligned address.** `align4(ip + rel)` is the table start. Multiple tables in one function are stacked after the opcodes.
5. **Literal operands are byte offsets, not indices** (the `.def` comment says "index"). `ISel.cpp` names them `valueBufferOffset`, and decoding confirms it.
6. **Numeric keys live in the key buffer** as integer or double tag values.
7. **Identifier hash** is a plain Jenkins one-at-a-time update with no final avalanche step.
8. **String and literal storage are packed.** The optimizer may share substrings or overlap blobs, so offsets are authoritative; do not assume concatenation.
9. **Zero-size function bodies** are common (7,870). Their offset is not a gap.
10. **Branch facts (corrected).** facebook/hermes's default branch is `static_h`. Its head (2026-10-21) has BYTECODE_VERSION 99. `main` is a separate lineage whose head (2026-10-19) has BYTECODE_VERSION 96, as the coordinator said. The release tag is on the static_h line (forked at f253d5fa). The last version-98 commit on static_h before the bump, 639e5d6, is not the release: it removes CacheNewObject and shifts opcode numbers. Applying its table to the corpus fails (see section 3). The release tag was used instead.
11. **Static Hermes-specific additions.** The source alone does not separate these from the general format. Fields and opcodes present at this version include CacheNewObject with NumCacheNewObject, PrivateNameCacheSize, the private-name opcodes, and the StaticBuiltins and CjsModulesStaticallyResolved option bits. I did not confirm which are Static Hermes-only.
12. **`SimpleBytecodeBuilder` is a different writer.** It emits no literal, shape, or key sections and writes `DebugOffsets{0}`. It is a utility rather than the `hermesc` path, and its output is not what `hermesc` produces.

## 5. Gaps and caveats

- The corpus has no debug-info-bearing files, so the debug stream was checked only with the locally compiled samples (`-g1` and `-g2`). The envIdx delta path was never exercised (no scopes in the samples).
- No corpus file or sample uses CommonJS module tables, so that layout is from source only.
- No RegExp storage was parsed (the compiled regex format is not covered here).
- 40 opcodes never appear in the tested files, so their operand widths are from `BytecodeList.def` only. The same operand-type rules verified elsewhere apply to them.
- `hermesc` output does not show offsets, so body and table placement were confirmed by decoding and consistency checks, not by comparing offset text.
- The sourceHash check used one file. The rule for multi-file input (concatenation in order) follows `processSourceFiles` in `CompilerDriver.cpp` and was not exercised.
- `-O` made no difference to the broad sample's output, so the deduplication path is exercised only by the corpus, which was built with optimization.
