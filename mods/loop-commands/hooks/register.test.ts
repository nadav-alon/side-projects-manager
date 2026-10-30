import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Ran = { argv: readonly string[]; cwd?: string }

/** Stands for the engine beneath the mod: a shell-less process run that records its call and answers `answer`. */
function engine(on: On, ran: Ran[], answer: { exitCode: number; stdout: string; stderr: string }): void {
  on('process.run', (_$, { argv, init }) => {
    ran.push({ argv, cwd: init?.cwd })
    return { value: answer } as never
  })
}

test('/loop-status runs the status command from the manager clone and shows its output', async ($, on) => {
  const ran: Ran[] = []
  engine(on, ran, { exitCode: 0, stdout: 'loop: running\n', stderr: '' })
  const out = await $.command.run({ command: 'loop-status' })
  expect(out.text).toBe('loop: running')
  expect(ran[0]?.argv).toEqual(['npm', 'run', '--silent', 'status'])
  expect(ran[0]?.cwd).toBeTruthy()
  expect(ran[0]?.cwd).not.toContain('/mods/')
})

test('/loop-status shows the failure when the command fails', async ($, on) => {
  engine(on, [], { exitCode: 1, stdout: '', stderr: 'status failed: no state\n' })
  const out = await $.command.run({ command: 'loop-status' })
  expect(out.text).toBe('/loop-status failed (exit 1): status failed: no state')
})

/** Stands for the person at the confirmation dialog: every question asked is answered `choice`, and recorded. */
function person(on: On, asked: string[], choice: string): void {
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    for (const { question } of e.questions) asked.push(question)
    return { result: { questions: e.questions, answers: Object.fromEntries(e.questions.map(q => [q.question, choice])) } } as never
  })
}

test('/halt asks first, then runs the halt command and shows its output', async ($, on) => {
  const ran: Ran[] = [], asked: string[] = []
  person(on, asked, 'Yes')
  engine(on, ran, { exitCode: 0, stdout: 'halted\n', stderr: '' })
  const out = await $.command.run({ command: 'halt' })
  expect(asked).toEqual(['Halt the manager loop?'])
  expect(ran[0]?.argv).toEqual(['npm', 'run', '--silent', 'halt'])
  expect(out.text).toBe('halted')
})

test('/halt runs nothing when the person declines', async ($, on) => {
  const ran: Ran[] = []
  person(on, [], 'No')
  engine(on, ran, { exitCode: 0, stdout: 'halted\n', stderr: '' })
  const out = await $.command.run({ command: 'halt' })
  expect(ran).toEqual([])
  expect(out.text).toBe('/halt cancelled.')
})

test('/halt shows the failure when the command fails', async ($, on) => {
  person(on, [], 'Yes')
  engine(on, [], { exitCode: 1, stdout: '', stderr: 'halt failed: read-only\n' })
  const out = await $.command.run({ command: 'halt' })
  expect(out.text).toBe('/halt failed (exit 1): halt failed: read-only')
})
