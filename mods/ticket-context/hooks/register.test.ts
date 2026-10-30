import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Run = { argv: string[] }

const ISSUE = JSON.stringify({ title: 'Add the thing', body: 'Build it.', labels: [{ name: 'enhancement' }, { name: 'size:M' }] })

/** Stands for the engine beneath the mod: `gh` answers from `answers`, keyed by its argv joined (a ticket with no blockers needs no answer), and the prompt enters. */
function engine(on: On, answers: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>): { runs: string[][] } {
  const seen = { runs: [] as string[][] }
  on('session.cwd', () => ({ value: '/work/repo' }) as never)
  on('process.run', (_$, e) => {
    const { argv } = e as unknown as Run
    seen.runs.push(argv)
    const unblocked = argv[1] === 'api' ? { stdout: '' } : { exitCode: 1, stderr: 'not found' }
    const answer = answers[argv.join(' ')] ?? unblocked
    return { value: { exitCode: 0, stdout: '', stderr: '', ...answer } } as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  return seen
}

const ACME_42 = {
  'gh issue view 42 --repo acme/pilot --json title,body,labels': { stdout: ISSUE },
  'gh api --paginate repos/acme/pilot/issues/42/dependencies/blocked_by --jq .[] | (.repository_url | sub(".*/repos/"; "")) + "#" + (.number | tostring)': {
    stdout: 'acme/pilot#7\n',
  },
}

test('a prompt naming owner/repo#n gets that ticket appended', async ($, on) => {
  engine(on, ACME_42)
  const entered = await $.prompt.submit({ text: 'Look at acme/pilot#42 please' })
  expect(entered.text).toBe('Look at acme/pilot#42 please')
  const context = entered.context?.join('\n') ?? ''
  expect(context).toMatch(/acme\/pilot#42: Add the thing/)
  expect(context).toMatch(/Labels: enhancement, size:M/)
  expect(context).toMatch(/Blocked by: acme\/pilot#7/)
  expect(context).toMatch(/Build it\./)
})

test('a prompt without a reference is untouched and asks the tracker nothing', async ($, on) => {
  const seen = engine(on, ACME_42)
  const entered = await $.prompt.submit({ text: 'Fix the build in src/a#b and issue 42' })
  expect(entered.context).toBeUndefined()
  expect(seen.runs.length).toBe(0)
})

test('a bare #n resolves against the session repo', async ($, on) => {
  const seen = engine(on, { 'gh repo view --json nameWithOwner --jq .nameWithOwner': { stdout: 'acme/pilot\n' }, ...ACME_42 })
  const entered = await $.prompt.submit({ text: 'Do #42 next' })
  expect(entered.context?.join('\n')).toMatch(/acme\/pilot#42: Add the thing/)
  expect(seen.runs.filter(argv => argv[1] === 'repo').length).toBe(1)
})

test('several references each get their context, up to a cap', async ($, on) => {
  const answers: Parameters<typeof engine>[1] = {}
  for (let n = 1; n <= 7; n++) {
    answers[`gh issue view ${n} --repo acme/pilot --json title,body,labels`] = {
      stdout: JSON.stringify({ title: `Ticket ${n}`, body: '', labels: [] }),
    }
  }
  engine(on, answers)
  const entered = await $.prompt.submit({ text: 'acme/pilot#1 acme/pilot#2 acme/pilot#3 acme/pilot#4 acme/pilot#5 acme/pilot#6 acme/pilot#7' })
  const context = entered.context?.join('\n') ?? ''
  for (const n of [1, 2, 3, 4, 5]) expect(context).toMatch(new RegExp(`acme/pilot#${n}: Ticket ${n}`))
  expect(context).not.toMatch(/Ticket 6/)
  expect(context).toMatch(/7 tickets named, the first 5 fetched/)
})

test('a reference that cannot be fetched leaves the prompt as typed, with a one-line note', async ($, on) => {
  const toasts: string[] = []
  engine(on, { ...ACME_42, 'gh issue view 9 --repo acme/pilot --json title,body,labels': { exitCode: 1, stderr: 'no such issue\nsecond line' } })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return {} as never
  })
  const entered = await $.prompt.submit({ text: 'acme/pilot#9 and acme/pilot#42' })
  expect(entered.text).toBe('acme/pilot#9 and acme/pilot#42')
  const context = entered.context ?? []
  expect(context.filter(block => block.includes('could not fetch acme/pilot#9: no such issue'))).toHaveLength(1)
  expect(context.join('\n')).not.toMatch(/second line/)
  expect(context.join('\n')).toMatch(/acme\/pilot#42: Add the thing/)
  expect(toasts.length).toBe(1)
})
