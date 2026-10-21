# Local changes to the vendored zstd sources

zstd v1.5.7, `lib/common` and `lib/decompress` only (the decompressor).

- `common/zstd_common.c`: after `#undef ZSTD_isError`, re-apply the hbc-pack symbol prefix when
  `native/hbcpack_symbols.h` is in effect, so `ZSTD_isError` is exported as
  `hbcpack__ZSTD_isError` like every other zstd symbol and cannot collide with another copy of
  zstd in the same app.
