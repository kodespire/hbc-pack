#!/bin/sh
# Decodes every <deltaDir>/<slug>.hbcp (delta containers made against bundles-pairs/<slug>/old)
# with the native decoder and compares with bundles-pairs/<slug>/new.
# Usage: sh native/test-delta.sh [deltaDir=results/delta]
cd "$(dirname "$0")/.."
CORPUS=${HBC_CORPUS:-../hermes-corpus}
DELTA=${1:-results/delta}
ok=0; bad=0
for f in "$DELTA"/*.hbcp; do
  slug=$(basename "$f" .hbcp)
  pair="$CORPUS/bundles-pairs/$slug"
  if native/hbcpack unpack "$f" /tmp/hbcpack-delta-test.hbc --base "$pair/old/index.android.hbc" >/dev/null 2>/tmp/hbcpack-err.txt && cmp -s /tmp/hbcpack-delta-test.hbc "$pair/new/index.android.hbc"; then ok=$((ok+1)); else bad=$((bad+1)); echo "FAIL $slug: $(cat /tmp/hbcpack-err.txt)"; fi
done
echo "$DELTA vs bundles-pairs/*/new: $ok ok, $bad bad"
