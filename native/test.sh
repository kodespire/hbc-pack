#!/bin/sh
# Decodes every results/packed/*.hbcp with the native decoder and compares with the corpus files.
# Usage: sh native/test.sh [dictDir]
cd "$(dirname "$0")/.."
CORPUS=${HBC_CORPUS:-../hermes-corpus}
ok=0; bad=0; total_ms=0
for f in results/packed/*.hbcp; do
  slug=$(basename "$f" .hbcp)
  orig="$CORPUS/bundles/$slug/index.android.hbc"
  if [ -n "$1" ]; then extra="--dicts $1"; else extra=""; fi
  if native/hbcpack unpack "$f" /tmp/hbcpack-test.hbc $extra >/dev/null 2>/tmp/hbcpack-err.txt && cmp -s /tmp/hbcpack-test.hbc "$orig"; then ok=$((ok+1)); else bad=$((bad+1)); echo "FAIL $slug: $(cat /tmp/hbcpack-err.txt)"; fi
done
echo "$ok ok, $bad bad"
