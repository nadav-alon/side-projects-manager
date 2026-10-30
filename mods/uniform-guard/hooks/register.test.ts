import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const HOME = '/work/manager'
const HARNESS = `export const UNIFORM_FILES = [
  "docs/agents/domain.md",
  ".github/workflows/rebase.yml",
] as const;`

/** Stands for the engine beneath the mod: a session at HOME whose harness source is `harness` (null: none) and whose other files read as `files`, and a call that reaches it runs. */
function engine(on: On, harness: string | null = HARNESS, files: Record<string, string> = {}): void {
  on('session.root', () => ({ value: HOME }) as never)
  on('fs.read', ($, { path }) => {
    const file = Object.entries(files).find(([name]) => path.endsWith(name))
    if (file) return { value: file[1] } as never
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
  const ran = await $.tool.call({ tool: 'Write', file_path: `${HOME}/docs/agents/domain.md`, content: `# Domain\n${NAMING}\n` })
  expect(ran.deny).toContain(JSON.stringify(NAMING))
})

test('denies an edit to a uniform file that names the repo, quoting the text', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: `${HOME}/.github/workflows/rebase.yml`,
    old_string: 'a',
    new_string: `# ${NAMING}`,
  })
  expect(ran.deny).toContain(JSON.stringify(`# ${NAMING}`))
})

test('denies a name spelled with underscores, no separator or split across lines, quoting the line it starts on', async ($, on) => {
  engine(on)
  for (const text of ['side_projects_manager', 'SideProjectsManager', 'side  projects  manager']) {
    const ran = await $.tool.call({ tool: 'Write', file_path: `${HOME}/docs/agents/domain.md`, content: `# Domain\n${text}\n` })
    expect(ran.deny).toContain(JSON.stringify(text))
  }
  const split = await $.tool.call({ tool: 'Write', file_path: `${HOME}/docs/agents/domain.md`, content: 'See Side Projects\nManager.' })
  expect(split.deny).toContain(JSON.stringify('See Side Projects'))
})

test('runs untouched a write to a uniform file that does not name the repo', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Write', file_path: `${HOME}/docs/agents/domain.md`, content: '# Domain\n' })
  expect(ran.deny).toBeUndefined()
})

test('runs untouched a write to a non-uniform file that names the repo', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Write', file_path: `${HOME}/README.md`, content: NAMING })
  expect(ran.deny).toBeUndefined()
})

test('runs untouched a session outside the manager', async ($, on) => {
  engine(on, null)
  const ran = await $.tool.call({ tool: 'Write', file_path: `${HOME}/docs/agents/domain.md`, content: NAMING })
  expect(ran.deny).toBeUndefined()
})

test('denies a write when the harness source declares no readable uniform list', async ($, on) => {
  engine(on, "export const UNIFORM_FILES = ['docs/agents/domain.md'] as const;")
  const ran = await $.tool.call({ tool: 'Write', file_path: `${HOME}/docs/agents/domain.md`, content: '# Domain\n' })
  expect(ran.deny).toContain('UNIFORM_FILES')
})

test('denies an edit whose fragment completes the name with the text around it', async ($, on) => {
  engine(on, HARNESS, { 'docs/agents/domain.md': 'projects-manager here' })
  const ran = await $.tool.call({ tool: 'Edit', file_path: `${HOME}/docs/agents/domain.md`, old_string: 'projects', new_string: 'side-projects' })
  expect(ran.deny).toContain(JSON.stringify('side-projects-manager here'))
})

test('denies a write to a uniform file reached by a non-normalized path', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Write', file_path: `${HOME}/./docs/../docs/agents/domain.md`, content: NAMING })
  expect(ran.deny).toContain('docs/agents/domain.md')
})

test('runs untouched a write to a uniform-looking path under another root', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Write', file_path: '/work/other/docs/agents/domain.md', content: NAMING })
  expect(ran.deny).toBeUndefined()
})

test('runs untouched an edit to a uniform file that does not name the repo', async ($, on) => {
  engine(on, HARNESS, { 'docs/agents/domain.md': '# Domain\n' })
  const ran = await $.tool.call({ tool: 'Edit', file_path: `${HOME}/docs/agents/domain.md`, old_string: 'Domain', new_string: 'Terms' })
  expect(ran.deny).toBeUndefined()
})

test('runs untouched an edit to a non-uniform file that names the repo', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Edit', file_path: `${HOME}/README.md`, old_string: 'a', new_string: NAMING })
  expect(ran.deny).toBeUndefined()
})
