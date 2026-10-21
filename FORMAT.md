# hbc-pack container and stream format (codec v3)

This is the format the reference encoder (`src/codec-v3.mjs`) writes and every decoder must read.
All integers are little-endian. "varint" is unsigned LEB128 (7 bits per byte, low bits first);
"svarint" is a zigzag-mapped varint (`(v << 1) ^ (v >> 31)`).

## Container

```
"HBCP"            4 bytes magic
u8  version       1
u8  streamCount   60 for codec v3 (streams 0-59)
per stream:
  u8     backend  0 stored, 1 zstd, 2 brotli, 3 xz (measurement only), 4 zstd with dictionary
  varint rawLength
  varint storedLength
  bytes[storedLength]
  if backend == 4: 16 bytes, the stream name, NUL padded (selects the dictionary)
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
| 8 | objShapeTable | shape table, verbatim (`8 × objShapeTableCount`) |
| 9 | misc | bigIntTable, bigIntStorage, regExpTable, regExpStorage, cjsModuleTable, functionSourceTable, concatenated, verbatim |
| 10 | padding | the bytes in the alignment gaps between table sections, in file order (normally all zero) |
| 11 | debug | bytes from `debugInfoOffset` to the footer, verbatim |
| 12 | fhParam | u8 per function |
| 13 | fhLoop | u8 per function |
| 14 | fhNumReg | u8 per function |
| 15 | fhNonPtr | u8 per function |
| 16 | fhReadCache | u8 per function |
| 17 | fhWriteCache | u8 per function |
| 18 | fhFlags | u8 per function: `prohibitInvoke:2 strictMode:1 hasExceptionHandler:1 hasDebugInfo:1 0:1 kind:2` (the overflowed bit is always 0 here) |
| 19 | fhPrivate | u8 per function: privateNameCacheSize |
| 20 | fhNewObj | u8 per function: numCacheNewObject |
| 21 | fhSize | varint per function: bytecodeSizeInBytes |
| 22 | fhName | varint per function: functionName string id |
| 23 | fhFrame | varint per function: frameSize |
| 24 | fhReuse | varint per function: 0 = own body; k > 0 = this function reuses the body of function `i − k` |
| 25 | excCount | varint per function that has `hasExceptionHandler` |
| 26 | excStart | svarint per exception entry: start minus the previous entry's start (0 for the first in a function) |
| 27 | excEnd | svarint per entry: end minus start |
| 28 | excTarget | svarint per entry: target minus end |
| 29 | debugOff | u32 per function that has `hasDebugInfo` |
| 30 | mtfConfig | 6 bytes: five MTF flags (all 0 in v3) and the strEnd flag (1) |
| 31 | opcodes | one byte per instruction, bodies in order |
| 32–47 | reg8 reg32 u8 u16 u32 str8 str16 str32 fn16 fn32 bi16 bi32 addr8 addr32 imm32 dbl64 | operand bytes by class and width, in instruction order, verbatim little-endian; a property-cache operand (see below) is NOT in `u8` |
| 48–57 | str8R str8F str16R str16F str32R str32F fn16R fn16F fn32R fn32F | MTF rank/fresh streams, empty in v3 |
| 58 | switchTables | switch jump tables, concatenated in body order |
| 59 | cacheRes | svarint per property-cache operand: cache index minus the first-appearance rank |

## Rebuilding the file

Sizes and counts come from the header (stream 0) and from the HBC layout rules
(`ref/SPEC.md`): sections start at 128 and follow in the order functionHeaders (12 bytes each),
stringKinds, identifierHashes (4 × identifierCount), stringTable (4 × stringCount),
overflowStringTable (8 × overflowStringCount), stringStorage, arrayBuffer, objKeyBuffer,
objShapeTable (8 × count), bigIntTable (8 × count), bigIntStorage, regExpTable (8 × count),
regExpStorage, cjsModuleTable (8 × count), functionSourceTable (8 × count), each aligned to 4
bytes with bytes taken from the `padding` stream.

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

After the bodies, align to 4. For each function in order whose header needs an info block
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

Then the `debug` stream goes at `debugInfoOffset`, and the last 20 bytes are the SHA-1 of
everything before them. The result must be exactly `fileLength` bytes (from the header).
