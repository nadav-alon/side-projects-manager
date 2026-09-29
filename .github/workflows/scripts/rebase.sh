#!/usr/bin/env bash
set -euo pipefail

# Both read by rebase.yml's "Reply with the failure" step: the command that
# broke, and what it said. Stderr is teed so it still reaches the run log.
exec 2> >(tee "${RUNNER_TEMP}/rebase-stderr.txt" >&2)
trap 'printf "%s\n" "$BASH_COMMAND" > "${RUNNER_TEMP}/rebase-command.txt"' ERR

trimmed="$(printf '%s' "$COMMENT_BODY" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [[ "$trimmed" != "/rebase" ]]; then
  exit 0
fi

# The REST issue-comments endpoint, not `gh issue comment`: the
# comment may be on a pull request, whose number `gh issue` refuses.
reply() {
  gh api "repos/$REPO/issues/$ISSUE_NUMBER/comments" -f body="$1" >/dev/null
}

# Best effort: refused where the label already exists, which is the
# usual case.
ensure_label() {  # name, description, repo
  gh label create "$1" --repo "$3" --description "$2" >/dev/null 2>&1 || true
}

# The error a best-effort call wrote, as one line fit for a comment.
flatten_err() {
  local why; why="$(<"$1")"
  printf '%s' "${why//$'\n'/ }"
}

# GitHub's nine closing keywords up to the `#`, starting at a word
# boundary. Matched case-insensitively. Written in the ERE subset
# both grep and jq's regex engine read alike, so one copy serves both.
CLOSING_KEYWORD='(^|[^[:alnum:]_])(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]*#'

# The first Closes/Fixes/Resolves #N in $1.
closing_number() {
  grep -ioE "${CLOSING_KEYWORD}[0-9]+" <<<"$1" \
    | head -n1 \
    | grep -oE '[0-9]+' \
    || true
}

# Bodies saved from the web UI end their lines in \r\n, which would
# keep every `$`-anchored line match below from ever matching.
issue_body="${ISSUE_BODY//$'\r'/}"

PULL_REQUEST_NUMBER=""
PULL_REQUEST_URL=""
PULL_REQUEST_REPO=""
TICKET_NUMBER=""
FAIL_REASON=""

if [[ "$IS_PULL_REQUEST" == "true" ]]; then
  # On a pull request: that pull request, open.
  pull_request_json="$(gh pr view "$ISSUE_NUMBER" --repo "$REPO" --json number,state,body,url)"
  pull_request_state="$(jq -r .state <<<"$pull_request_json")"
  if [[ "$pull_request_state" != "OPEN" ]]; then
    FAIL_REASON="that pull request is not open (state: $pull_request_state), so there is nothing to rebase."
  else
    candidate_ticket_number="$(closing_number "$(jq -r .body <<<"$pull_request_json")")"
    if [[ -z "$candidate_ticket_number" ]]; then
      FAIL_REASON="its body names no Closes/Fixes/Resolves #N, so I can't tell which ticket it is for."
    else
      PULL_REQUEST_NUMBER="$ISSUE_NUMBER"
      PULL_REQUEST_URL="$(jq -r .url <<<"$pull_request_json")"
      PULL_REQUEST_REPO="$REPO"
      TICKET_NUMBER="$candidate_ticket_number"
    fi
  fi
elif grep -qE '^Review https?://' <<<"$issue_body"; then
  # On a review ticket (open or closed): the URL and #N from its
  # fixed body line, read back the way it was written.
  review_line="$(grep -m1 -E '^Review (\S+), the draft pull request opened for #[0-9]+\.$' <<<"$issue_body" || true)"
  if [[ -z "$review_line" ]]; then
    FAIL_REASON="this looks like a review ticket, but no line of its body reads \`Review <url>, the draft pull request opened for #N.\`, so I can't tell which pull request it is for."
  else
    candidate_url="$(sed -E 's@^Review (\S+), the draft pull request opened for #([0-9]+)\.$@\1@' <<<"$review_line")"
    candidate_ticket_number="$(sed -E 's@^Review (\S+), the draft pull request opened for #([0-9]+)\.$@\2@' <<<"$review_line")"
    if [[ ! "$candidate_url" =~ ^https://github\.com/([^/]+/[^/]+)/pull/([0-9]+)$ ]]; then
      FAIL_REASON="its Review line names $candidate_url, which is not a pull request URL."
    else
      candidate_repo="${BASH_REMATCH[1]}"
      candidate_number="${BASH_REMATCH[2]}"
      # Not guarded: a pull request that can't be read is an error
      # for rebase.yml's "Reply with the failure" step to report, not
      # a pull request that is closed.
      pull_request_json="$(gh pr view "$candidate_number" --repo "$candidate_repo" --json number,state,url)"
      pull_request_state="$(jq -r .state <<<"$pull_request_json")"
      if [[ "$pull_request_state" != "OPEN" ]]; then
        FAIL_REASON="its pull request ($candidate_url) is not open (state: $pull_request_state), so there is nothing to rebase."
      else
        PULL_REQUEST_NUMBER="$candidate_number"
        PULL_REQUEST_URL="$(jq -r .url <<<"$pull_request_json")"
        PULL_REQUEST_REPO="$candidate_repo"
        TICKET_NUMBER="$candidate_ticket_number"
      fi
    fi
  fi
else
  # On an implementation ticket: only if exactly one open pull
  # request closes it, draft or ready.
  TICKET_NUMBER="$ISSUE_NUMBER"
  matches="$(gh pr list --repo "$REPO" --state open --json number,url,body --limit 500 \
    | jq -c --arg keyword "$CLOSING_KEYWORD" --arg ticket_number "$TICKET_NUMBER" '[.[] | select(.body | test($keyword + $ticket_number +"([^0-9]|$)"; "i"))]')"
  count="$(jq 'length' <<<"$matches")"
  if [[ "$count" == "0" ]]; then
    FAIL_REASON="no open pull request closes #$TICKET_NUMBER, so there is nothing to rebase."
  elif [[ "$count" -gt 1 ]]; then
    FAIL_REASON="$count open pull requests close #$TICKET_NUMBER, so I can't tell which one to rebase."
  else
    PULL_REQUEST_NUMBER="$(jq -r '.[0].number' <<<"$matches")"
    PULL_REQUEST_URL="$(jq -r '.[0].url' <<<"$matches")"
    PULL_REQUEST_REPO="$REPO"
  fi
fi

if [[ -n "$FAIL_REASON" ]]; then
  reply "Can't open a rebase ticket here: $FAIL_REASON"
  exit 0
fi

expected_line="Rebase $PULL_REQUEST_URL, the pull request opened for #$TICKET_NUMBER."
# A ticket opened before this workflow dropped "draft" still reads
# this way; without it, a comment on the same pull request would
# open a second ticket rather than finding the first.
legacy_line="Rebase $PULL_REQUEST_URL, the draft pull request opened for #$TICKET_NUMBER."
existing_number="$(gh issue list --repo "$REPO" --state open --json number,body --limit 500 \
  | jq -r --arg line "$expected_line" --arg legacy_line "$legacy_line" \
    '[.[] | select((.body | contains($line)) or (.body | contains($legacy_line)))][0].number // empty')"

if [[ -n "$existing_number" ]]; then
  reply "There is already an open rebase ticket for this: #$existing_number."
  exit 0
fi

title="Rebase #$PULL_REQUEST_NUMBER"
body="$expected_line"

ensure_label ready-for-agent "Fully specified, ready for an AFK agent" "$REPO"

# A refusal here is rebase.yml's "Reply with the failure" step's to
# report, which knows to say nothing was created.
create_out="$(gh issue create --repo "$REPO" --title "$title" --body "$body" --label ready-for-agent)"

new_url="$(printf '%s' "$create_out" | tail -n1 | tr -d '[:space:]')"
new_number="$(grep -oE '[0-9]+$' <<<"$new_url")"

# The issue exists by now, so a refused link is reported rather than
# failed on; the reply says which fallback, if any, took its place.
link_note=""
link_err="${RUNNER_TEMP}/rebase-link-err.txt"
if ! issue_id="$(gh api "repos/$REPO/issues/$new_number" --jq .id 2>"$link_err")" \
  || ! gh api --method POST "repos/$REPO/issues/$TICKET_NUMBER/sub_issues" -F "sub_issue_id=$issue_id" >/dev/null 2>"$link_err"; then
  link_why="$(flatten_err "$link_err")"
  if gh issue edit "$new_number" --repo "$REPO" --body "Part of #$TICKET_NUMBER."$'\n\n'"$body" >/dev/null 2>"$link_err"; then
    link_note=" It isn't linked as a sub-issue of #$TICKET_NUMBER (${link_why}), so its body opens with \`Part of #$TICKET_NUMBER.\` instead."
  else
    edit_why="$(flatten_err "$link_err")"
    link_note=" It isn't linked to #$TICKET_NUMBER at all: the sub-issue link was refused (${link_why}), and so was adding \`Part of #$TICKET_NUMBER.\` to its body (${edit_why}). Link it by hand."
  fi
fi

# The ticket is open by now regardless of what follows: a refused
# label is reported below, never undoes it. When PULL_REQUEST_REPO
# differs from REPO — the review-ticket branch above — github.token
# is scoped to REPO only, so the label is refused every time, not
# just on occasion.
label_note=""
label_err="${RUNNER_TEMP}/rebase-label-err.txt"
ensure_label needs-rebase "Not mergeable: waiting on a rebase" "$PULL_REQUEST_REPO"
if ! gh pr edit "$PULL_REQUEST_NUMBER" --repo "$PULL_REQUEST_REPO" --add-label needs-rebase >/dev/null 2>"$label_err"; then
  label_why="$(flatten_err "$label_err")"
  label_note=" Couldn't label $PULL_REQUEST_URL \`needs-rebase\` (${label_why}). Add it by hand."
fi

gh api "repos/$REPO/issues/comments/$COMMENT_ID/reactions" -f content=eyes >/dev/null 2>&1 || true
reply "Opened $new_url to rebase.$link_note$label_note"
