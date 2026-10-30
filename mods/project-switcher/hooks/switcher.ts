import type { CiState, ProjectRow, RepoSlug } from '../types'

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

/** The result of one process the switcher runs. */
export interface Ran {
  exitCode: number
  stdout: string
  stderr: string
}

/** Runs a command; the switcher only ever runs `gh`. */
export type Run = (command: string[]) => Promise<Ran>

/** The projects of a registry document, in its order; `undefined` when it cannot be read as one. */
export function registeredProjects(text: string): { repo: RepoSlug; turbo: boolean }[] | undefined {
  let registry: unknown
  try {
    registry = JSON.parse(text)
  } catch {
    return undefined
  }
  const projects = (registry as { projects?: unknown } | null)?.projects
  if (!Array.isArray(projects)) return undefined
  const found: { repo: RepoSlug; turbo: boolean }[] = []
  for (const project of projects) {
    if (typeof project?.repo !== 'string' || !isRepoSlug(project.repo)) return undefined
    found.push({ repo: project.repo, turbo: project.turbo === true })
  }
  return found
}

async function gh(run: Run, args: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await run(['gh', ...args])
  if (exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr.trim()}`)
  return stdout.trim()
}

function ciOf(runs: string): CiState {
  const latest = (JSON.parse(runs) as { status: string; conclusion: string }[])[0]
  if (latest === undefined) return 'none'
  if (latest.status !== 'completed') return 'running'
  return latest.conclusion === 'success' ? 'passing' : 'failing'
}

/** One row per registered project; a project the tracker cannot be read for is a row marked unreachable, never dropped. */
export function projectRows(run: Run, projects: { repo: RepoSlug; turbo: boolean }[]): Promise<ProjectRow[]> {
  return Promise.all(
    projects.map(async ({ repo, turbo }): Promise<ProjectRow> => {
      try {
        const branch = await gh(run, ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
        const [ready, pulls, runs] = await Promise.all([
          gh(run, ['issue', 'list', '--repo', repo, '--label', 'ready-for-agent', '--state', 'open', '--limit', '1000', '--json', 'number', '--jq', 'length']),
          gh(run, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number', '--jq', 'length']),
          gh(run, ['run', 'list', '--repo', repo, '--branch', branch, '--limit', '1', '--json', 'status,conclusion']),
        ])
        return { reachable: true, repo, turbo, ready: Number(ready), openPullRequests: Number(pulls), ci: ciOf(runs) }
      } catch (error) {
        return { reachable: false, repo, turbo, reason: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
}

/** Where a project's clone lives: under the managed location, by its slug. */
export function clonePath(managedLocation: string, repo: RepoSlug): string {
  return `${managedLocation.replace(/\/+$/, '')}/${repo}`
}
