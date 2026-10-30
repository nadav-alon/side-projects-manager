import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const CWD = '/work/repo'
const ADR = `${CWD}/docs/adr/0007-new.md`

/** Stands for the engine beneath the mod: which paths exist, what the check answers, and that a write succeeds. */
function engine(on: On, world: { existing: string[]; check: { exitCode: number; stderr: string } }): { ran: string[][] } {
  const seen = { ran: [] as string[][] }
  on('session.cwd', () => ({ value: CWD }) as never)
  on('fs.exists', (_$, e) => ({ value: world.existing.includes((e as unknown as { path: string }).path) }) as never)
  on('process.run', (_$, e) => {
    seen.ran.push((e as unknown as { argv: string[] }).argv)
    return { value: { ...world.check, stdout: '' } } as never
  })
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create' }, isError: false }) as never)
  return seen
}

const REPO = [`${CWD}/scripts/check-adr-numbers.ts`]
const FAILING = { exitCode: 1, stderr: 'ADR 0007 is claimed by 0007-new.md and 0007-old.md' }
const PASSING = { exitCode: 0, stderr: '' }

test('a new ADR whose number collides surfaces the check failure to the model', async ($, on) => {
  const seen = engine(on, { existing: REPO, check: FAILING })
  const ran = await $.tool.call({ tool: 'Write', file_path: ADR, content: '# x' })
  expect(ran.context?.join('\n')).toMatch(/ADR 0007 is claimed by/)
  expect(seen.ran.length).toBe(1)
})

test('a correctly numbered new ADR produces no message', async ($, on) => {
  engine(on, { existing: REPO, check: PASSING })
  const ran = await $.tool.call({ tool: 'Write', file_path: ADR, content: '# x' })
  expect(ran.context).toBeUndefined()
})

test('rewriting an existing ADR does not run the check', async ($, on) => {
  const seen = engine(on, { existing: [...REPO, ADR], check: FAILING })
  const ran = await $.tool.call({ tool: 'Write', file_path: ADR, content: '# x' })
  expect(ran.context).toBeUndefined()
  expect(seen.ran.length).toBe(0)
})

test('editing an ADR does not run the check', async ($, on) => {
  const seen = engine(on, { existing: [...REPO, ADR], check: FAILING })
  on('tool.call', { tool: 'Edit' }, () => ({ result: {}, isError: false }) as never)
  await $.tool.call({ tool: 'Edit', file_path: ADR, old_string: 'a', new_string: 'b' })
  expect(seen.ran.length).toBe(0)
})

test('a session outside this repo is untouched', async ($, on) => {
  const seen = engine(on, { existing: [], check: FAILING })
  const ran = await $.tool.call({ tool: 'Write', file_path: ADR, content: '# x' })
  expect(ran.context).toBeUndefined()
  expect(seen.ran.length).toBe(0)
})

test('a file outside docs/adr is untouched', async ($, on) => {
  const seen = engine(on, { existing: REPO, check: FAILING })
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/docs/notes/0007-x.md`, content: '# x' })
  expect(seen.ran.length).toBe(0)
})
