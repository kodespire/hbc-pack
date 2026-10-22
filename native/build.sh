#!/bin/sh
# Builds the CLI from the vendored zstd/brotli sources (deps/), exactly as the mobile builds do.
# Usage: sh native/build.sh
set -e
cd "$(dirname "$0")/.."
ZSTD=deps/zstd/lib; BROTLI=deps/brotli/c
CFLAGS="-std=c11 -O2 -DNDEBUG -DZSTD_LEGACY_SUPPORT=0 -DZSTD_DISABLE_ASM -DZSTD_NO_TRACE -DXXH_NAMESPACE=ZSTD_ -DZSTD_MULTITHREAD=0 -I$ZSTD -I$ZSTD/common -I$BROTLI/include -Inative -include native/hbcpack_symbols.h"
# Diagnostics from the vendored sources (macro redefinitions from the symbol prefixing) are dropped;
# anything else is shown, and a failed compile fails the script.
LOG=$(mktemp)
if cc $CFLAGS -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion -Wno-unused-parameter \
  native/hbcpack.c native/hbcpack_cli.c $ZSTD/common/*.c $ZSTD/decompress/*.c $BROTLI/common/*.c $BROTLI/dec/*.c -o native/hbcpack 2>"$LOG"; then
  grep -v "deps/\|isError\|previous definition\|^ *[0-9]* |\|^ *|\|^ *\^\|warnings generated" "$LOG" || true
  rm -f "$LOG"
  echo "built native/hbcpack (vendored zstd/brotli, prefixed symbols)"
else
  grep -v "deps/.*warning\|isError\|previous definition" "$LOG"; rm -f "$LOG"; exit 1
fi
