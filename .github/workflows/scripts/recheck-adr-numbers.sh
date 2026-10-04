#!/usr/bin/env bash
set -euo pipefail

# Re-runs the ADR number check on every open pull request's merge result
# with the master that exists now, and reports it as a commit status on the
# pull request's head, so nobody has to push to it. Run from a checkout of
# master with full history and `origin` pointing at the repository.

# Deliberately the name of the "ADR numbers are unique" step in ci.yml, so a
# rename there must be made here too (and in this script's test).
CONTEXT="ADR numbers are unique"
check_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/scripts/check-adr-numbers.ts"
base="$(git rev-parse HEAD)"
run_url="${GITHUB_SERVER_URL:-https://github.com}/$REPO/actions/runs/${GITHUB_RUN_ID:-0}"

report() {  # sha, state, description
  gh api "repos/$REPO/statuses/$1" \
    -f state="$2" -f context="$CONTEXT" -f description="${3:0:140}" \
    -f target_url="$run_url" >/dev/null
}

git config user.name "adr-recheck"
git config user.email "adr-recheck@users.noreply.github.com"

# Same cap as rebase.sh's listings; open pull requests past it go unchecked.
while read -r number sha; do
  git fetch --quiet origin "pull/$number/head"
  git checkout --quiet --detach "$base"
  if ! git merge --quiet --no-edit "$sha"; then
    # Only a conflict (unmerged paths) is expected; anything else fails the run.
    if [ -z "$(git diff --name-only --diff-filter=U)" ]; then
      echo "merging pull request $number failed for a reason other than a conflict" >&2
      exit 1
    fi
    git merge --abort
    # There is no merge result to check; replace any earlier status on this head.
    report "$sha" error "Not checked: merge conflict"
    continue
  fi
  if problems="$(node "$check_script" "$PWD/docs/adr" 2>&1)"; then
    report "$sha" success "No ADR number is claimed twice"
  else
    echo "pull request $number:"
    echo "$problems"
    # The description is too short for file names; the run log carries them.
    numbers="$(grep -oE '^ADR [0-9]+' <<<"$problems" | paste -sd, -)"
    report "$sha" failure "$numbers claimed twice; file names are in the run log"
  fi
done < <(gh pr list --repo "$REPO" --state open --limit 500 --json number,headRefOid \
  --jq '.[] | "\(.number) \(.headRefOid)"')

git checkout --quiet --detach "$base"
