# hbc-pack container and stream format (container versions 2 and 3)

This is the format the reference encoder (`src/codec.mjs`) writes and every decoder must read.
All integers are little-endian. "varint" is unsigned LEB128 (7 bits per byte, low bits first);
"svarint" is a zigzag-mapped varint (`(v << 1) ^ (v >> 31)`). HBC bytecode versions 94, 96, 98
and 99 are supported; the version comes from stream 0 and selects a profile (`src/profiles.mjs`,
`native/hbcpack.c`). Container version 2 is self-contained; version 3 is a delta against an
installed file (below).

## Container

```
"HBCP"            4 bytes magic
u8  version       2 (self-contained) or 3 (delta)
u8  streamCount   49 for HBC 98, 48 for HBC 99, 45 for HBC 96 and 94 (see below)
if version == 3: 20 bytes, the SHA-1 footer of the base file (the installed .hbc the delta was made against)
per stream:
  u8     backend  0 stored, 1 zstd, 2 brotli, 3 xz (measurement only), 4 zstd with dictionary
  varint rawLength
  varint storedLength
  bytes[storedLength]
  if backend == 4: 32 bytes, the stream name, NUL padded (selects the dictionary)
```

Streams appear in this fixed order (names are the encoder's; the decoder goes by position):

| # | name | content |
|---|---|---|
| 0 | header | the 128-byte HBC file header, verbatim |
| 1 | kinds | string-kind table, verbatim (`4 × stringKindCount`) |
| 2 | strFlags | one byte per string: 1 = UTF-16 |
| 3 | strLens | varint per string: length in code units |
| 4 | strDeltas | svarint per string: storage offset minus the previous string's end (`offset + length × (utf16 ? 2 : 1)`), restarting at 0 for each kind run |
| 5 | storage | string storage, verbatim |
| 6 | arrayBuffer | literal value buffer, verbatim |
| 7 | objKeyBuffer | object key buffer, verbatim |
| 8 | literalTable3 | HBC 98: shape table (`8 × objShapeTableCount`); HBC 96: object value buffer, verbatim |
| 9 | misc | bigIntTable, bigIntStorage, regExpTable, regExpStorage, cjsModuleTable, functionSourceTable, concatenated, verbatim |
| 10 | padding | the bytes in the alignment gaps between table sections, in file order (normally all zero) |
| 11 | debug | bytes from `debugInfoOffset` to the footer, verbatim |
| 12… | fh:… | one column per function-header field, in the profile's order (below); `u8` columns hold one byte per function, `varint` columns one varint per function |
| | fhReuse | varint per function: 0 = own body; k > 0 = this function reuses the body of function `i − k` |
| | excCount | varint per function that has `hasExceptionHandler` |
| | excStart | svarint per exception entry: start minus the previous entry's start (0 for the first in a function) |
| | excEnd | svarint per entry: end minus start |
| | excTarget | svarint per entry: target minus end |
| | debugOff | per function that has `hasDebugInfo`: the DebugOffsets record verbatim (4 bytes in HBC 98, 8 in HBC 96) |
| | opcodes | one byte per instruction, bodies in order |
| | reg8 reg32 u8 u16 u32 str8 str16 str32 fn16 fn32 bi16 bi32 addr8 addr32 imm32 dbl64 | 16 streams: operand bytes by class and width, in instruction order, verbatim little-endian; a property-cache operand (see below) is NOT in `u8` |
| | switchTables | switch jump tables, concatenated in body order |
| | cacheRes | svarint per property-cache operand: cache index minus the first-appearance rank |

Header columns, HBC 98 (12): `paramCount loopDepth numberRegCount nonPtrRegCount readCacheSize
writeCacheSize flagsByte privateNameCacheSize numCacheNewObject` (u8) then `bytecodeSize
functionName frameSize` (varint). HBC 99 (11): the same without `numCacheNewObject`. HBC 96 and
94 (8): `readCacheSize writeCacheSize flagsByte` (u8) then `paramCount bytecodeSize functionName
frameSize environmentSize` (varint). `flagsByte` is `prohibitInvoke:2 strictMode:1
hasExceptionHandler:1 hasDebugInfo:1 0:1 kind:2` with the overflowed bit always 0.

## Delta containers (version 3)

A version 3 container encodes a new file against a **base**: the file already installed on the
device (typically the previous release of the same app). The decoder needs the base's bytes; it
checks that the base's last 20 bytes equal the footer in the container header and fails otherwise.

The base is taken apart into exactly the streams above (same order, same encodings, in the
"delta form" described next) and every base stream of at least 64 bytes becomes the zstd
dictionary of the new file's stream with the same name: streams compressed with backend 4 name
their dictionary with the 32-byte stream name. Backends 0–2 remain allowed per stream (the
encoder picks whichever is smallest); no external dictionaries are involved.

**String ids are canonicalised** so that unchanged code compresses against the base even when the
new string table was renumbered. Every string has a content key: the UTF-16 flag plus its storage
bytes. Each string of the new file, in table order, takes the id of the *first* base string with
the same key, provided no earlier new string took that base id already; every other new string
gets the next fresh id, counting up from `base.stringCount`. (The base's own canonical ids are its
original ids.) In a delta container:

- the 16 operand streams are unchanged except `str8`, `str16` and `str32`, which hold **u32**
  canonical ids regardless of the operand's width;
- the `fh:functionName` column holds canonical ids (still varints).

Everything else is as in version 2. The decoder rebuilds the new string table first (streams
2–5), computes the same mapping from the base's string table and its own, and maps each canonical
id back to the new id while writing operands at their original width (an id that does not fit
the width, or an unmapped canonical id, is a format error). This is implemented in
`src/codec.mjs` (`canonicalIds`, `pack(buf, {base})`, `unpack(bytes, {base})`) and
`native/hbcpack.c` (`extract_base`, `canonical_map`, `hbcpack_options.base`).

## Rebuilding the file

Sizes and counts come from the header (stream 0) and from the HBC layout rules
(`ref/SPEC.md`): sections start at 128 and follow in the order functionHeaders (12 bytes each in
HBC 98, 16 in HBC 96), stringKinds, identifierHashes (4 × identifierCount), stringTable
(4 × stringCount), overflowStringTable (8 × overflowStringCount), stringStorage, arrayBuffer,
objKeyBuffer, objShapeTable (8 × count; HBC 96: objValueBuffer, byte size), bigIntTable
(8 × count), bigIntStorage, regExpTable (8 × count), regExpStorage, cjsModuleTable (8 × count),
functionSourceTable (8 × count), each aligned to 4 bytes with bytes taken from the `padding`
stream. Header field offsets differ after byte 88 (HBC 98: shapeCount 88, stringSwitchImms 92,
segmentID 96, cjsModuleCount 100, functionSourceCount 104, debugInfoOffset 108; HBC 96:
objValueBufferSize 88, segmentID 92, cjsModuleCount 96, functionSourceCount 100,
debugInfoOffset 104).

### Strings and hashes

For each kind run, offsets are prefix sums of `strDeltas` from the previous string's end.
Small table entry: `utf16 | offset << 1 | length << 24`, or, when `length >= 255`,
`utf16 | overflowIndex << 1 | 255 << 24` with the entry `{offset, length}` appended to the
overflow table (overflow indices count up in string order). Identifier hashes, in order of the
strings whose kind run is marked identifier (bit 31 of the kind entry): Jenkins one-at-a-time
over code units (bytes for ASCII strings, 16-bit units for UTF-16 strings):
`h += c; h += h << 10; h ^= h >>> 6` with 32-bit wraparound, no final mixing.

### Function bodies

Bodies are written in function order starting right after the last table section, byte-packed.
For function `i`: if `fhReuse[i] = k > 0` its offset is function `i − k`'s offset and nothing is
written. Otherwise its offset is the current position and `fhSize[i]` bytes of instructions are
decoded: read the opcode byte from `opcodes`, then each operand from its class stream according to
`ref/opcodes.json` (class = semantic + width: register → reg, uint → u, string_id → str,
function_id → fn, bigint_id → bi, jump_offset → addr, immediate → imm, double → dbl).

Property-cache operand: for opcodes whose name contains `ById` and that have both a string-id
operand and a 1-byte uint operand, the 1-byte uint operand is a cache index. Per body, keep two
maps (reads; writes = opcode name contains `Put` or `Define`) from string id to rank, assigning
ranks 0, 1, 2… in first-appearance order. The operand value is
`(rank + svarint from cacheRes) & 0xff`. The string id must be read first (it may come later in
the operand list).

If the body contains `UIntSwitchImm` (operands reg, tableOffset, default, min, max) or
`StringSwitchImm` (reg, index, tableOffset, default, size), the body is followed by padding to a
4-byte boundary (zero bytes) and `4 × (max − min + 1)` resp. `8 × size` bytes taken from
`switchTables`.

### Info section and function headers

**HBC 96.** After the bodies, align to 4. For each function in order: align to 4 and set its
`infoOffset` to the current position (every function gets one). If any field exceeds the small
header widths (offset 25 bits, paramCount 7, size 15, functionName 17, infoOffset 25, frameSize 7,
environmentSize 8), write the 32-byte large header (`u32 offset, paramCount, size, functionName,
infoOffset, frameSize, environmentSize; u8 readCache, writeCache, flags; 1 zero byte`) and make
the small header the pointer form: copy fields in the order above until the first one that does not
fit, then `offset = largeOffset & 0xffff`, `infoOffset = largeOffset >> 16`, flags with bit 5 set.
Otherwise write the normal 16-byte small header: `w1 = offset | paramCount << 25`,
`w2 = size | functionName << 15`, `w3 = infoOffset | frameSize << 25`, `b12 = environmentSize,
b13 = readCache, b14 = writeCache, b15 = flags`. Then, if `hasExceptionHandler`, the exception
table, and if `hasDebugInfo`, the 8-byte DebugOffsets record, as below.

**HBC 94** is laid out exactly like HBC 96; only the opcode numbering differs
(`ref/v94/opcodes.json`).

**HBC 98.** After the bodies, align to 4. For each function in order whose header needs an info block
(`hasExceptionHandler` or `hasDebugInfo` or any field exceeds the small-header widths:
offset 25 bits, paramCount 5, loopDepth 2, size 14, functionName 8, numberRegs 5, nonPtrRegs 5,
frameSize 8, readCache 8, writeCache 6, numCacheNewObject 1, privateNameCache 1): align to 4,
write the 40-byte large header (`u32 offset, paramCount, loopDepth, size, functionName,
numberRegs, nonPtrRegs, frameSize; u8 readCache, writeCache, numCacheNewObject,
privateNameCache; u8 flags; 3 zero bytes`), then if `hasExceptionHandler`: `u32 count` and
`count × {u32 start, end, target}` rebuilt from the exc streams; then if `hasDebugInfo`: the
`u32` from `debugOff`. That function's small header is the pointer form:
`w1 = infoOffset & 0xffffff`, `w2 = ((infoOffset >> 24) & 0xff) << 14`, bytes 8–10 zero,
flags `0x20`. Every other function gets a normal small header:
`w1 = offset | paramCount << 25 | loopDepth << 30`,
`w2 = size | functionName << 14 | numberRegs << 22 | nonPtrRegs << 27`,
`b8 = frameSize, b9 = readCache, b10 = writeCache | numCacheNewObject << 6 | privateNameCache << 7`,
`b11 = flags` (with the overflowed bit clear).

**HBC 99** is HBC 98 without `numCacheNewObject`: the large header is 36 bytes (`u32 offset,
paramCount, loopDepth, size, functionName, numberRegs, nonPtrRegs, frameSize; u8 readCache,
writeCache, privateNameCache, flags`), the small header's `b10 = writeCache | privateNameCache << 7`
with writeCache allowed up to 7 bits, and the header's field offsets are those of HBC 98.

Then the `debug` stream goes at `debugInfoOffset`, and the last 20 bytes are the SHA-1 of
everything before them. The result must be exactly `fileLength` bytes (from the header).
