#!/usr/bin/env bash
set -euo pipefail

# Re-runs the ADR number check on every open pull request's merge result
# with the master that exists now, and reports it as a commit status on the
# pull request's head, so nobody has to push to it. Run from a checkout of
# master with `origin` pointing at the repository.

CONTEXT="ADR numbers are unique"
check="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/scripts/check-adr-numbers.ts"
base="$(git rev-parse HEAD)"

report() {  # sha, state, description
  gh api "repos/$REPO/statuses/$1" \
    -f state="$2" -f context="$CONTEXT" -f description="${3:0:140}" >/dev/null
}

git config user.name "adr-recheck"
git config user.email "adr-recheck@users.noreply.github.com"

while read -r number sha; do
  git fetch --quiet origin "pull/$number/head"
  git checkout --quiet --detach "$base"
  if ! git merge --quiet --no-edit "$sha" >/dev/null 2>&1; then
    # A conflict is the rebase flow's to surface; there is no merge result to check.
    git merge --abort 2>/dev/null || true
    continue
  fi
  if problems="$(node "$check" "$PWD/docs/adr" 2>&1)"; then
    report "$sha" success "No ADR number is claimed twice"
  else
    report "$sha" failure "${problems//$'\n'/; }"
  fi
done < <(gh pr list --repo "$REPO" --state open --limit 200 --json number,headRefOid \
  --jq '.[] | "\(.number) \(.headRefOid)"')

git checkout --quiet --detach "$base"
