import { locations } from './locations.ts'
import { optionalRepo, repoSlug } from './repo.ts'
import { environmentRepo } from './target-repo/target.ts'
import type { VocabularySources } from './vocabulary.ts'

/** The three variables `locations` resolves from, one per line, empty when unset: the hooks run without `process`. */
const ENVIRONMENT = 'printf "%s\\n%s\\n%s" "$SIDE_PROJECTS_MANAGER_HOME" "$SIDE_PROJECTS_MANAGED_LOCATION" "$HOME"'

/** The part of the engine the sources read from. */
export interface Engine {
  session: { cwd(): Promise<string> }
  fs: { read(path: string): Promise<unknown> }
  process: { run(argv: string[]): Promise<{ exitCode: number; stdout: string }> }
}

/** `checkoutRoot` is this checkout's own root, where the manager home falls back to. */
export function vocabularySources($: Engine, checkoutRoot: string): VocabularySources {
  return {
    cwd: () => $.session.cwd(),
    async managed() {
      const { stdout } = await $.process.run(['sh', '-c', ENVIRONMENT])
      const [SIDE_PROJECTS_MANAGER_HOME, SIDE_PROJECTS_MANAGED_LOCATION, HOME] = stdout.split('\n')
      return locations({ SIDE_PROJECTS_MANAGER_HOME, SIDE_PROJECTS_MANAGED_LOCATION, HOME }, checkoutRoot).managed
    },
    async session() {
      const { exitCode, stdout } = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
      if (exitCode !== 0) throw new Error('gh repo view failed')
      return repoSlug(stdout.trim())
    },
    environment: () => environmentRepo(argv => $.process.run(argv), optionalRepo),
    async read(path) {
      const text = await $.fs.read(path)
      return typeof text === 'string' ? text : null
    },
  }
}
