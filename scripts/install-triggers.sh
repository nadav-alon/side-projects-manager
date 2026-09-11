#!/usr/bin/env bash
# Registers the two triggers docs/specs/morning-loop.md calls for: a daily
# schedule (cron) and a first-logon-of-the-day guard (a shell rc snippet).
# Both just call guarded-morning-run.ts (src/bin/guarded-morning-run.ts); the
# once-per-day lock inside it is what stops them double-firing, so neither
# registration here needs to know about the other.
#
# Idempotent: re-running updates nothing if both are already registered, so
# this is safe to run again after a checkout moves.
#
# Not run automatically by anything in this repo — it edits the developer's
# own crontab and shell rc files, which is the developer's call to make, not
# a build step's.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIGGER_SCRIPT="$REPO_DIR/src/bin/guarded-morning-run.ts"
LOG_FILE="${SIDE_PROJECTS_MANAGER_HOME:-$REPO_DIR}/trigger.log"
NODE_BIN="$(command -v node)"
SCHEDULE_HOUR="${TRIGGER_HOUR:-8}"

CRON_MARKER="# side-projects-manager: daily schedule (see scripts/install-triggers.sh)"
CRON_LINE="0 $SCHEDULE_HOUR * * * $NODE_BIN \"$TRIGGER_SCRIPT\" >> \"$LOG_FILE\" 2>&1 $CRON_MARKER"

RC_BEGIN="# >>> side-projects-manager: logon guard >>>"
RC_END="# <<< side-projects-manager: logon guard <<<"
RC_BLOCK="$RC_BEGIN
\"$NODE_BIN\" \"$TRIGGER_SCRIPT\" >> \"$LOG_FILE\" 2>&1 &
disown 2>/dev/null || true
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

install_logon_guard() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  if grep -qF "$RC_BEGIN" "$rc"; then
    echo "$rc: already installed, leaving it alone."
    return
  fi
  printf '\n%s\n' "$RC_BLOCK" >>"$rc"
  echo "$rc: installed."
}

install_cron
install_logon_guard "$HOME/.bashrc"
install_logon_guard "$HOME/.zshrc"
