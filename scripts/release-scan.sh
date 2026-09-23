#!/usr/bin/env bash
# Release hygiene scan (docs/RELEASE_HYGIENE.md). The forbidden identifiers are NOT stored in this
# repository: pass a file with one extended regex per line (case-insensitive) as $1 or
# COAGENTS_HYGIENE_PATTERNS. Scans tracked files, file names, build outputs and source maps.
# Usage: scripts/release-scan.sh ~/.coagents-secrets/hygiene-patterns.txt [extra-dir ...]
set -euo pipefail
PATTERNS=${1:-${COAGENTS_HYGIENE_PATTERNS:?pattern file required}}
shift || true
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
regex=$(grep -v '^\s*$' "$PATTERNS" | paste -sd'|' -)
hits=0
report() { echo "HIT $1"; hits=$((hits + 1)); }

# 1. File names and contents of every tracked file.
while IFS= read -r f; do
  echo "$f" | grep -qiE "$regex" && report "name: $f"
  grep -qiIE "$regex" "$f" 2>/dev/null && report "content: $f"
done < <(git ls-files)

# 2. Build outputs, including source maps and package metadata of our own packages.
for d in apps/*/dist packages/*/dist "$@"; do
  [ -d "$d" ] || continue
  while IFS= read -r f; do
    echo "$f" | grep -qiE "$regex" && report "name: $f"
    grep -qiaE "$regex" "$f" && report "content: $f"
  done < <(find "$d" -type f)
done

echo "scanned with $(grep -vc '^\s*$' "$PATTERNS") pattern(s); hits: $hits"
[ "$hits" -eq 0 ]
