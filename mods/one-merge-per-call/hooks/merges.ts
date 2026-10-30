const MERGE_SOURCE = String.raw`\bgh\s+(?:-\S+\s+(?:(?!pr\s)[^\s-]\S*\s+)?)*pr\s+merge\b`
const MERGE = new RegExp(MERGE_SOURCE, 'g')
const REPEATS = new RegExp(
  String.raw`\b(?:for|while|until)\b[^;\n]*[;\n]\s*do\b(?:(?!\bdone\b)[\s\S])*?${MERGE_SOURCE}` +
    String.raw`|\b(?:xargs|parallel)\b[^;&|\n]*${MERGE_SOURCE}`,
)

/** The command without text that never runs: quoted strings and `#` comments. */
function executable(command: string): string {
  return command
    .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""')
    .replace(/(^|\s)#.*$/gm, '$1')
}

/**
 * Whether the command can run `gh pr merge` more than once: it names the merge twice or more
 * (chained or piped), or names it once inside a loop body or as the command `xargs`/`parallel` runs.
 */
export function mergesMoreThanOnce(command: string): boolean {
  const code = executable(command)
  const merges = code.match(MERGE)?.length ?? 0
  return merges >= 2 || (merges === 1 && REPEATS.test(code))
}
