#!/bin/sh
# Builds the CLI from the vendored zstd/brotli sources (deps/), exactly as the mobile builds do.
# Usage: sh native/build.sh
set -e
cd "$(dirname "$0")/.."
ZSTD=deps/zstd/lib; BROTLI=deps/brotli/c
CFLAGS="-std=c11 -O2 -DNDEBUG -DZSTD_LEGACY_SUPPORT=0 -DZSTD_DISABLE_ASM -DZSTD_NO_TRACE -DXXH_NAMESPACE=ZSTD_ -DZSTD_MULTITHREAD=0 -I$ZSTD -I$ZSTD/common -I$BROTLI/include -Inative -include native/hbcpack_symbols.h"
cc $CFLAGS -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion -Wno-unused-parameter \
  native/hbcpack.c native/hbcpack_cli.c $ZSTD/common/*.c $ZSTD/decompress/*.c $BROTLI/common/*.c $BROTLI/dec/*.c -o native/hbcpack 2>&1 | grep -v "deps/" || true
test -x native/hbcpack && echo "built native/hbcpack (vendored zstd/brotli, prefixed symbols)"
