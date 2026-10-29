# Helpers for registering the mods under mods/ in Claude's settings.json.
# Sourced by setup-wizard.sh; needs jq.

# _mods_with_manifest MODS_DIR: prints the path of each folder under MODS_DIR that holds a plugin
# manifest, one per line. A folder without one is not a mod and is left out.
_mods_with_manifest() {
  local mods_dir="$1" dir
  for dir in "$mods_dir"/*/; do
    [[ -f "${dir}.claude-plugin/plugin.json" ]] && printf '%s\n' "${dir%/}"
  done
  return 0
}

# The one rule for whether a directory is listed in a CLAUDE_CODE_PLUGIN_DIRS value, as a jq def.
_JQ_LISTED='def listed($dir): (. // "") | split(":") | index($dir) != null;'

# _mod_registered SETTINGS DIR: succeeds when DIR is listed in the env block's
# CLAUDE_CODE_PLUGIN_DIRS in SETTINGS.
_mod_registered() {
  local settings="$1" dir="$2"
  [[ -f "$settings" ]] || return 1
  jq -e --arg dir "$dir" \
    "$_JQ_LISTED"' .env.CLAUDE_CODE_PLUGIN_DIRS | listed($dir)' \
    "$settings" >/dev/null 2>&1
}

# _register_mod_dir SETTINGS DIR: idempotently adds DIR to the env block's
# CLAUDE_CODE_PLUGIN_DIRS in SETTINGS, keeping every other setting and every
# directory already listed.
_register_mod_dir() {
  local settings="$1" dir="$2" tmp
  [[ -f "$settings" ]] || printf '{}\n' >"$settings"
  tmp=$(mktemp)
  jq --arg dir "$dir" "$_JQ_LISTED"'
    .env.CLAUDE_CODE_PLUGIN_DIRS as $dirs
    | .env = ((.env // {}) + {CLAUDE_CODE_PLUGIN_DIRS:
        (if ($dirs // "") == "" then $dir
         elif ($dirs | listed($dir)) then $dirs
         else $dirs + ":" + $dir end)})
  ' "$settings" >"$tmp" && cat "$tmp" >"$settings"
  local status=$?
  rm -f "$tmp"
  return $status
}

# _mod_hint DIR: the by-hand step that registers DIR.
_mod_hint() {
  printf "add %s to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json's env block" "$1"
}

# _register_mods MODS_DIR SETTINGS: offers to register each folder under MODS_DIR that holds a
# plugin manifest, naming each one. Needs the wizard's confirm, note, SKIPPED, GREEN and RESET.
# The folder list is read on fd 3 so confirm's read takes the user's answer, not the next folder.
_register_mods() {
  local mods_dir="$1" settings="$2" mod_dir mod_name mod_hint
  while IFS= read -r -u3 mod_dir; do
    mod_name="$(basename "$mod_dir")"
    mod_hint="$(_mod_hint "$mod_dir")"
    if _mod_registered "$settings" "$mod_dir"; then
      note "mods/$mod_name: already registered."
    elif confirm "Register mods/$mod_name in ~/.claude/settings.json?"; then
      mkdir -p "$(dirname "$settings")"
      if _register_mod_dir "$settings" "$mod_dir"; then
        printf '  %s✓%s settings.json: %s registered.\n' "$GREEN" "$RESET" "$mod_name"
      else
        SKIPPED+=("session mod $mod_name — ~/.claude/settings.json did not parse; $mod_hint by hand")
      fi
    else
      SKIPPED+=("session mod $mod_name — $mod_hint")
    fi
  done 3< <(_mods_with_manifest "$mods_dir")
}
