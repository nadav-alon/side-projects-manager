#!/usr/bin/env bash
# The self-update step of the cron line scripts/install-triggers.sh registers:
# fast-forwards the checkout in $1, and leaves git's reason where the loop
# reads it when the pull fails, for the summary to name.
#
# The reason goes to self-update-failure.txt under the manager home, unless the
# loop already announced this failing streak (self-update-failure.announced),
# so a streak is told once rather than every 15 minutes. A pull that succeeds
# ends the streak and clears both files.
#
# The body is one braced group ending in `exit`: the pull rewrites this very
# file, and bash must not read on past the group into the new contents.
{
  repo_dir="$1"
  home="${SIDE_PROJECTS_MANAGER_HOME:-$repo_dir}"
  failure="$home/self-update-failure.txt"
  announced="$home/self-update-failure.announced"
  if reason="$(git -C "$repo_dir" pull --ff-only -q 2>&1)"; then
    rm -f "$failure" "$announced"
  else
    [ -n "$reason" ] || reason="git exited non-zero with no message"
    printf '%s\n' "$reason" >&2
    [ -e "$announced" ] || printf '%s\n' "$reason" >"$failure"
  fi
  exit 0
}
