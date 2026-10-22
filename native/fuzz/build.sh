#!/bin/sh
# Builds the decoder and the mutation fuzzer with AddressSanitizer + UndefinedBehaviorSanitizer.
# Usage: sh native/fuzz/build.sh   -> native/fuzz/hbcpack-fuzz
set -e
cd "$(dirname "$0")/../.."
ZSTD=deps/zstd/lib; BROTLI=deps/brotli/c
CFLAGS="-std=c11 -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined -DZSTD_LEGACY_SUPPORT=0 -DZSTD_DISABLE_ASM -DZSTD_NO_TRACE -DXXH_NAMESPACE=ZSTD_ -DZSTD_MULTITHREAD=0 -I$ZSTD -I$ZSTD/common -I$BROTLI/include -Inative -include native/hbcpack_symbols.h"
LOG=$(mktemp)
if cc $CFLAGS -Wall native/hbcpack.c native/fuzz/fuzz.c $ZSTD/common/*.c $ZSTD/decompress/*.c $BROTLI/common/*.c $BROTLI/dec/*.c -o native/fuzz/hbcpack-fuzz 2>"$LOG"; then
  grep -v "deps/\|isError\|previous definition\|^ *[0-9]* |\|^ *|\|^ *\^\|warnings generated" "$LOG" || true
  rm -f "$LOG"; echo "built native/fuzz/hbcpack-fuzz (ASan + UBSan)"
else
  grep -v "deps/.*warning\|isError\|previous definition" "$LOG"; rm -f "$LOG"; exit 1
fi
