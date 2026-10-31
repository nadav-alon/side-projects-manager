#!/usr/bin/env bash
# Runs `claude plugin test` on each mod under MODS_DIR (default: mods/ beside this script) whose
# tests are written with claude-code/testing, and exits 1 when any of them fails. A mod without such
# a test is skipped: its tests, if any, run under `npm test`. `claude plugin test` takes a folder and
# runs every test file in it, so it is given a copy of the mod without the test files that do not import
# claude-code/testing; a node:test file would fail there on its import. CLAUDE names the binary (default: claude).
# It also exits 1 when MODS_DIR is missing or no mod was tested, so a renamed directory cannot pass.
set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
source "$here/mods.sh"
mods_dir="${1:-$here/../mods}"
claude="${CLAUDE:-claude}"
failed=()
tested=0
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# The test files under a folder, node_modules aside: the one list the gate and the copy's filter both read.
test_files() {
  find "$1" -name node_modules -prune -o \( -name '*.test.ts' -o -name '*.test.tsx' \) -print
}

if [[ ! -d "$mods_dir" ]]; then
  echo "No mods directory: $mods_dir" >&2
  exit 1
fi

while IFS= read -r dir; do
  name="${dir##*/}"
  [[ -n "$(test_files "$dir" | xargs -r grep -l "claude-code/testing")" ]] || continue
  echo "== $name"
  tested=$((tested + 1))
  hook_tests="$scratch/$name"
  cp -R "$dir" "$hook_tests"
  while IFS= read -r file; do
    grep -q "claude-code/testing" "$file" || rm "$file"
  done < <(test_files "$hook_tests")
  "$claude" plugin test "$hook_tests" || failed+=("$name")
done < <(_mods_with_manifest "$mods_dir")

if ((tested == 0)); then
  echo "No mod under $mods_dir has claude-code/testing tests" >&2
  exit 1
fi

if ((${#failed[@]} > 0)); then
  echo "Hook tests failed: ${failed[*]}" >&2
  exit 1
fi
