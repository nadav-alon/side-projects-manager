#!/usr/bin/env bash
# Runs `claude plugin test` on each mod under MODS_DIR (default: mods/ beside this script) whose
# tests are written with claude-code/testing, and exits 1 when any of them fails. A mod without such
# a test is skipped: its tests, if any, run under `npm test`. CLAUDE names the binary (default: claude).
set -uo pipefail

mods_dir="${1:-$(dirname "${BASH_SOURCE[0]}")/../mods}"
claude="${CLAUDE:-claude}"
failed=()

for dir in "$mods_dir"/*/; do
  dir="${dir%/}"
  grep -rlq --include='*.test.ts' --include='*.test.tsx' --exclude-dir=node_modules \
    "claude-code/testing" "$dir" 2>/dev/null || continue
  echo "== ${dir##*/}"
  "$claude" plugin test "$dir" || failed+=("${dir##*/}")
done

if ((${#failed[@]} > 0)); then
  echo "Hook tests failed: ${failed[*]}" >&2
  exit 1
fi
