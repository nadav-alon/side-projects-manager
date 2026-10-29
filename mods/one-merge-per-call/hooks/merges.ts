const MERGE = /\bgh\s+pr\s+merge\b/g
const LOOP = /\b(for|while|until)\b[\s\S]*\bdo\b|\b(xargs|parallel)\b/

/**
 * Whether the command can run `gh pr merge` more than once: it names the merge twice or more
 * (chained or piped), or names it once inside a loop or behind `xargs`/`parallel`.
 */
export function mergesMoreThanOnce(command: string): boolean {
  const merges = command.match(MERGE)?.length ?? 0
  return merges >= 2 || (merges === 1 && LOOP.test(command))
}
