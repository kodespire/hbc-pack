#!/bin/sh
# Decodes every <packedDir>/*.hbcp with the native decoder and compares with the corpus files.
# Usage: sh native/test.sh [packedDir=results/packed] [bundlesDir=bundles] [dictDir]
cd "$(dirname "$0")/.."
CORPUS=${HBC_CORPUS:-../hermes-corpus}
PACKED=${1:-results/packed}; BUNDLES=${2:-bundles}
ok=0; bad=0
for f in "$PACKED"/*.hbcp; do
  slug=$(basename "$f" .hbcp)
  orig="$CORPUS/$BUNDLES/$slug/index.android.hbc"
  if [ -n "$3" ]; then extra="--dicts $3"; else extra=""; fi
  if native/hbcpack unpack "$f" /tmp/hbcpack-test.hbc $extra >/dev/null 2>/tmp/hbcpack-err.txt && cmp -s /tmp/hbcpack-test.hbc "$orig"; then ok=$((ok+1)); else bad=$((bad+1)); echo "FAIL $slug: $(cat /tmp/hbcpack-err.txt)"; fi
done
echo "$PACKED vs $BUNDLES: $ok ok, $bad bad"
