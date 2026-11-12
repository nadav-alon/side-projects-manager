/** What running a command comes to, as the mod API reports it. */
type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>

/**
 * Claude Code's session-logs folder: `projects` under the Claude config directory, which is
 * `CLAUDE_CONFIG_DIR` when set and `~/.claude` otherwise. The mod API has no environment access, so
 * the shell resolves it. `undefined` when it cannot be resolved, which leaves the reader on its
 * loop-only figure.
 */
export async function sessionLogsFolder(run: Run): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await run(['sh', '-c', 'printf %s "${CLAUDE_CONFIG_DIR:-${HOME:+$HOME/.claude}}"'])
    const configDir = stdout.trim().replace(/\/+$/, '')
    return exitCode === 0 && configDir !== '' ? `${configDir}/projects` : undefined
  } catch {
    return undefined
  }
}
