declare const repoSlugBrand: unique symbol
declare const absolutePathBrand: unique symbol

/** A repo as `owner/repo`; values enter through `repoSlug` or `isRepoSlug`. */
export type RepoSlug = string & { readonly [repoSlugBrand]: true }
/** An absolute filesystem path; values enter through `absolutePath` or `isAbsolutePath`. */
export type AbsolutePath = string & { readonly [absolutePathBrand]: true }

export type CiState = 'passing' | 'failing' | 'running' | 'none'

/** One project of the registry, as the switcher reads it. */
export interface RegisteredProject {
  repo: RepoSlug
  turbo: boolean
}

/** One registered project as the pane shows it; the contract's `ProjectRow`, with the repo branded. */
export type ProjectRow =
  | ({ reachable: true; ready: number; openPullRequests: number; ci: CiState } & RegisteredProject)
  | ({ reachable: false; reason: string } & RegisteredProject)


const slugPattern = /^[\w.-]+\/[\w.-]+$/

/** Whether `value` is shaped like `owner/repo`. */
export function isRepoSlug(value: string): value is RepoSlug {
  return slugPattern.test(value)
}

/** Narrows `value` to a `RepoSlug`, throwing if it is not shaped like one. */
export function repoSlug(value: string): RepoSlug {
  if (!isRepoSlug(value)) throw new TypeError(`Not a repo slug, expected owner/repo: ${JSON.stringify(value)}`)
  return value
}

/** Whether `value` is an absolute path. */
export function isAbsolutePath(value: string): value is AbsolutePath {
  return value.startsWith('/')
}

/** Narrows `value` to an `AbsolutePath`, throwing if it is not one. */
export function absolutePath(value: string): AbsolutePath {
  if (!isAbsolutePath(value)) throw new TypeError(`Not an absolute path: ${JSON.stringify(value)}`)
  return value
}

/** `relative` under `base`, however many trailing slashes `base` has. */
export function joinPath(base: AbsolutePath, relative: string): AbsolutePath {
  return absolutePath(`${base.replace(/\/+$/, '')}/${relative}`)
}

/** The result of one process the switcher runs. */
export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Runs a command; the switcher only ever runs `gh`. */
export type Run = (command: string[]) => Promise<ProcessResult>

/** The projects of a registry document, in its order; throws naming what is wrong with a document or entry that is not one. */
export function registeredProjects(text: string): RegisteredProject[] {
  let registry: unknown
  try {
    registry = JSON.parse(text)
  } catch {
    throw new Error('The registry is not valid JSON')
  }
  const projects = (registry as { projects?: unknown } | null)?.projects
  if (!Array.isArray(projects)) throw new Error('The registry has no projects list')
  return projects.map((project, index) => {
    if (typeof project?.repo !== 'string' || !isRepoSlug(project.repo)) {
      throw new Error(`Registry entry ${index + 1} has no owner/repo repo: ${JSON.stringify(project?.repo)}`)
    }
    return { repo: project.repo, turbo: project.turbo === true }
  })
}

async function gh(run: Run, args: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await run(['gh', ...args])
  if (exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr.trim()}`)
  return stdout.trim()
}

/** The CI state of the newest run that finished with a verdict or is still going; cancelled and skipped runs say nothing. */
function ciStateOfLatestRun(runs: string): CiState {
  const verdicts = (JSON.parse(runs) as { status: string; conclusion: string }[]).filter(
    run => run.status !== 'completed' || (run.conclusion !== 'cancelled' && run.conclusion !== 'skipped'),
  )
  const latest = verdicts[0]
  if (latest === undefined) return 'none'
  if (latest.status !== 'completed') return 'running'
  return latest.conclusion === 'success' ? 'passing' : 'failing'
}

/** One row per registered project; a project the tracker cannot be read for is a row marked unreachable, never dropped. */
export function projectRows(run: Run, projects: RegisteredProject[]): Promise<ProjectRow[]> {
  return Promise.all(
    projects.map(async ({ repo, turbo }): Promise<ProjectRow> => {
      try {
        const branch = await gh(run, ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
        const [ready, pulls, runs] = await Promise.all([
          gh(run, ['issue', 'list', '--repo', repo, '--label', 'ready-for-agent', '--state', 'open', '--limit', '1000', '--json', 'number', '--jq', 'length']),
          gh(run, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number', '--jq', 'length']),
          gh(run, ['run', 'list', '--repo', repo, '--branch', branch, '--event', 'push', '--limit', '10', '--json', 'status,conclusion']),
        ])
        return { reachable: true, repo, turbo, ready: Number(ready), openPullRequests: Number(pulls), ci: ciStateOfLatestRun(runs) }
      } catch (error) {
        return { reachable: false, repo, turbo, reason: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
}

/** Where a project's clone lives: under the managed location, by its slug. */
export function clonePath(managedLocation: AbsolutePath, repo: RepoSlug): AbsolutePath {
  return joinPath(managedLocation, repo)
}
