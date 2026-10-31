import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { locations, type Locations } from './locations'
import { clonePath, joinPath, projectRows, repoSlug, type RepoSlug, registeredProjects, type Run } from './switcher'

const PANE = 'project-switcher'
const rows = atom({ plugin: 'project-switcher', key: 'rows' } as const, null)
const selected = atom({ plugin: 'project-switcher', key: 'selected' } as const, null)
const selectedClonePath = atom({ plugin: 'project-switcher', key: 'clonePath' } as const, null)
const refreshing = atom({ plugin: 'project-switcher', key: 'refreshing' } as const, false)
const problem = atom({ plugin: 'project-switcher', key: 'problem' } as const, null)

/** The three variables `locations` resolves from, one per line, empty when unset: the hooks run without `process`. */
const ENVIRONMENT = 'printf "%s\\n%s\\n%s" "$SIDE_PROJECTS_MANAGER_HOME" "$SIDE_PROJECTS_MANAGED_LOCATION" "$HOME"'

/** This checkout's root: the mod sits at `mods/project-switcher/hooks`. */
const CHECKOUT_ROOT = import.meta.dir.split('/').slice(0, -3).join('/')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'projects', description: 'Open the project switcher pane over the registry' })
    return next(e)
  })

  on('command.run', { command: 'projects' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Projects' })
    await refresh($)
    return { text: 'Project switcher opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, rows)
    const chosen = await read($, selected)
    const path = await read($, selectedClonePath)
    const busy = await read($, refreshing)
    const trouble = await read($, problem)
    const chosenRow = list?.find(row => row.repo === chosen)

    return (
      <Box flexDirection="column">
        <Button onPress={() => refresh($)}>{busy ? 'Refreshing…' : 'Refresh'}</Button>
        {trouble !== null && <Text color="red">{trouble}</Text>}
        {list === null && trouble === null && <Text dimColor>Reading the tracker…</Text>}
        {list?.map(row => (
          <Button onPress={() => choose($, repoSlug(row.repo))}>
            {row.reachable
              ? `${row.repo}  ready ${row.ready}  PRs ${row.openPullRequests}  CI ${row.ci}${row.turbo ? '  turbo' : ''}`
              : `${row.repo}  unreachable${row.turbo ? '  turbo' : ''}`}
          </Button>
        ))}
        {chosen !== null && <Text>{`${chosen}: ${path}`}</Text>}
        {chosenRow !== undefined && !chosenRow.reachable && <Text color="red">{chosenRow.reason}</Text>}
      </Box>
    )
  })
}

/** The manager home and managed location, from the session's environment. */
async function whereThings($: EngineInterface): Promise<Locations> {
  const { stdout } = await $.process.run(['sh', '-c', ENVIRONMENT])
  const [SIDE_PROJECTS_MANAGER_HOME, SIDE_PROJECTS_MANAGED_LOCATION, HOME] = stdout.split('\n')
  return locations({ SIDE_PROJECTS_MANAGER_HOME, SIDE_PROJECTS_MANAGED_LOCATION, HOME }, CHECKOUT_ROOT)
}

/** Re-reads the registry and the tracker, and redraws; the rows already shown stay until the new ones arrive. */
async function refresh($: EngineInterface): Promise<void> {
  const run: Run = command => $.process.run(command)
  await update($, refreshing, () => true)
  try {
    const { home } = await whereThings($)
    const projects = registeredProjects(await $.fs.read(joinPath(home, 'registry.json')))
    const fresh = await projectRows(run, projects)
    await update($, rows, () => fresh)
    await update($, problem, () => null)
  } catch (error) {
    await update($, problem, () => error instanceof Error ? error.message : String(error))
  } finally {
    await update($, refreshing, () => false)
  }
}

async function choose($: EngineInterface, repo: RepoSlug): Promise<void> {
  const { managed } = await whereThings($)
  await update($, selected, () => repo)
  await update($, selectedClonePath, () => clonePath(managed, repo))
}
