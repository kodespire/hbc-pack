#!/bin/sh
# Builds the CLI against Homebrew's zstd and brotli (macOS). Usage: sh native/build.sh
set -e
cd "$(dirname "$0")"
ZSTD=${ZSTD_PREFIX:-/opt/homebrew/opt/zstd}
BROTLI=${BROTLI_PREFIX:-/opt/homebrew/opt/brotli}
cc -std=c11 -O2 -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion \
  -I"$ZSTD/include" -I"$BROTLI/include" \
  hbcpack.c hbcpack_cli.c -o hbcpack \
  "$ZSTD/lib/libzstd.a" "$BROTLI/lib/libbrotlidec.a" "$BROTLI/lib/libbrotlicommon.a"
echo "built native/hbcpack"
