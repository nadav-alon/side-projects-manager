import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const REGISTRY = JSON.stringify({ projects: [{ repo: 'o/a', turbo: true }, { repo: 'o/gone' }] })

/** Stands for the engine beneath the mod: the pane opened, the registry read, and `gh` answered. */
function engine(on: On, registry: string | Error, ran: string[][]): { opened: string[] } {
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: {} } as never
  })
  on('fs.read', () => {
    if (registry instanceof Error) return { deny: registry.message } as never
    return { value: registry } as never
  })
  on('process.run', (_$, { argv }) => {
    ran.push([...argv])
    if (argv[0] === 'sh') return { value: { exitCode: 0, stdout: '/m\n/p\n/home/me', stderr: '' } } as never
    const repo = argv.includes('o/gone')
    const answer = repo
      ? { exitCode: 1, stdout: '', stderr: 'Could not resolve to a Repository' }
      : { exitCode: 0, stdout: argv[1] === 'repo' ? 'main\n' : argv[1] === 'run' ? '[{"status":"completed","conclusion":"success"}]' : '2\n', stderr: '' }
    return { value: answer } as never
  })
  return { opened }
}

const PANE = { plugin: 'project-switcher', surface: 'terminal', component: 'Pane', requestId: 'project-switcher', props: {}, viewport: { columns: 100, rows: 30 } } as const

test('/projects opens the pane and lists every registered project', async ($, on) => {
  const { opened } = engine(on, REGISTRY, [])
  await $.command.run({ command: 'projects' })
  expect(opened).toEqual(['project-switcher'])

  const ui = await $.ui.mount(PANE as never)
  expect(await ui.find({ text: /o\/a  ready 2  PRs 2  CI passing  turbo/ })).toBeDefined()
  expect(await ui.find({ text: /o\/gone  unreachable/ })).toBeDefined()
})

test('the refresh button re-reads the tracker', async ($, on) => {
  const ran: string[][] = []
  engine(on, REGISTRY, ran)
  await $.command.run({ command: 'projects' })
  const before = ran.length

  const ui = await $.ui.mount(PANE as never)
  await ui.press((await ui.find({ type: 'Button', text: 'Refresh' }))!)
  expect(ran.length).toBeGreaterThan(before)
})

test('selecting a project shows its clone path under the managed location', async ($, on) => {
  engine(on, REGISTRY, [])
  await $.command.run({ command: 'projects' })

  const ui = await $.ui.mount(PANE as never)
  await ui.press((await ui.find({ type: 'Button', text: /o\/a  ready/ }))!)
  expect(await ui.find({ text: "o/a: /p/o/a" })).toBeDefined()
})

test('a registry that cannot be read is shown, not an endless wait', async ($, on) => {
  engine(on, new Error('ENOENT: registry.json'), [])
  await $.command.run({ command: 'projects' })

  const ui = await $.ui.mount(PANE as never)
  expect(await ui.find({ text: /ENOENT/ })).toBeDefined()
  expect(await ui.find({ text: /Reading the tracker/ })).toBeUndefined()
})

test('selecting an unreachable project shows why it could not be read', async ($, on) => {
  engine(on, REGISTRY, [])
  await $.command.run({ command: 'projects' })

  const ui = await $.ui.mount(PANE as never)
  await ui.press((await ui.find({ type: 'Button', text: /o\/gone  unreachable/ }))!)
  expect(await ui.find({ text: /Could not resolve to a Repository/ })).toBeDefined()
})

test('one malformed registry entry is named, not read as no projects', async ($, on) => {
  engine(on, JSON.stringify({ projects: [{ repo: 'o/a' }, { repo: 'nope' }] }), [])
  await $.command.run({ command: 'projects' })

  const ui = await $.ui.mount(PANE as never)
  expect(await ui.find({ text: /entry 2 .*"nope"/ })).toBeDefined()
})
