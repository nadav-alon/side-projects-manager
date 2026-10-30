import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { clonePath, projectRows, registeredProjects, type Run } from './switcher'

const PANE = 'project-switcher'
const rows = atom({ plugin: 'project-switcher', key: 'rows' } as const, null)
const selected = atom({ plugin: 'project-switcher', key: 'selected' } as const, null)
const selectedClonePath = atom({ plugin: 'project-switcher', key: 'clonePath' } as const, null)

/** The manager home and the managed location, resolved by the shell as the manager resolves them. */
const WHERE = 'printf "%s\\n%s" "${SIDE_PROJECTS_MANAGER_HOME:-.}" "${SIDE_PROJECTS_MANAGED_LOCATION:-$HOME/side-projects}"'

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

    return (
      <Box flexDirection="column">
        <Button onPress={() => refresh($)}>Refresh</Button>
        {list === null && <Text dimColor>Reading the tracker…</Text>}
        {list?.map(row => (
          <Button onPress={() => choose($, row.repo)}>
            {row.reachable
              ? `${row.repo}  ready ${row.ready}  PRs ${row.openPullRequests}  CI ${row.ci}${row.turbo ? '  turbo' : ''}`
              : `${row.repo}  unreachable${row.turbo ? '  turbo' : ''}`}
          </Button>
        ))}
        {chosen !== null && <Text>{`${chosen}: ${path}`}</Text>}
      </Box>
    )
  })
}

type Engine = EngineInterface

async function locations($: Engine): Promise<{ home: string; managed: string }> {
  const { stdout } = await $.process.run(['sh', '-c', WHERE])
  const [home = '.', managed = ''] = stdout.split('\n')
  return { home, managed }
}

/** Re-reads the registry and the tracker, and redraws. */
async function refresh($: Engine): Promise<void> {
  const { home } = await locations($)
  const run: Run = command => $.process.run(command)
  const projects = registeredProjects(await $.fs.read(`${home.replace(/\/+$/, '')}/registry.json`))
  await update($, rows, () => projects === undefined ? [] : null)
  if (projects !== undefined) {
    const fresh = await projectRows(run, projects)
    await update($, rows, () => fresh)
  }
}

async function choose($: Engine, repo: string): Promise<void> {
  const { managed } = await locations($)
  await update($, selected, () => repo)
  await update($, selectedClonePath, () => clonePath(managed, repo as never))
}
