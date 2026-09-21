#!/usr/bin/env bash
# Registers the trigger docs/specs/morning-loop.md calls for: an hourly
# schedule (cron), which just calls morning-run.ts (src/bin/morning-run.ts).
# The invocation lease inside it is what stops two firings overlapping — with
# a manual `npm run morning-run` too.
#
# Idempotent: re-running leaves an up-to-date registration alone, and
# replaces a stale one — whether that's a leftover daily cron line, a cron
# line pointing at a checkout that has since moved, or a logon-guard rc
# block — with the current registration.
#
# Not run automatically by anything in this repo — it edits the developer's
# own crontab and shell rc files, which is the developer's call to make, not
# a build step's.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIGGER_SCRIPT="$REPO_DIR/src/bin/morning-run.ts"
LOG_FILE="${SIDE_PROJECTS_MANAGER_HOME:-$REPO_DIR}/trigger.log"
NODE_BIN="$(command -v node)"

# Cron runs with PATH=/usr/bin:/bin, so a tool installed anywhere else —
# `gh` in ~/.local/bin, say — resolves from this shell and then fails with
# ENOENT on every firing. The line carries its own PATH instead: the
# directory of every tool the loop shells out to, as this shell resolves it,
# ahead of the system directories. `gh` and `git` are required; the rest are
# included when present.
cron_path() {
  local tool dir dirs=()
  for tool in gh git; do
    if ! command -v "$tool" >/dev/null; then
      echo "install-triggers: '$tool' is not on PATH; the loop cannot run without it." >&2
      exit 1
    fi
  done
  for tool in node gh git docker claude; do
    command -v "$tool" >/dev/null || continue
    dir="$(dirname "$(command -v "$tool")")"
    [[ " ${dirs[*]-} " == *" $dir "* ]] || dirs+=("$dir")
  done
  for dir in /usr/local/bin /usr/bin /bin; do
    [[ " ${dirs[*]} " == *" $dir "* ]] || dirs+=("$dir")
  done
  (IFS=:; echo "${dirs[*]}")
}
CRON_PATH="$(cron_path)"

# Cron sources neither .bashrc nor .zshrc, so the credentials in the env file
# setup-wizard.sh writes — CLAUDE_CODE_OAUTH_TOKEN and the GitHub tokens —
# never reach a firing unless the line loads that file itself. Crontab-level
# variable lines are not enough on their own: anything else that rewrites the
# crontab can drop them, and the run then fails on a missing token.
ENV_FILE="$HOME/.side-projects-manager.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "install-triggers: $ENV_FILE is missing; run scripts/setup-wizard.sh first." >&2
  exit 1
fi

CRON_MARKER_OLD="# side-projects-manager: daily schedule (see scripts/install-triggers.sh)"
CRON_MARKER="# side-projects-manager: hourly schedule (see scripts/install-triggers.sh)"
CRON_LINE="0 * * * * set -a; . \"$ENV_FILE\"; set +a; PATH=\"$CRON_PATH\" $NODE_BIN \"$TRIGGER_SCRIPT\" >> \"$LOG_FILE\" 2>&1 $CRON_MARKER"

RC_BEGIN="# >>> side-projects-manager: logon guard >>>"
RC_END="# <<< side-projects-manager: logon guard <<<"

install_cron() {
  local existing status
  existing="$(crontab -l 2>/dev/null || true)"
  if grep -qxF "$CRON_LINE" <<<"$existing" && ! grep -qF "$CRON_MARKER_OLD" <<<"$existing"; then
    echo "cron: already installed, leaving it alone."
    return
  fi
  if grep -qF "$CRON_MARKER_OLD" <<<"$existing"; then
    status="cron: replaced the daily line with the hourly one."
  elif grep -qF "$CRON_MARKER" <<<"$existing"; then
    status="cron: updated the hourly line."
  else
    status="cron: installed, firing hourly."
  fi
  {
    if [ -n "$existing" ]; then
      printf '%s\n' "$existing" | grep -vF "$CRON_MARKER_OLD" | grep -vF "$CRON_MARKER" || true
    fi
    echo "$CRON_LINE"
  } | crontab -
  echo "$status"
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
    function flush() { if (buffered) print buf; buffered = 0 }
    $0 == begin {
      if (buffered && buf == "") { buffered = 0 } else { flush() }
      inside = 1
      next
    }
    inside && $0 == end { inside = 0; next }
    inside { next }
    { flush(); buf = $0; buffered = 1 }
    END { flush() }
  ' "$rc" >"$tmp"
  cat "$tmp" >"$rc"
  rm -f "$tmp"
  echo "$rc: logon guard removed."
}

install_cron
remove_logon_guard "$HOME/.bashrc"
remove_logon_guard "$HOME/.zshrc"
