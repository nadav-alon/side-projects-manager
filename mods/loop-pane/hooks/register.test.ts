import { expect, mock, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

/** A process the pane ran: what it was asked to run, and where. */
type Ran = { argv: readonly string[]; cwd?: string }

const HOME = import.meta.dir.split('/').slice(0, -3).join('/')
const now = Date.now()
const iso = (ago: number) => new Date(now - ago).toISOString()

/** Stands for the engine beneath the mod: the manager home's files are `files`, and the pane's process runs are recorded. */
function engine(on: On, files: Record<string, string>, ran: Ran[] = [], reads: string[] = []) {
  const clock = mock.clock(on, { now })
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text } as never
  })
  on('process.run', (_$, { argv, init }) => {
    ran.push({ argv, cwd: init?.cwd })
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('ui.open', () => ({ value: {} }) as never)
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
  const lines = await texts(await mount($))
  expect(lines).toContain('o/a#7 implementation')
  expect(lines).toContain('o/d#9')
  expect(lines).toContain('5-hour spend: 1200 of 5000 tokens')
})

test('the pane says none is running when the journal has no open invocation', async ($, on) => {
  engine(on, { [`${HOME}/journal.json`]: JSON.stringify({ records: [] }) })
  await $.command.run({ command: 'loop-pane', args: '' })
  expect(await texts(await mount($))).toEqual(['No invocation is running.'])
})

test('a missing manager home draws an empty pane, not an error', async ($, on) => {
  engine(on, {})
  const out = await $.command.run({ command: 'loop-pane', args: '' })
  expect(out.text).toBe('Loop pane opened.')
  expect(await texts(await mount($))).toEqual(['No invocation is running.'])
})

test('the pane redraws when the journal changes', async ($, on) => {
  const files = { ...home }
  const clock = engine(on, files)
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  expect(await texts(ui)).toContain('o/a#7 implementation')
  files[`${HOME}/journal.json`] = JSON.stringify({ records: [] })
  await clock.advance(2500)
  expect(await texts(ui)).toContain('No invocation is running.')
})

test('the pane stops polling the manager home once it is closed', async ($, on) => {
  const reads: string[] = []
  const clock = engine(on, home, [], reads)
  await $.command.run({ command: 'loop-pane', args: '' })
  await clock.advance(2500)
  const whileOpen = reads.length
  expect(whileOpen).toBeGreaterThan(0)
  await $.ui.close({ id: 'loop-pane' })
  const atClose = reads.length
  await clock.advance(10_000)
  expect(reads.length).toBe(atClose)
})

test('halt and resume run the manager command from the manager home', async ($, on) => {
  const ran: Ran[] = []
  engine(on, home, ran)
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'halt' })
  await ui.press({ key: 'resume' })
  expect(ran).toEqual([
    { argv: ['npm', 'run', '--silent', 'halt'], cwd: HOME },
    { argv: ['npm', 'run', '--silent', 'resume'], cwd: HOME },
  ])
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
  engine(on, home, ran)
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'stop' })
  expect(asked).toEqual(['Stop the morning loop?'])
  expect(ran).toEqual([])
})

test('stop runs the stop command once the person agrees', async ($, on) => {
  const ran: Ran[] = []
  person(on, [], 'Yes')
  engine(on, home, ran)
  await $.command.run({ command: 'loop-pane', args: '' })
  const ui = await mount($)
  await ui.press({ key: 'stop' })
  expect(ran).toEqual([{ argv: ['npm', 'run', '--silent', 'stop'], cwd: HOME }])
})
