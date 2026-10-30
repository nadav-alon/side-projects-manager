import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const ROOT = '/work/manager'
const HARNESS = `export const UNIFORM_FILES = [
  "docs/agents/domain.md",
  ".github/workflows/rebase.yml",
] as const;`

/** Stands for the engine beneath the mod: a session rooted at ROOT whose harness source is `harness` (null: none), and a call that reaches it runs. */
function engine(on: On, harness: string | null = HARNESS): void {
  on('session.root', () => ({ value: ROOT }) as never)
  on('fs.read', ($, { path }) => {
    if (harness === null || !path.endsWith('src/ports/harness.ts')) return { deny: 'ENOENT' } as never
    return { value: harness } as never
  })
  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, () => ({ result: {} }) as never)
  }
}

const NAMING = 'Copied from the Side Projects Manager repo.'

test('denies a write to a uniform file that names the repo, quoting the text', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/agents/domain.md`, content: `# Domain\n${NAMING}\n` })
  expect(ran.deny).toContain(JSON.stringify(NAMING))
})

test('denies an edit to a uniform file that names the repo, quoting the text', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: `${ROOT}/.github/workflows/rebase.yml`,
    old_string: 'a',
    new_string: `# ${NAMING}`,
  })
  expect(ran.deny).toContain(NAMING)
})

test('denies a name spelled with underscores, no separator or split across lines, quoting the line it starts on', async ($, on) => {
  engine(on)
  for (const text of ['side_projects_manager', 'SideProjectsManager', 'side  projects  manager']) {
    const ran = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/agents/domain.md`, content: `# Domain\n${text}\n` })
    expect(ran.deny).toContain(JSON.stringify(text))
  }
  const split = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/agents/domain.md`, content: 'See Side Projects\nManager.' })
  expect(split.deny).toContain(JSON.stringify('See Side Projects'))
})

test('runs untouched an edit to a uniform file that does not name the repo', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/agents/domain.md`, content: '# Domain\n' })
  expect(ran.deny).toBeUndefined()
})

test('runs untouched an edit to a non-uniform file that names the repo', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/README.md`, content: NAMING })
  expect(ran.deny).toBeUndefined()
})

test('runs untouched a session outside the manager', async ($, on) => {
  engine(on, null)
  const ran = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/agents/domain.md`, content: NAMING })
  expect(ran.deny).toBeUndefined()
})
