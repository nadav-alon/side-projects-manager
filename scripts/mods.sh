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

# _mod_registered SETTINGS DIR: succeeds when DIR is listed in the env block's
# CLAUDE_CODE_PLUGIN_DIRS in SETTINGS.
_mod_registered() {
  local settings="$1" dir="$2"
  [[ -f "$settings" ]] || return 1
  jq -e --arg dir "$dir" \
    '(.env.CLAUDE_CODE_PLUGIN_DIRS // "") | split(":") | index($dir) != null' \
    "$settings" >/dev/null 2>&1
}

# _register_mod_dir SETTINGS DIR: idempotently adds DIR to the env block's
# CLAUDE_CODE_PLUGIN_DIRS in SETTINGS, keeping every other setting and every
# directory already listed.
_register_mod_dir() {
  local settings="$1" dir="$2" tmp
  [[ -f "$settings" ]] || printf '{}\n' >"$settings"
  tmp=$(mktemp)
  jq --arg dir "$dir" '
    .env.CLAUDE_CODE_PLUGIN_DIRS as $dirs
    | .env = ((.env // {}) + {CLAUDE_CODE_PLUGIN_DIRS:
        (if ($dirs // "") == "" then $dir
         elif ($dirs | split(":") | index($dir)) != null then $dirs
         else $dirs + ":" + $dir end)})
  ' "$settings" >"$tmp" && cat "$tmp" >"$settings"
  local status=$?
  rm -f "$tmp"
  return $status
}
