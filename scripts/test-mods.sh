#!/usr/bin/env bash
# Runs `claude plugin test` on each mod under MODS_DIR (default: mods/ beside this script) whose
# tests are written with claude-code/testing, and exits 1 when any of them fails. A mod without such
# a test is skipped: its tests, if any, run under `npm test`. CLAUDE names the binary (default: claude).
# It also exits 1 when MODS_DIR is missing or no mod was tested, so a renamed directory cannot pass.
set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
source "$here/mods.sh"
mods_dir="${1:-$here/../mods}"
claude="${CLAUDE:-claude}"
failed=()
tested=0

if [[ ! -d "$mods_dir" ]]; then
  echo "No mods directory: $mods_dir" >&2
  exit 1
fi

while IFS= read -r dir; do
  grep -rlq --include='*.test.ts' --include='*.test.tsx' --exclude-dir=node_modules \
    "claude-code/testing" "$dir" || continue
  echo "== ${dir##*/}"
  tested=$((tested + 1))
  "$claude" plugin test "$dir" || failed+=("${dir##*/}")
done < <(_mods_with_manifest "$mods_dir")

if ((tested == 0)); then
  echo "No mod under $mods_dir has claude-code/testing tests" >&2
  exit 1
fi

if ((${#failed[@]} > 0)); then
  echo "Hook tests failed: ${failed[*]}" >&2
  exit 1
fi
