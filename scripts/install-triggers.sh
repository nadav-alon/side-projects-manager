#!/usr/bin/env bash
# Registers the two triggers docs/specs/morning-loop.md calls for: a daily
# schedule (cron) and a first-logon-of-the-day guard (a shell rc snippet).
# Both just call morning-run.ts (src/bin/morning-run.ts); the invocation lease
# inside it is what stops them double-firing — with a manual `npm run
# morning-run` too — so neither registration here needs to know about the
# other.
#
# Idempotent: re-running leaves an up-to-date registration alone, and rewrites
# an rc block left behind by an older version of this script, so this is safe
# to run again after a checkout moves or after the snippet below changes.
#
# Not run automatically by anything in this repo — it edits the developer's
# own crontab and shell rc files, which is the developer's call to make, not
# a build step's.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIGGER_SCRIPT="$REPO_DIR/src/bin/morning-run.ts"
LOG_FILE="${SIDE_PROJECTS_MANAGER_HOME:-$REPO_DIR}/trigger.log"
NODE_BIN="$(command -v node)"
SCHEDULE_HOUR=8

CRON_MARKER="# side-projects-manager: daily schedule (see scripts/install-triggers.sh)"
CRON_LINE="0 $SCHEDULE_HOUR * * * $NODE_BIN \"$TRIGGER_SCRIPT\" >> \"$LOG_FILE\" 2>&1 $CRON_MARKER"

# The background job runs inside a subshell so the interactive shell never
# registers it as one of its own jobs. Backgrounding directly in the rc file
# makes an interactive shell print "[1] <pid>" over the prompt at every login;
# `disown` cannot suppress that, because the job line is printed when the job
# is created, before disown gets a chance to run.
RC_BEGIN="# >>> side-projects-manager: logon guard >>>"
RC_END="# <<< side-projects-manager: logon guard <<<"
RC_BLOCK="$RC_BEGIN
( \"$NODE_BIN\" \"$TRIGGER_SCRIPT\" >> \"$LOG_FILE\" 2>&1 & )
$RC_END"

install_cron() {
  local existing
  existing="$(crontab -l 2>/dev/null || true)"
  if grep -qF "$CRON_MARKER" <<<"$existing"; then
    echo "cron: already installed, leaving it alone."
    return
  fi
  { printf '%s\n' "$existing" | grep -v '^$' || true; echo "$CRON_LINE"; } | crontab -
  echo "cron: installed, firing daily at ${SCHEDULE_HOUR}:00."
}

# The marked block as it currently stands in $1, markers included, so an
# already-installed rc can be compared against the block we would write now.
current_rc_block() {
  awk -v begin="$RC_BEGIN" -v end="$RC_END" '
    $0 == begin { inside = 1 }
    inside { print }
    inside && $0 == end { exit }
  ' "$1"
}

# Replaces the marked block in $1 with $RC_BLOCK, leaving the rest of the file
# — and the file itself, same inode and permissions — untouched.
rewrite_rc_block() {
  local rc="$1" tmp
  tmp="$(mktemp)"
  awk -v begin="$RC_BEGIN" -v end="$RC_END" -v block="$RC_BLOCK" '
    $0 == begin { print block; inside = 1; next }
    inside && $0 == end { inside = 0; next }
    inside { next }
    { print }
  ' "$rc" >"$tmp"
  cat "$tmp" >"$rc"
  rm -f "$tmp"
}

install_logon_guard() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  if grep -qF "$RC_BEGIN" "$rc"; then
    if [ "$(current_rc_block "$rc")" = "$RC_BLOCK" ]; then
      echo "$rc: already installed, leaving it alone."
    else
      rewrite_rc_block "$rc"
      echo "$rc: updated to the current guard snippet."
    fi
    return
  fi
  printf '\n%s\n' "$RC_BLOCK" >>"$rc"
  echo "$rc: installed."
}

install_cron
install_logon_guard "$HOME/.bashrc"
install_logon_guard "$HOME/.zshrc"
