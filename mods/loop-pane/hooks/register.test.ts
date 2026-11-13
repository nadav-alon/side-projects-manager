import { expect, mock, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

/** A process the pane ran: what it was asked to run, and where. */
type Ran = { argv: readonly string[]; cwd?: string }

const HOME = import.meta.dir.split('/').slice(0, -3).join('/')
const now = Date.parse('2026-06-15T17:30:00Z')
const iso = (ago: number) => new Date(now - ago).toISOString()

/** Stands for the engine beneath the mod: the manager home's files are `files`, and the pane's process runs are recorded; `configDir` is the Claude config directory the shell reports and `managerHome` the `SIDE_PROJECTS_MANAGER_HOME` it reports, empty when unset. */
function engine(
  on: On,
  files: Record<string, string>,
  { ran = [], reads = [], outcome = { exitCode: 0, stderr: '' }, alive = true, killStderr = '', configDir = '', managerHome = '' }: { ran?: Ran[]; reads?: string[]; outcome?: { exitCode: number; stderr: string }; alive?: boolean; killStderr?: string; configDir?: string; managerHome?: string } = {},
) {
  const clock = mock.clock(on, { now })
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text } as never
  })
  on('process.run', (_$, { argv, init }) => {
    if (argv[0] === 'kill') return { value: { exitCode: alive ? 0 : 1, stdout: '', stderr: alive ? '' : killStderr } } as never
    if (argv[0] === 'sh' && argv[2]?.includes('SIDE_PROJECTS_MANAGER_HOME')) return { value: { exitCode: 0, stdout: managerHome, stderr: '' } } as never
    if (argv[0] === 'sh') return { value: { exitCode: 0, stdout: configDir, stderr: '' } } as never
    ran.push({ argv, cwd: init?.cwd })
    return { value: { exitCode: outcome.exitCode, stdout: '', stderr: outcome.stderr } } as never
  })
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.close', () => ({ value: {} }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  return clock
}

const running = {
  records: [
    {
      openedAt: iso(60_000),
      process: 4242,
      runs: [{ kind: 'implementation', repo: 'o/a', number: 7, startedAt: iso(1000), transcriptDirectory: '/t' }],
      freed: [{ repo: 'o/d', number: 9 }],
    },
  ],
}
const state = { projects: { 'o/a': { runs: [{ at: iso(1000), tokensUsed: 1200 }] } } }
const home = {
  [`${HOME}/journal.json`]: JSON.stringify(running),
  [`${HOME}/state.json`]: JSON.stringify(state),
  [`${HOME}/budget.json`]: JSON.stringify({ fiveHourAllowance: 5000 }),
}

const mount = ($: Parameters<TestBody>[0]) => $.ui.mount({ plugin: 'loop-pane', surface: 'terminal', component: 'Pane', requestId: 'loop-pane', props: {} } as never)
const texts = async (ui: Awaited<ReturnType<typeof mount>>) => (await ui.findAll({ type: 'Text' })).map(t => t.text.trim())

test('the pane shows the in-flight invocation, its iterations, its spend and its freed entries', async ($, on) => {
  engine(on, home)
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  const lines = await texts(ui)
  const row = (await ui.findAll({ type: 'Box' })).find(box => (box.props as { gap?: number }).gap === 1 && box.text.includes('o/a#7'))
  expect(row?.text.trim()).toBe('Run:o/a#7[implementation]')
  expect(lines).toContain('o/d#9')
  expect(lines).toContain("5h window: 1.2K / 5.0K spendable tokens (24%)")
})

test('the pane lists the recorded discoveries, newest first', async ($, on) => {
  const files = {
    ...home,
    [`${HOME}/recorded-discoveries.json`]: JSON.stringify({
      discoveries: [
        { repo: 'o/a', number: 3, kind: 'suggestion', title: 'Run: older', filedAt: iso(9000) },
        { repo: 'o/b', number: 5, kind: 'correction', title: 'Newer', filedAt: iso(1000) },
      ],
    }),
  }
  engine(on, files)
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  const expected = ['o/b#5[correction]Newer', 'o/a#3[suggestion]Run: older']
  const rows = (await ui.findAll({ type: 'Box' })).map(box => box.text.trim()).filter(text => expected.includes(text))
  expect(rows).toEqual(expected)
  expect(await texts(ui)).not.toContain('No discovery is waiting on you.')
})

test('the pane says none is waiting when the recorded discoveries are an empty list', async ($, on) => {
  engine(on, { ...home, [`${HOME}/recorded-discoveries.json`]: JSON.stringify({ discoveries: [] }) })
  await $.command.run({ command: 'loop-pane', args: '' })
  expect(await texts(await mount($))).toContain('No discovery is waiting on you.')
})

test('the pane says the recorded discoveries cannot be read, not that none is waiting, when the document is unreadable', async ($, on) => {
  engine(on, { ...home, [`${HOME}/recorded-discoveries.json`]: JSON.stringify({ discoveries: [{ repo: 'o/a', number: 3, kind: 'idea', title: 'T', filedAt: iso(1000) }] }) })
  await $.command.run({ command: 'loop-pane', args: '' })
  const lines = await texts(await mount($))
  expect(lines).toContain('Recorded discoveries cannot be read.')
  expect(lines).not.toContain('No discovery is waiting on you.')
})

test('the spend line uses compact units and a share, small shares included', async ($, on) => {
  const files = {
    ...home,
    [`${HOME}/state.json`]: JSON.stringify({ projects: { 'o/a': { runs: [{ at: iso(1000), tokensUsed: 2_100_323 }] } } }),
    [`${HOME}/budget.json`]: JSON.stringify({ fiveHourAllowance: 7_000_000_000 }),
  }
  engine(on, files)
  await $.command.run({ command: 'loop-pane', args: '' })
  expect(await texts(await mount($))).toContain("5h window: 2.1M / 7.0B spendable tokens (0.03%)")
})

test('the spend line counts against the allowance less the reserve', async ($, on) => {
  const files = { ...home, [`${HOME}/budget.json`]: JSON.stringify({ fiveHourAllowance: 5000, fiveHourReserveFraction: 0.2 }) }
  engine(on, files)
  await $.command.run({ command: 'loop-pane', args: '' })
  expect(await texts(await mount($))).toContain("5h window: 1.2K / 4.0K spendable tokens (30%)")
})

test('the pane says an invocation whose process is gone has died, and lists none of its runs', async ($, on) => {
  engine(on, home, { alive: false })
  await $.command.run({ command: 'loop-pane', args: '' })
  const lines = await texts(await mount($))
  expect(lines).toContain('Process 4242 has died without closing its record; nothing below is running.')
  expect(lines).not.toContain('o/a#7')
})

test('the pane says none is running when the journal has no open invocation', async ($, on) => {
  engine(on, { [`${HOME}/journal.json`]: JSON.stringify({ records: [] }) })
  await $.command.run({ command: 'loop-pane', args: '' })
  expect(await texts(await mount($))).toEqual(['Status', 'No invocation is running.', 'Discoveries waiting on you', 'No discovery is waiting on you.', 'Controls'])
})

test('a missing manager home draws an empty pane, not an error', async ($, on) => {
  engine(on, {})
  const out = await $.command.run({ command: 'loop-pane', args: '' })
  expect(out.text).toBe('Loop pane opened.')
  expect(await texts(await mount($))).toEqual(['Status', 'No invocation is running.', 'Discoveries waiting on you', 'No discovery is waiting on you.', 'Controls'])
})

test('the pane redraws when the journal changes', async ($, on) => {
  const files = { ...home }
  const clock = engine(on, files)
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  expect(await texts(ui)).toContain('o/a#7')
  files[`${HOME}/journal.json`] = JSON.stringify({ records: [] })
  await clock.advance(2500)
  expect(await texts(ui)).toContain('No invocation is running.')
})

test('the pane stops polling the manager home once it is closed', async ($, on) => {
  const reads: string[] = []
  const clock = engine(on, home, { reads })
  await $.command.run({ command: 'loop-pane', args: '' })
  await clock.advance(2500)
  const whileOpen = reads.length
  expect(whileOpen).toBeGreaterThan(0)
  await (await mount($)).press({ key: 'close' })
  const atClose = reads.length
  await clock.advance(10_000)
  expect(reads.length).toBe(atClose)
})

test('halt and resume run the manager command from the manager home', async ($, on) => {
  const ran: Ran[] = []
  engine(on, home, { ran })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'halt' })
  await ui.press({ key: 'resume' })
  expect(ran).toEqual([
    { argv: ['npm', 'run', '--silent', 'halt'], cwd: HOME },
    { argv: ['npm', 'run', '--silent', 'resume'], cwd: HOME },
  ])
})

test('a button whose command fails says so in the pane', async ($, on) => {
  engine(on, home, { outcome: { exitCode: 1, stderr: 'npm: not found' } })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'halt' })
  expect(await texts(ui)).toContain('Halt failed (exit 1): npm: not found')
})

/** Stands for the person at the confirmation dialog: every question asked is answered `choice`, and recorded. */
function person(on: On, asked: string[], choice: string): void {
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    for (const { question } of e.questions) asked.push(question)
    return { result: { questions: e.questions, answers: Object.fromEntries(e.questions.map(q => [q.question, choice])) } } as never
  })
}

test('stop asks first and runs only when the person agrees', async ($, on) => {
  const ran: Ran[] = [], asked: string[] = []
  person(on, asked, 'No')
  engine(on, home, { ran })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'stop' })
  expect(asked).toEqual(['Stop the morning loop?'])
  expect(ran).toEqual([])
})

test('stop runs the stop command once the person agrees', async ($, on) => {
  const ran: Ran[] = []
  person(on, [], 'Yes')
  engine(on, home, { ran })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'stop' })
  expect(ran).toEqual([{ argv: ['npm', 'run', '--silent', 'stop'], cwd: HOME }])
})

test('start now runs the start script from the manager home, passing the home to it', async ($, on) => {
  const ran: Ran[] = []
  engine(on, {}, { ran })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'start' })
  expect(ran.length).toBe(1)
  const [shell, flag, script, name, home] = ran[0].argv
  expect([shell, flag, name, home, ran[0].cwd]).toEqual(['bash', '-c', 'start', HOME, HOME])
  expect(script).toContain('git pull --ff-only')
  expect(script).toContain('morning-run.ts')
})

test('start now runs the start script from the checkout when the manager home lies elsewhere', async ($, on) => {
  const ran: Ran[] = []
  engine(on, {}, { ran, managerHome: '/elsewhere/home' })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'start' })
  expect(ran.length).toBe(1)
  expect([ran[0].argv[4], ran[0].cwd]).toEqual([HOME, '/elsewhere/home'])
})

test('start now says why when the start script exits non-zero', async ($, on) => {
  engine(on, {}, { outcome: { exitCode: 1, stderr: 'node is not on PATH' } })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'start' })
  expect(await texts(ui)).toContain('Start now failed (exit 1): node is not on PATH')
})

test('start now starts nothing and says so while an invocation holds the lease', async ($, on) => {
  const ran: Ran[] = []
  engine(on, { [`${HOME}/invocation.lease`]: '4242' }, { ran })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'start' })
  expect(ran).toEqual([])
  expect(await texts(ui)).toContain('An invocation is already running.')
})

test('start now starts an invocation when the lease holder is dead', async ($, on) => {
  const ran: Ran[] = []
  engine(on, { [`${HOME}/invocation.lease`]: '4242' }, { ran, alive: false })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'start' })
  expect(ran.length).toBe(1)
})

test('start now says it started, so the press shows it did something', async ($, on) => {
  engine(on, {})
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'start' })
  expect(await texts(ui)).toContain('Started an invocation.')
})

test('start now starts an invocation when the lease holds junk', async ($, on) => {
  const ran: Ran[] = []
  engine(on, { [`${HOME}/invocation.lease`]: 'not a pid' }, { ran })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'start' })
  expect(ran.length).toBe(1)
})

test('start now counts a holder it lacks the right to signal as alive', async ($, on) => {
  const ran: Ran[] = []
  engine(on, { [`${HOME}/invocation.lease`]: '4242' }, { ran, alive: false, killStderr: 'kill: (4242): Operation not permitted' })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'start' })
  expect(ran).toEqual([])
  expect(await texts(ui)).toContain('An invocation is already running.')
})

test('start now starts nothing while a lease takeover is in progress', async ($, on) => {
  const ran: Ran[] = []
  engine(on, { [`${HOME}/invocation.lease.takeover`]: '4242' }, { ran })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'start' })
  expect(ran).toEqual([])
  expect(await texts(ui)).toContain('An invocation is already running.')
})

test('the pane shows when the invocation opened in local time, and for how long', async ($, on) => {
  engine(on, home)
  await $.command.run({ command: 'loop-pane', args: '' })
  expect(await texts(await mount($))).toContainEqual(expect.stringMatching(/^Running since \d\d:\d\d \(1m\)$/))
})

test('a record left open by a dead process is not called running', async ($, on) => {
  engine(on, home, { alive: false })
  await $.command.run({ command: 'loop-pane', args: '' })
  const lines = await texts(await mount($))
  expect(lines).toContainEqual(expect.stringMatching(/^Opened at \d\d:\d\d \(1m ago\), process died$/))
  expect(lines.some(line => line.startsWith('Running since'))).toBe(false)
})

test('the pane has labelled sections for status, current runs, spend and controls', async ($, on) => {
  engine(on, home)
  await $.command.run({ command: 'loop-pane', args: '' })
  const lines = await texts(await mount($))
  const headings = ['Status', 'Current runs', '5-hour spend', 'Controls']
  expect(lines.filter(line => headings.includes(line))).toEqual(headings)
})

test('the buttons have space between them', async ($, on) => {
  engine(on, home)
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  const row = (await ui.findAll({ type: 'Box' })).find(box => (box.props as { gap?: number }).gap === 1 && box.text.includes('Halt'))
  expect(row).toBeDefined()
})

test("the spend line counts the developer's own use from the session logs under the Claude config directory", async ($, on) => {
  const logs = '/config/projects'
  const line = JSON.stringify({ type: 'assistant', timestamp: iso(2000), message: { usage: { input_tokens: 3000, output_tokens: 0 } } })
  engine(on, { ...home, '/config/projects/proj/s.jsonl': line }, { configDir: '/config/' })
  on('fs.list', (_$, e) => {
    const names = e.path === logs ? ['proj'] : e.path === `${logs}/proj` ? ['s.jsonl'] : undefined
    if (names === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: names.map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  await $.command.run({ command: 'loop-pane', args: '' })
  expect(await texts(await mount($))).toContain("5h window: 4.2K / 5.0K spendable tokens (84%)")
})

test('the pane reads the manager home from SIDE_PROJECTS_MANAGER_HOME when it is set', async ($, on) => {
  const elsewhere = '/elsewhere/home'
  engine(on, { [`${elsewhere}/journal.json`]: JSON.stringify(running), [`${elsewhere}/state.json`]: JSON.stringify(state), [`${elsewhere}/budget.json`]: JSON.stringify({ fiveHourAllowance: 5000 }) }, { managerHome: elsewhere })
  await $.command.run({ command: 'loop-pane', args: '' })
  expect(await texts(await mount($))).toContain('o/d#9')
})

test('halt and resume run the manager command from SIDE_PROJECTS_MANAGER_HOME when it is set', async ($, on) => {
  const ran: Ran[] = []
  const elsewhere = '/elsewhere/home'
  engine(on, { [`${elsewhere}/journal.json`]: JSON.stringify(running) }, { ran, managerHome: elsewhere })
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'halt' })
  await ui.press({ key: 'resume' })
  expect(ran).toEqual([
    { argv: ['npm', 'run', '--silent', 'halt'], cwd: elsewhere },
    { argv: ['npm', 'run', '--silent', 'resume'], cwd: elsewhere },
  ])
})
