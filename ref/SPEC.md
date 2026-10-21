# Hermes bytecode (HBC) version 98: on-disk layout

Reference: facebook/hermes commit `7f41c52586c320ef8341fa3a7ba10c6c3212bc6f` (tag `hermes-v250829098.0.9`), the revision that `hermes-compiler@250829098.0.9` was built from. See `COMMIT.txt` for why this ref and not the `static_h` ref suggested in the brief.

Conventions
- All integers are little-endian. Offsets are absolute byte offsets from the start of the file unless stated.
- `pad4` means: append zero bytes until the absolute file offset is a multiple of 4. The writer uses `writeBinary('\0')`, so padding is zero bytes that are included in the footer hash.
- `[V]` = verified against the 104 corpus files and four locally compiled samples (by `validate-hbc.mjs` and by comparison with the pinned `hermesc -dump-bytecode -pretty` output). `[S]` = read from the source only, not checked against any file.
- Source paths are relative to the hermes repo at the reference commit; copies are in this directory under their basenames.

---

## 1. File layout at a glance

The serializer (`lib/BCGen/HBC/BytecodeStream.cpp`, `BytecodeSerializer::serialize`) writes these parts in exactly this order:

| # | Part | Alignment before it | Size |
|---|------|--------------------|------|
| 0 | BytecodeFileHeader | none (offset 0) | 128 bytes |
| 1 | Function header table (SmallFuncHeader x functionCount) | pad4 | 12 x functionCount |
| 2 | String kinds (StringKind::Entry x stringKindCount) | pad4 | 4 x stringKindCount |
| 3 | Identifier hashes (uint32 x identifierCount) | pad4 | 4 x identifierCount |
| 4 | Small string table (SmallStringTableEntry x stringCount) | pad4 | 4 x stringCount |
| 5 | Overflow string table (OverflowStringTableEntry x overflowStringCount) | pad4 | 8 x overflowStringCount |
| 6 | String storage | pad4 | stringStorageSize |
| 7 | Literal value buffer | pad4 | literalValueBufferSize |
| 8 | Object key buffer | pad4 | objKeyBufferSize |
| 9 | Object shape table (ShapeTableEntry x objShapeTableCount) | pad4 | 8 x objShapeTableCount |
| 10 | BigInt table (BigIntTableEntry x bigIntCount) | pad4 | 8 x bigIntCount |
| 11 | BigInt storage | pad4 | bigIntStorageSize |
| 12 | RegExp table (RegExpTableEntry x regExpCount) | pad4 | 8 x regExpCount |
| 13 | RegExp storage | pad4 | regExpStorageSize |
| 14 | CommonJS module table (uint32 pairs x cjsModuleCount) | pad4 | 8 x cjsModuleCount |
| 15 | Function source table (uint32 pairs x functionSourceCount) | pad4 | 8 x functionSourceCount |
| 16 | Function bytecode bodies (all functions, in function-table order) | **none** | see section 5 |
| 17 | Function info records (large headers, exception tables, debug offsets) | each record pad4 | see section 4.4 |
| 18 | Debug info (DebugInfoHeader + tables + data) | pad4 | 16 + see section 10 |
| 19 | Footer: SHA-1 of bytes [0, fileLength - 20) | none | 20 bytes |

Parts 1 to 15 are sized entirely from header counts `[V]`. Parts 16 to 18 depend on bytecode and debug info, and are located through offsets stored in the function headers and in the file header `[V]`.

All alignment padding is zero `[V]`: header bytes 113 to 127, every pad4 gap in parts 1 to 15, the gap before each function's first switch table, the gaps inside and between info records, and the gap before `debugInfoOffset` (checked in 104 corpus files and 4 samples).

Source: `visitBytecodeSegmentsInOrder` in `include/hermes/BCGen/HBC/BytecodeFileFormat.h` lists the segment order; the `pad(BYTECODE_ALIGNMENT)` calls in `BytecodeStream.cpp` set the alignment. `BYTECODE_ALIGNMENT = alignof(uint32_t) = 4`.

---

## 2. BytecodeFileHeader (128 bytes) `[V]`

`struct BytecodeFileHeader` in `BytecodeFileFormat.h` is `LLVM_PACKED`, with the following fields in order:

| Offset | Size | Type | Field | Notes |
|-------:|-----:|------|-------|-------|
| 0 | 8 | u64 | magic | `0x1F1903C103BC1FC6`. Bytes on disk: `C6 1F BC 03 C1 03 19 1F`. |
| 8 | 4 | u32 | version | `98` for this spec. |
| 12 | 20 | u8[20] | sourceHash | SHA-1 of the input source; see section 11. |
| 32 | 4 | u32 | fileLength | Total file size, including the 20-byte footer. |
| 36 | 4 | u32 | globalCodeIndex | Index of the top-level function `[S]`. |
| 40 | 4 | u32 | functionCount | Number of entries in the function header table. |
| 44 | 4 | u32 | stringKindCount | Number of StringKind runs (not number of strings). |
| 48 | 4 | u32 | identifierCount | Number of identifier hashes. |
| 52 | 4 | u32 | stringCount | Number of string table entries. |
| 56 | 4 | u32 | overflowStringCount | Number of overflow string entries. |
| 60 | 4 | u32 | stringStorageSize | Bytes of string storage. |
| 64 | 4 | u32 | bigIntCount | |
| 68 | 4 | u32 | bigIntStorageSize | |
| 72 | 4 | u32 | regExpCount | |
| 76 | 4 | u32 | regExpStorageSize | |
| 80 | 4 | u32 | literalValueBufferSize | Bytes. |
| 84 | 4 | u32 | objKeyBufferSize | Bytes. |
| 88 | 4 | u32 | objShapeTableCount | |
| 92 | 4 | u32 | numStringSwitchImms | Number of StringSwitchImm instructions in the file `[V]` (equal to the count found by decoding, in all 101 files that have them). |
| 96 | 4 | u32 | segmentID | `[S]` |
| 100 | 4 | u32 | cjsModuleCount | Static count if the CJS-static option bit is set, else dynamic count. |
| 104 | 4 | u32 | functionSourceCount | |
| 108 | 4 | u32 | debugInfoOffset | Absolute offset of the debug info part (always non-zero, see section 10). `[V]` |
| 112 | 1 | u8 | options | Bit 0 = StaticBuiltins, bit 1 = CjsModulesStaticallyResolved, bits 2 to 7 unused. Bit order is LSB-first (`HERMES_FIRST_BITFIELD`). `[S]` |
| 113 | 15 | u8[15] | padding | Zero. Makes the header 128 bytes. |

Size check: `static_assert(sizeof(BytecodeFileHeader) % 32 == 0)`. The corpus is consistent with 128 bytes `[V]`.

---

## 3. Section offset derivation `[V]`

Offsets are computed from the header with a single walk. Let `p = 128`, then for each part in the table in section 1:

```
p = align4(p); part.offset = p; p += part.size;
```

All parts 1 to 15 start at `align4(previous end)`. Part 16 starts at `p` with no alignment. Part 18 starts at `align4(end of part 17)` (or `align4(end of part 16)` if there are no info records), and that is `debugInfoOffset` `[V]`. The validator (`validate-hbc.mjs`) checks this walk against all 104 corpus files.

---

## 4. Function headers

### 4.1 SmallFuncHeader (12 bytes, part 1)

Each entry is 12 bytes: two u32 words (w1, w2), then three u8 fields (b1, b2, b3), then a flags byte. `FUNC_HEADER_FIELDS` in `BytecodeFileFormat.h` lists the fields. Bit positions are LSB-first within each storage word.

| Byte | Storage | Field | Bits | Width |
|-----:|---------|-------|------|------:|
| 0..3 (u32 w1) | w1 | Offset | 0..24 | 25 |
| | w1 | ParamCount | 25..29 | 5 |
| | w1 | LoopDepth | 30..31 | 2 |
| 4..7 (u32 w2) | w2 | BytecodeSizeInBytes | 0..13 | 14 |
| | w2 | FunctionName | 14..21 | 8 |
| | w2 | NumberRegCount | 22..26 | 5 |
| | w2 | NonPtrRegCount | 27..31 | 5 |
| 8 (u8 b1) | b1 | FrameSize | 0..7 | 8 |
| 9 (u8 b2) | b2 | ReadCacheSize | 0..7 | 8 |
| 10 (u8 b3) | b3 | WriteCacheSize | 0..5 | 6 |
| | b3 | NumCacheNewObject | 6 | 1 |
| | b3 | PrivateNameCacheSize | 7 | 1 |
| 11 (u8 flags) | flags | ProhibitInvoke | 0..1 | 2 |
| | flags | StrictMode | 2 | 1 |
| | flags | HasExceptionHandler | 3 | 1 |
| | flags | HasDebugInfo | 4 | 1 |
| | flags | Overflowed | 5 | 1 |
| | flags | Kind | 6..7 | 2 |

Verified: `[V]` for all fields that the validator reads (ParamCount, FrameSize, NumberRegCount, NonPtrRegCount, Offset, BytecodeSizeInBytes, FunctionName overflow encoding, Overflowed). Bit positions match `static_assert(sizeof(SmallFuncHeader) == 12)`.

Field meanings `[S]`: `ProhibitInvoke` enum is `Call = 0, Construct = 1, None = 2` (value 3 unused). `Kind` enum is `Normal = 0, Generator = 1, Async = 2`. `FunctionName` is a string table index. `ReadCacheSize`, `WriteCacheSize`, `NumCacheNewObject` and `PrivateNameCacheSize` are per-function cache-slot counts `[S]`.

### 4.2 Overflow: when the header does not fit

`SmallFuncHeader::canFitInSmallHeader` requires every field to fit its width (`large.get##name() > (1U << bits) - 1` returns false). Consequences:
- `Offset` must be less than 2^25.
- `BytecodeSizeInBytes` must be less than 2^14.
- `FunctionName` must be less than 256. **This is the dominant cause:** in the corpus 630,196 of 812,810 functions (77.5 percent) are overflowed, and 624,680 of those have a FunctionName string ID of 256 or more `[V]`. Other overflow causes are: an exception handler (38,147 functions), ParamCount above 31 (84), BytecodeSizeInBytes above 16383 (144), NumberRegCount above 31 (171), and FrameSize above 255 (2) `[V]`. Overflow is not limited to these; the large header is used whenever `canFitInSmallHeader` fails or the function has exception handlers or debug info.

If the header does not fit, or the function has an exception handler or debug info, the writer emits an **overflowed** small header and a full FunctionHeader in the function info area. The overflowed small header is written as:
- `flags` = exactly `0x20` (only Overflowed set). ProhibitInvoke, StrictMode, HasExceptionHandler, HasDebugInfo and Kind are all zero in this form. The real flags are in the large header `[V]`.
- `infoOffset = (FunctionName << 24) | (Offset & 0xFFFFFF)`. The writer encodes it via `SmallFuncHeader(uint32_t largeHeaderOffset)` and `getLargeHeaderOffset()`. This is an absolute file offset (up to 2^32).
- All other small fields are zero `[V]` (checked for all 630,196 overflowed headers).

So to read an overflowed function: take `infoOffset` from the small header, then read the FunctionHeader there (section 4.3). The bytecode offset and size come from the large header, not from the small header `[V]`.

### 4.3 FunctionHeader (37 bytes, packed; at infoOffset)

`struct FunctionHeader` is inside the `LLVM_PACKED` region in `BytecodeFileFormat.h`. Fields in declaration order:

| Offset | Size | Type | Field |
|-------:|-----:|------|-------|
| 0 | 4 | u32 | Offset (absolute bytecode offset) `[V]` |
| 4 | 4 | u32 | ParamCount `[V]` |
| 8 | 4 | u32 | LoopDepth `[S]` |
| 12 | 4 | u32 | BytecodeSizeInBytes `[V]` (opcode bytes only, excludes jump tables) |
| 16 | 4 | u32 | FunctionName (string ID; full width here) `[V]`: the string text matches the name the dump prints for all 3,443 functions of one corpus file |
| 20 | 4 | u32 | NumberRegCount `[V]` |
| 24 | 4 | u32 | NonPtrRegCount `[V]` |
| 28 | 4 | u32 | FrameSize `[V]` |
| 32 | 1 | u8 | ReadCacheSize `[S]` |
| 33 | 1 | u8 | WriteCacheSize `[S]` |
| 34 | 1 | u8 | NumCacheNewObject `[S]` |
| 35 | 1 | u8 | PrivateNameCacheSize `[S]` |
| 36 | 1 | u8 | flags (same bit layout as the SmallFuncHeader flags byte, section 4.1) `[V]` for HasExceptionHandler/HasDebugInfo |

Total 37 bytes `[V]` (exception tables and debug offsets were located correctly from this size in every corpus file).

### 4.4 Function info records (part 17)

The writer walks functions in function-table order (the order of part 1 entries):

```
for each function F in order:
    if (not F.hasExceptionHandler and not F.hasDebugInfo and F.header fits small): skip
    infoOffset = align4(current position)      // stored in F's overflowed small header
    pad4; write FunctionHeader (37 bytes)
    if F.hasExceptionHandler:
        pad4; write u32 count; write count x 12-byte entries {u32 start, u32 end, u32 target}
    if F.hasDebugInfo:
        pad4; write u32 sourceLocations   // DebugOffsets: 4 bytes, see section 10.5
```

Sources: `serializeFunctionInfo`, `serializeExceptionHandlerTable`, `serializeDebugOffsets` in `BytecodeStream.cpp`.

- The first record starts at `align4(end of part 16)` `[V]`.
- Exception handler `start` and `target` are instruction offsets from the start of the function's bytecode, and `end` is exclusive. All 85,155 entries in 38,147 functions land on instruction boundaries (end may equal the function end) `[V]`.
- `debugInfoOffset` equals `align4(end of the last function info record)` `[V]`, which is why the info region is followed directly by the debug part.

---

## 5. Function bytecode bodies (part 16)

### 5.1 Layout

Bodies are appended in function-table order with no padding between them, except as stated in 5.3 `[V]` (all 104 corpus files are contiguous, with no gaps or overlaps).

```
writeBinaryArray(entry->getOpcodesOnly());                      // BytecodeSizeInBytes bytes
if (!entry->getJumpTablesOnly().empty()) {
    pad(4);                                                     // absolute file alignment
    writeBinaryArray(entry->getJumpTablesOnly());
}
if (padFunctionBodiesPercent) { zeros = size * pct / 100; pad(4); }   // default 0
```

`getOpcodesOnly()` returns exactly `BytecodeSizeInBytes` bytes `[S]`, and `BytecodeSizeInBytes` counts opcode bytes only. The corpus confirms that the instruction stream ends exactly at offset + BytecodeSizeInBytes `[V]`.

### 5.2 Deduplication

When `optimizationEnabled` is on, a body whose full opcode+table array is identical to an earlier body reuses that body's offset and emits no bytes `[S]`. Identical bodies are a large share of the corpus: 138,453 of 812,810 functions reuse an earlier body `[V]`, leaving 674,357 unique bodies.

### 5.3 Jump tables (switch data) `[V]`

A function with `UIntSwitchImm` or `StringSwitchImm` has its tables appended after its opcode bytes. The rules are:
- The first table starts at `align4(offset + BytecodeSizeInBytes)`, using absolute file alignment `[V]`. The writer's `pad(4)` before the table realises that alignment.
- Each switch instruction carries a relative offset to its table. The table start is `align4(ip + rel)`, where `ip` is the switch instruction's absolute file offset `[V]`. For the first table of a function, `ip + rel` is the unpadded end of the opcodes; for later tables it is further along by the sizes of the earlier ones `[V]`. The comment in `BytecodeList.def` says Arg2 is unaligned and is aligned at runtime.
- With several switch tables in one function, they are stored contiguously after the first, in ascending start order, with no gaps and no overlaps. Checked for all 2,024 functions that have tables, 73 of them with more than one table `[V]`.
- Table sizes come from the instruction, not from a stored length:
  - `UIntSwitchImm(reg, tableRel, defaultRel, min, max)`: table = `max - min + 1` entries of **int32** (4 bytes each). Each entry is a signed offset relative to the switch instruction's `ip`. The count is `[S]` from the operand definition. The entry values are `[V]`: all 36,347 values checked land on instruction boundaries relative to `ip`.
  - `StringSwitchImm(reg, caseIndex, tableRel, defaultRel, tableSize)`: table = `tableSize` entries of 8 bytes, each `{u32 caseLabelStringID, i32 target}`. The target is relative to `ip` `[V]`: all 19,947 targets land on boundaries.
- `StringSwitchImm.caseIndex` (operand 2) takes exactly the values `0 .. numStringSwitchImms-1` in each file, each once `[V]` (101 files with string switches).

### 5.4 Zero-size bodies `[V]`

Functions with no bytecode have `BytecodeSizeInBytes = 0` (7,870 in the corpus). Their offset equals the start of the next written body, because they share the empty dedupe key. Their presence does not create a gap.

### 5.5 Function size and offset recap

- Non-overflowed: `offset` = small header field, `size` = small header field.
- Overflowed: `offset` and `size` are in the large header at `infoOffset` `[V]`.

---

## 6. Instruction encoding `[V]`

- Byte 0 of each instruction is the opcode (`opcode_atom_t` is `uint8_t`, `BytecodeInstructionGenerator.h`).
- Operands follow immediately with no padding, little-endian, in definition order (`BytecodeInstructionGenerator::emitOperand` writes the low byte first).
- Operand widths (`DEFINE_OPERAND_TYPE` in `BytecodeList.def`):

| Type | C type | Bytes | Signed |
|------|--------|------:|:------:|
| Reg8 | uint8_t | 1 | no |
| Reg32 | uint32_t | 4 | no |
| UInt8 | uint8_t | 1 | no |
| UInt16 | uint16_t | 2 | no |
| UInt32 | uint32_t | 4 | no |
| Addr8 | int8_t | 1 | yes |
| Addr32 | int32_t | 4 | yes |
| Imm32 | int32_t | 4 | yes |
| Double | double | 8 | (IEEE binary64) |

- Opcode numbers are the position in `BytecodeList.def` expansion order, starting at 0 (`Unreachable = 0`). `DEFINE_JUMP_N(name)` expands to two opcodes, first `name` with `Addr8` and then `nameLong` with `Addr32`. There are 219 opcodes. `opcodes.json` has the full table with sizes.
- `UInt8` cache-index operands take the value 255 (`PROPERTY_CACHING_DISABLED`) when caching is off for that kind of slot in that function `[S: ISel.cpp]`.
- Jump operands (`Addr8`/`Addr32`) are relative to the instruction's own start `[V]`, and all jump targets in the corpus land on instruction boundaries.
- The opcode table's expansion matches the dump's mnemonics on every function of every corpus file `[V]`. 179 of 219 opcodes occur in the corpus and samples. The other 40 are only defined in the `.def` and were not checked against any file.

Operand meanings where the `.def` is explicit (`[S]` unless noted):
- `OPERAND_STRING_ID(name, n)`: operand n (1-based) is a string table index.
- `OPERAND_FUNCTION_ID`: function table index. `OPERAND_BIGINT_ID`: bigint table index.
- `NewArrayWithBuffer(dst, sizeHint, elementCount, valueBufferOffset)`, `NewObjectWithBuffer(dst, shapeIdx, valueBufferOffset)`, `NewObjectWithBufferAndParent(dst, parent, shapeIdx, valueBufferOffset)`: the last value operand is a **byte offset** into the literal value buffer `[V]` (verified: parsing from that offset yields exactly the stated element counts). `ISel.cpp` names it `valueBufferOffset`, but the `.def` comment says "index". Trust the code.
- `CreateRegExp(dst, patternStringId, flagsStringId, regExpIndex)`: operands 2 and 3 are string IDs (`OPERAND_STRING_ID`), and operand 4 is a RegExp table index.
- `LoadConstBigInt(dst, bigintId)` `[S]`. `CreateClosure(dst, env, functionIndex)` `[S]`.

---

## 7. Strings

### 7.1 StringKind runs (part 2) `[V]`

Each `StringKind::Entry` is one u32: bit 31 is the kind (0 = String, 1 = Identifier), bits 0..30 are the run length (at least 1). The runs cover all `stringCount` strings in string-ID order, so their total length equals `stringCount` `[V]`.

### 7.2 Identifier hashes (part 3) `[V]`

One u32 per identifier, in string-ID order (only strings whose kind is Identifier) `[V]`: 2,898 identifiers in the first corpus file, all verified.

Hash (`include/hermes/Support/HashString.h`, `include/hermes/Support/JenkinsHash.h`), with `h` as uint32 starting at 0:

```
for each code unit c of the string (char16 for UTF-16 entries, byte value for 8-bit entries):
    h = h + c
    h = h + (h << 10)
    h = h ^ (h >> 6)
result = h                          // no finalisation step
```

The source comment says the hash must be stable between compilation and execution; if it is changed, the bytecode version must be bumped. 8-bit entries are ASCII-only (`isAllASCII` check in `ConsecutiveStringStorage.cpp`), so byte and char16 values agree.

Recomputable from the string data and the StringKind runs `[V]`. Not recomputable without the kind information (which strings are identifiers is decided by the compiler).

### 7.3 Small string table (part 4) `[V]`

One u32 per string (`SmallStringTableEntry`):
- bit 0: `IsUTF16`
- bits 1..23: `Offset` (23 bits)
- bits 24..31: `Length` (8 bits)

The entry is overflowed when `Length == 255` `[V]`. Overflow is decided in `SmallStringTableEntry(const StringTableEntry&, uint32_t overflowOffset)`: a string overflows if its offset is at least 2^23 or its length is at least 255. For an overflowed entry, the `Offset` field holds the index of its entry in the overflow table (the running count of overflowed entries, in string-ID order).

### 7.4 Overflow string table (part 5) `[V]`

`OverflowStringTableEntry = {u32 offset, u32 length}`, 8 bytes each. The `offset` is the byte offset in the storage, and `length` is the length (for UTF-16 entries, in code units, as in `StringTableEntry`). Count is `overflowStringCount`, which matched the number of overflowed entries in all 104 files `[V]` (4,992 overflowed entries).

### 7.5 String storage (part 6) `[V]`/`[S]`

- 8-bit strings (ASCII) come first, one byte per character. All bytes are below 0x80 `[S]`, and this was true of every 8-bit identifier checked `[V]`.
- UTF-16 strings follow, little-endian, aligned to a 2-byte offset within the storage (`appendU16Storage`), so a UTF-16 entry's offset is a byte offset within the storage `[S]`.
- A small-table entry gives the absolute byte offset within the storage. UTF-16 entries occur in every corpus file (61,473 in total) `[V]`, and 5,632 UTF-16 identifiers exist; their hashes match, which exercises the UTF-16 decode path `[V]`.
- The packer (`StringPacker::optimizingPackStrings`) may place substrings or suffixes into shared storage, so offsets are the authority, and storage is **not** necessarily the concatenation of the strings `[S]`.

---

## 8. Literal buffers, key buffer and shape table

### 8.1 Serialized literal tags (`SerializedLiteralGenerator.h`) `[V]`

The value buffer (part 7) and key buffer (part 8) are sequences of tagged runs:

- Tag byte bits 4..6 give the type; bit 7 selects the form.
- Short form (bit 7 clear): the run length is `tag & 0x0F`, 1 to 15.
- Long form (bit 7 set): the run length is `((tag & 0x0F) << 8) | next byte`, 16 to 4095 (`SequenceMax = 4095`).

| Type (tag & 0x70) | Name | Payload per value |
|------------------:|------|-------------------|
| 0x00 | null | 0 bytes |
| 0x10 | true | 0 bytes |
| 0x20 | false | 0 bytes |
| 0x30 | number (double) | 8 bytes, IEEE binary64 LE (NaN is written as bits `0xFFF8000000000000`) |
| 0x40 | long string | 4 bytes, uint32 string ID |
| 0x50 | short string | 2 bytes, uint16 string ID |
| 0x60 | undefined (also used for uninit) | 0 bytes |
| 0x70 | integer | 4 bytes, int32 LE |

A run's type and length apply to its values; a new run starts when the type changes or the run reaches 4095 `[S]`. The writer and the reader (`SerializedLiteralParser.h`) agree on these rules. Verified by decoding every array and object in the corpus: 245,875 arrays and 768,161 objects, each consuming exactly its declared element count `[V]`.

Key buffer contents: keys are string IDs (short or long string tags), **but numeric keys are stored as integer or number values** (17,226 integers and 192 doubles in the corpus `[V]`). A parser must accept all types in the key buffer.

The buffers are packed like other string storage (`ConsecutiveStringStorage` with `optimize`), so the offsets from instructions and shape entries are the authority `[S]`.

### 8.2 Object shape table (part 9) `[V]`

`ShapeTableEntry = {u32 keyBufferOffset, u32 numProps}` (8 bytes). `keyBufferOffset` is a byte offset into the key buffer, and `numProps` is the number of key/value pairs. Entries are deduplicated by (offset, numProps) `[S]`. The dump prints them as `idx[keyBufferOffset, numProps]`.

`NewObjectWithBuffer` operand 2 is a shape table index. Its values start at the byte offset given by its value buffer operand `[V]`.

---

## 9. Other tables

- **BigInt table (part 10):** `{u32 offset, u32 length}` per entry, where `length` is the byte count. Entries are contiguous: `offset[i] = offset[i-1] + length[i-1]` `[S]`. Storage (part 11) holds two's-complement little-endian bytes with minimal length, including a sign byte when needed. Verified: `12345678901234567890` is stored as `d2 0a 1f eb 8c a9 54 ab 00` (9 bytes) `[V]`.
- **RegExp table (part 12):** `{u32 offset, u32 length}` into RegExp storage (part 13). Storage holds compiled regex bytecode; its format is in `RegexSerialization.h` and was **not** parsed here. Entries are uniqued by (pattern, flags) `[S]`. Corpus: the file `bundles/comoser__rn-background-location/index.android.hbc` has 47 entries `[V]`.
- **CommonJS module table (part 14):** `cjsModuleCount` pairs of u32. If the CJS-static option (options bit 1) is set, pairs are `(moduleID, functionID)`; otherwise they are `(nameStringID, functionID)`. The two tables are mutually exclusive `[S]`. **Not present in the corpus**, so untested.
- **Function source table (part 15):** `functionSourceCount` pairs `(u32 functionID, u32 stringID)` `[V]`: the dump shows `Function ID 2979 -> s1927`, and the file has `[2979, 1927]`.

---

## 10. Debug info

### 10.1 DebugInfoHeader (16 bytes, at debugInfoOffset) `[V]`

| Offset | Field |
|-------:|-------|
| 0 | u32 filenameCount |
| 4 | u32 filenameStorageSize |
| 8 | u32 fileRegionCount |
| 12 | u32 debugDataSize (bytes of the debug data stream in part 10.4) |

Then, in order: filename table (8 bytes x filenameCount), filename storage (filenameStorageSize bytes), file regions (12 bytes x fileRegionCount), debug data (debugDataSize bytes). No padding between these sections `[V]`: the file's total length equals this layout plus the footer.

### 10.2 Filename table entries `[S]`

`StringTableEntry` is `{u32 offset, u32 length}`. Bit 31 of `length` is the UTF-16 flag, and the low 31 bits are the length. Offsets are byte offsets into the filename storage. The storage uses the same ASCII-then-UTF-16 layout as section 7.5 `[S]`.

### 10.3 DebugFileRegion (12 bytes) `[V]` (size; content matches the dump's "Debug file table")

`{u32 fromAddress, u32 filenameId, u32 sourceMappingUrlId}`. `fromAddress` is a byte offset into the debug data stream (not a bytecode address), and it marks where a file starts `[S]`/`[V]`.

### 10.4 Debug data stream `[V]`

Each function with debug info has one record at `sourceLocations` (see 10.5). All integers are **SLEB128** (signed LEB128, `llvh::encodeSLEB128`), and the decoding was checked against the dump's `Debug source table` `[V]` (61 locations in 2 functions, zero mismatches).

```
record := SLEB functionIndex, SLEB line, SLEB column, SLEB envIdx        // start location
          { SLEB addressDelta                                             // from previous address; starts at 0
            if addressDelta == -1: end of record
            SLEB ldelta
            if (ldelta & 1) == 0: no location at this address; continue  // then no further fields
            SLEB columnDelta
            if (ldelta & 2): SLEB statementDelta
            if (ldelta & 4): SLEB envIdxDelta
            line += ldelta >> 3          // arithmetic shift
            column += columnDelta; statement += statementDelta (if present); envIdx += envIdxDelta (if present)
          }
```

Source: `DebugInfoGenerator::appendSourceLocations` (encoder) and `detail::FunctionDebugInfoDeserializer::next` in `DebugInfo.h` (decoder). The encoder's `ldelta` is `(lineDelta << 3) | ((envDelta != 0) << 2) | ((sdelta != 0) << 1) | 1`.

Note: `envIdx` values index a scoping table (`scopingInfoTable_`) that is **not serialized**. `addScopingInfo` only fills an in-memory table, and the writer never emits it `[S]`.

### 10.5 DebugOffsets: 4 bytes, not 8 `[V]`

`struct DebugOffsets { uint32_t sourceLocations; }`. It is one u32, with `NO_OFFSET = 0xFFFFFFFF`, and it is written only when `hasDebugInfo` is set. There is **no** `lexicalData` field at this version (the brief's guess of `{sourceLocations, lexicalData}` is wrong). `sourceLocations` is a byte offset into the debug data stream (10.4) `[V]`.

### 10.6 What stripping does `[V]` (with the pinned compiler)

- Default (`-g1`, the `DebugInfoLevel` default): the section is present. Sample: 1 filename (9 bytes), 1 file region, debugDataSize 196 `[V]`.
- `-g0` or `-output-source-map`: `stripDebugInfoSection` is set (`CompilerDriver.cpp`: `genOptions.stripDebugInfoSection = cl::OutputSourceMap || cl::DebugInfoLevel == cl::DebugLevel::g0`). Then:
  - `debugInfoOffset` is **still non-zero** and points to a 16-byte zero DebugInfoHeader (filenameCount = filenameStorageSize = fileRegionCount = debugDataSize = 0). It sits directly before the footer `[V]`.
  - No function has `HasDebugInfo` set, so there are no per-function debug offsets `[V]`.
  - The corpus files are all stripped in this way (their debugDataSize is 0) `[V]`.

---

## 11. Footer and hashes

- **Footer (last 20 bytes):** SHA-1 of bytes `[0, fileLength - 20)`, i.e. everything before the footer, including padding `[V]` (checked for all 104 files).
- **fileLength** = total file size, including the footer `[V]`.
- **sourceHash (header bytes 12..31):** SHA-1 over the raw bytes of the input source(s), hashed in order as `processSourceFiles` does in `CompilerDriver.cpp`. For a single input it is `SHA1(source bytes)`. `[V]`: the header hash of `bundles/comoser__rn-background-location/index.android.hbc` equals `shasum -a 1` of its `index.android.bundle`. It is not recomputable without the original source.

---

## 12. Notes for a lossless transform / compressor

Recomputable from other data (given the rest of the file):
- All alignment padding (zero bytes `[V]`, checked in every corpus file and sample).
- The file header fields that count sections (stringKindCount, identifierCount, stringCount, sizes), once the section contents are known. `fileLength` is the file size.
- All section offsets (section 3) and the alignment padding (zero bytes).
- Overflow tables and the overflowed entry indices (section 7.3 and 7.4).
- Identifier hashes (section 7.2), from strings and StringKind runs.
- The footer SHA-1 (section 11).
- Dedupe offsets (identical bodies share an offset), and the zero-size function offsets.
- Switch table sizes (section 5.3), from the switch instructions.
- Large-header position: infoOffset and the info records' layout (section 4.4), given the function flags and table lengths.

Not recomputable (must be stored or modelled):
- Opcode stream content (the compiler's output), and jump offsets and table entries (data, though relative).
- Function header fields such as ParamCount, FrameSize, register counts, FunctionName, ReadCacheSize, flags (Kind/ProhibitInvoke/Strict).
- StringKind runs (which strings are identifiers).
- String storage packing (which substrings are shared), literal and key buffers, shape table contents, BigInt and RegExp storage, CJS and function source tables.
- Debug data (sourceLocations, file regions, filename storage).
- sourceHash (unless the source is available).

Where the bytes are, in order: header 0..127; part tables from 128 (section 1); bodies somewhere after the function source table (`functionSourceTable` end); info records after the bodies; debug info at `debugInfoOffset`; footer in the last 20 bytes.

---

## 13. Not determined or not verified

- CommonJS module table (part 14) and the CJS-static option: not in any corpus or sample, so not tested.
- RegExp storage contents: the compiled regex format is not parsed here.
- BigInt storage beyond one positive example.
- The `padFunctionBodiesPercent` option (default 0): the layout is `[S]` only.
- Operand meanings of `CreateClosure`, `LoadConstBigInt`, `CacheNewObject` and similar beyond the `OPERAND_*` annotations: from the `.def` comments, not checked against files.
- 40 of 219 opcodes never occur in the corpus or samples; their widths come from the `.def` only.
- `hermesc -dump-bytecode -pretty` output does not print byte offsets, so offset and table-placement claims were checked by decoding and by consistency checks, not by the dump.
- Static Hermes-specific additions could not be separated from the general format using the source alone.

---

## 14. Files in this directory that back this spec

- `COMMIT.txt`: ref, provenance, copied and missing paths.
- `opcodes.json`, `gen-opcodes.mjs`: opcode table (219 entries, operand sizes and semantics, jump and return-target flags).
- `validate-hbc.mjs`: layout and opcode checker against the pinned dump (`node validate-hbc.mjs file.hbc dump.txt opcodes.json`).
- `validation-notes.md`: what was run and what the dump prints.
- All copied sources (basenames as listed in `COMMIT.txt`).
