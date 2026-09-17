#!/usr/bin/env bash
# Registers the trigger docs/specs/morning-loop.md calls for: an hourly
# schedule (cron), which just calls morning-run.ts (src/bin/morning-run.ts).
# The invocation lease inside it is what stops two firings overlapping — with
# a manual `npm run morning-run` too.
#
# Idempotent: re-running leaves an up-to-date registration alone. Running it
# on a machine with the old daily cron line and logon-guard rc blocks
# replaces the former with the hourly line and strips the latter, so this is
# safe to run again after upgrading from an older version of this script.
#
# Not run automatically by anything in this repo — it edits the developer's
# own crontab and shell rc files, which is the developer's call to make, not
# a build step's.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIGGER_SCRIPT="$REPO_DIR/src/bin/morning-run.ts"
LOG_FILE="${SIDE_PROJECTS_MANAGER_HOME:-$REPO_DIR}/trigger.log"
NODE_BIN="$(command -v node)"

CRON_MARKER_OLD="# side-projects-manager: daily schedule (see scripts/install-triggers.sh)"
CRON_MARKER="# side-projects-manager: hourly schedule (see scripts/install-triggers.sh)"
CRON_LINE="0 * * * * $NODE_BIN \"$TRIGGER_SCRIPT\" >> \"$LOG_FILE\" 2>&1 $CRON_MARKER"

RC_BEGIN="# >>> side-projects-manager: logon guard >>>"
RC_END="# <<< side-projects-manager: logon guard <<<"

install_cron() {
  local existing without_ours
  existing="$(crontab -l 2>/dev/null || true)"
  if grep -qxF "$CRON_LINE" <<<"$existing"; then
    echo "cron: already installed, leaving it alone."
    return
  fi
  without_ours="$(grep -vF "$CRON_MARKER_OLD" <<<"$existing" \
    | grep -vF "$CRON_MARKER" | grep -v '^$' || true)"
  { printf '%s\n' "$without_ours"; echo "$CRON_LINE"; } | crontab -
  if grep -qF "$CRON_MARKER_OLD" <<<"$existing"; then
    echo "cron: replaced the daily line with the hourly one."
  elif grep -qF "$CRON_MARKER" <<<"$existing"; then
    echo "cron: updated to the current schedule line."
  else
    echo "cron: installed, firing hourly."
  fi
}

# Removes the marked logon-guard block from $1, if present, leaving the rest
# of the file — and the file itself, same inode and permissions — untouched.
remove_logon_guard() {
  local rc="$1" tmp
  [ -f "$rc" ] || return 0
  if ! grep -qF "$RC_BEGIN" "$rc"; then
    echo "$rc: no logon guard to remove."
    return
  fi
  tmp="$(mktemp)"
  awk -v begin="$RC_BEGIN" -v end="$RC_END" '
    $0 == begin { inside = 1; next }
    inside && $0 == end { inside = 0; next }
    inside { next }
    { print }
  ' "$rc" >"$tmp"
  cat "$tmp" >"$rc"
  rm -f "$tmp"
  echo "$rc: logon guard removed."
}

install_cron
remove_logon_guard "$HOME/.bashrc"
remove_logon_guard "$HOME/.zshrc"
